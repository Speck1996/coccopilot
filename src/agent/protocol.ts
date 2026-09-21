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

const FENCE_RE = /```([a-z]*)[ \t]*\r?\n([\s\S]*?)```/gi;

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

  if (calls.some((c) => c.tool === "done")) {
    done = true;
  }

  // Also treat a bare textual sentinel as completion, in case the model skips the block.
  if (!done && /\bTASK_COMPLETE\b/i.test(text)) {
    done = true;
  }

  return { text: stripFences(text), calls, done, parseError, raw: rawBlock };
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
