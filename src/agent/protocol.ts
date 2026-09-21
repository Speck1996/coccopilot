import type { ToolCall } from "../tools/types.js";
import { agentVocabulary, type Vocabulary } from "./vocabulary.js";

export interface ParsedAssistant {
  /** Assistant prose with the tool block removed. */
  text: string;
  /** Tool calls found in the message, in order. Usually 0 or 1, but batching allows more. */
  calls: ToolCall[];
  /** Set when the model signalled it is finished. */
  done: boolean;
  /** Set when a tool block was present but could not be parsed. */
  parseError?: string;
  /** The raw fenced block(s), for diagnostics. */
  raw?: string;
}

/**
 * Recognizes a fenced block. Tolerant on purpose: the language tag may contain
 * letters, digits, `.`, `_`, `+`, or `-` (e.g. `coccopilot-json`), may be preceded
 * by spaces, and the body may begin on the same line as the tag. Copilot clients
 * vary in how they emit the fence, and a near-miss here silently degrades to prose.
 */
const FENCE_RE = /```[ \t]*([a-z0-9_.+-]*)[ \t]*\r?\n?([\s\S]*?)```/gi;

/**
 * Copilot is asked to emit one or more fenced blocks like:
 *
 *   ```coccopilot
 *   { "tool": "read_file", "args": { "path": "src/index.ts" } }
 *   ```
 *
 * Batching is also accepted as a single block containing an array or a `tools` array:
 *
 *   ```coccopilot
 *   { "tools": [ { "tool": "..." }, { "tool": "..." } ] }
 *   ```
 *
 * We scan every fenced block, try to parse the body as JSON, and collect tool calls.
 * Everything else is left as prose.
 *
 * Some Copilot clients strip the fence (e.g. the code block's "Copy" button copies
 * the body alone), so when no fenced call is found we also accept a bare JSON object
 * whose call key is present. The bare pass is deliberately narrow: an object that
 * merely contains `{`/`}` in prose must not be mistaken for a tool call.
 */
export function parseAssistant(raw: string, vocabulary: Vocabulary = agentVocabulary): ParsedAssistant {
  const text = raw ?? "";
  const calls: ToolCall[] = [];
  let parseError: string | undefined;
  let rawBlock: string | undefined;
  let done = false;

  FENCE_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = FENCE_RE.exec(text)) !== null) {
    const lang = (match[1] ?? "").toLowerCase();
    const body = match[2].trim();
    if (!body) continue;

    const parsed = tryParseJson(body);
    if (parsed === undefined) {
      // A coccopilot/json block that won't parse is a protocol error worth reporting.
      const key = escapeForRegex(vocabulary.callKey);
      if (lang === "coccopilot" || new RegExp(`"(tool|name|tool_name|${key})"\\s*:`).test(body)) {
        parseError = `could not parse JSON in fenced block: ${body.slice(0, 200)}`;
        rawBlock = body;
      }
      continue;
    }

    const extracted = extractCalls(parsed, vocabulary);
    if (extracted.length > 0) {
      calls.push(...extracted);
      rawBlock = body;
    }
  }

  let prose = stripFences(text);

  // Fall back to an unfenced call object. Only run when the fenced pass found nothing,
  // so a normal reply can never be reinterpreted by this looser path.
  if (calls.length === 0) {
    const bare = scanBareCalls(text, vocabulary);
    if (bare) {
      if (bare.calls.length > 0) {
        calls.push(...bare.calls);
        rawBlock = bare.raw;
        prose = stripFences(stripSpans(text, bare.spans));
      } else if (bare.error) {
        parseError = bare.error;
        rawBlock = bare.raw;
      }
    }
  }

  if (calls.some((c) => c.tool === "done")) {
    done = true;
  }

  // Also treat a bare textual sentinel as completion, in case the model skips the block.
  if (!done && /\bTASK_COMPLETE\b/i.test(text)) {
    done = true;
  }

  return { text: prose, calls, done, parseError, raw: rawBlock };
}

/** A bare (unfenced) call object found in prose. */
interface BareScan {
  calls: ToolCall[];
  /** Character spans of the call objects, for removal from the prose. */
  spans: Array<[number, number]>;
  /** The first call object, for diagnostics. */
  raw?: string;
  /** Set when an object looked like a call but its JSON would not parse. */
  error?: string;
}

/**
 * Look for a tool call emitted without a fence: a brace-balanced JSON object that
 * carries the vocabulary's call key (or the legacy `tool`/`tool_name` keys). We only
 * treat the object as a call when it actually resolves to one, so incidental braces
 * in prose are ignored. An object that names a routine but is not valid JSON is
 * reported as a parse error rather than silently becoming prose.
 */
function scanBareCalls(text: string, vocabulary: Vocabulary): BareScan | undefined {
  const key = escapeForRegex(vocabulary.callKey);
  // Object-key shaped: quoted or unquoted, at the start of the object or after a comma.
  const gate = new RegExp(`(?:^|[{,\\s])["']?(?:tool|tool_name|name|${key})["']?\\s*:`);
  const calls: ToolCall[] = [];
  const spans: Array<[number, number]> = [];
  let raw: string | undefined;
  let error: string | undefined;

  for (const [start, end] of objectSpans(text)) {
    const body = text.slice(start, end);
    // Require the call key to appear, so an unrelated JSON object in prose is ignored.
    if (!gate.test(body)) continue;
    const parsed = tryParseJson(body);
    if (parsed === undefined) {
      if (!error) {
        error = `could not parse JSON in bare object: ${body.slice(0, 200)}`;
        raw = body;
      }
      continue;
    }
    const extracted = extractCalls(parsed, vocabulary);
    if (extracted.length > 0) {
      calls.push(...extracted);
      spans.push([start, end]);
      raw = raw ?? body;
    }
  }

  if (calls.length === 0 && !error) return undefined;
  return { calls, spans, raw, error: calls.length > 0 ? undefined : error };
}

/** Spans of the outermost brace-balanced `{...}` runs, skipping braces inside strings. */
function objectSpans(text: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}" && depth > 0) {
      depth--;
      if (depth === 0 && start >= 0) {
        spans.push([start, i + 1]);
        start = -1;
      }
    }
  }
  return spans;
}

/** Remove the given non-overlapping, ascending spans from `text`. */
function stripSpans(text: string, spans: Array<[number, number]>): string {
  if (spans.length === 0) return text;
  let out = "";
  let cursor = 0;
  for (const [start, end] of spans) {
    if (start < cursor) continue;
    out += text.slice(cursor, start);
    cursor = end;
  }
  return out + text.slice(cursor);
}

function stripFences(text: string): string {
  FENCE_RE.lastIndex = 0;
  return text.replace(FENCE_RE, "").trim();
}

function tryParseJson(body: string): unknown | undefined {
  try {
    return JSON.parse(body);
  } catch {
    // Try to salvage the first {...} object.
    const start = body.indexOf("{");
    const end = body.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(body.slice(start, end + 1));
      } catch {
        return undefined;
      }
    }
    return undefined;
  }
}

/** Accept a single call object, an array of calls, or `{ tools: [...] }`. */
function extractCalls(value: unknown, vocabulary: Vocabulary): ToolCall[] {
  if (Array.isArray(value)) {
    return value.map((v) => normalizeCall(v, vocabulary)).filter((c): c is ToolCall => c !== undefined);
  }
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if (Array.isArray(obj.tools)) {
      return obj.tools.map((v) => normalizeCall(v, vocabulary)).filter((c): c is ToolCall => c !== undefined);
    }
  }
  const single = normalizeCall(value, vocabulary);
  return single ? [single] : [];
}

/**
 * Accept a few shapes the model might produce:
 *   { "tool": "x", "args": {...} }        (agent)
 *   { "step": "survey", "args": {...} }   (notation)
 *   { "name": "x", "arguments": {...} }   (tolerant)
 *   { "tool": "x", "path": "...", ... }   (args inline)
 *
 * The routine name is read from the active vocabulary's key first, then from the
 * legacy keys, and mapped back to the internal tool name. Argument names are mapped
 * from the vocabulary back to internal names (identity for the agent persona).
 */
function normalizeCall(value: unknown, vocabulary: Vocabulary): ToolCall | undefined {
  if (!value || typeof value !== "object") return undefined;
  const obj = value as Record<string, unknown>;

  const rawName = obj[vocabulary.callKey] ?? obj.tool ?? obj.name ?? obj.tool_name;
  if (typeof rawName !== "string" || rawName.length === 0) return undefined;
  const internal = vocabulary.internalFor(rawName);

  let args: Record<string, unknown> = {};
  const argsCandidate = obj[vocabulary.argsKey] ?? obj.args ?? obj.arguments ?? obj.parameters ?? obj.input;
  if (argsCandidate && typeof argsCandidate === "object" && !Array.isArray(argsCandidate)) {
    args = argsCandidate as Record<string, unknown>;
  } else {
    // Inline args: everything except the reserved keys.
    const reserved = new Set([
      vocabulary.callKey,
      vocabulary.argsKey,
      "tool",
      "name",
      "tool_name",
      "args",
      "arguments",
      "parameters",
      "input",
      "done",
      "summary",
    ]);
    for (const [k, v] of Object.entries(obj)) {
      if (!reserved.has(k)) args[k] = v;
    }
  }

  args = mapArgsToInternal(internal, args, vocabulary);
  return { tool: internal, args };
}

/** Map model-facing argument names back to internal ones for a routine. */
function mapArgsToInternal(
  internal: string,
  args: Record<string, unknown>,
  vocabulary: Vocabulary,
): Record<string, unknown> {
  const mapped: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    const internalKey = vocabulary.argToInternal(internal, key) ?? key;
    mapped[internalKey] = value;
  }
  return mapped;
}

function escapeForRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
