import type { ToolCall } from "../tools/types.js";

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

/** A fenced block found in a reply. */
interface Fence {
  lang: string;
  body: string;
  start: number;
  end: number;
}

/**
 * Opening fence: three or more backticks or tildes, then an optional language tag.
 * Tolerant on purpose: the tag may contain letters, digits, `.`, `_`, `+`, or `-`
 * (e.g. `coccopilot-json`), and the body may begin on the same line as the tag.
 * Copilot clients vary in how they emit the fence, and a near-miss here silently
 * degrades to prose.
 */
const OPEN_FENCE_RE = /(`{3,}|~{3,})[ \t]*([a-z0-9_.+-]*)/gi;

/**
 * Find every fenced block. A fence closes at the first run of at least as many of the
 * same character. When the body is JSON, runs inside JSON strings are skipped: a
 * `write_file` of a Markdown file carries its own ``` lines inside `content`, and a
 * naive scan would cut the call in half there.
 */
function scanFences(text: string): Fence[] {
  const fences: Fence[] = [];
  OPEN_FENCE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = OPEN_FENCE_RE.exec(text)) !== null) {
    const marker = m[1];
    const lang = (m[2] ?? "").toLowerCase();
    let bodyStart = m.index + m[0].length;
    bodyStart += /^[ \t]*\r?\n?/.exec(text.slice(bodyStart))![0].length;
    const close = findClose(text, bodyStart, marker[0], marker.length);
    const end = close ? close.end : text.length;
    fences.push({ lang, body: text.slice(bodyStart, close ? close.start : text.length), start: m.index, end });
    OPEN_FENCE_RE.lastIndex = end;
  }
  return fences;
}

/** Where a fence opened with `len` × `ch` closes, or undefined when it never does. */
function findClose(text: string, from: number, ch: string, len: number): { start: number; end: number } | undefined {
  const runAt = (i: number): number => {
    let n = 0;
    while (text[i + n] === ch) n++;
    return n;
  };
  const json = /^\s*[[{]/.test(text.slice(from, from + 64));
  if (json) {
    let inString = false;
    let escaped = false;
    for (let i = from; i < text.length; i++) {
      const c = text[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (c === "\\") escaped = true;
        else if (c === '"') inString = false;
        continue;
      }
      if (c === '"') inString = true;
      else if (c === ch) {
        const n = runAt(i);
        if (n >= len) return { start: i, end: i + n };
        i += n - 1;
      }
    }
    // Unbalanced quotes: fall through to the plain scan.
  }
  for (let i = from; i < text.length; i++) {
    if (text[i] !== ch) continue;
    const n = runAt(i);
    if (n >= len) return { start: i, end: i + n };
    i += n - 1;
  }
  return undefined;
}

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
export function parseAssistant(raw: string): ParsedAssistant {
  const text = raw ?? "";
  const calls: ToolCall[] = [];
  let parseError: string | undefined;
  let rawBlock: string | undefined;
  let done = false;

  for (const fence of scanFences(text)) {
    const lang = fence.lang;
    const body = fence.body.trim();
    if (!body) continue;
    const strict = lang !== "coccopilot";

    const values = tryParseJsonValues(body);
    if (values.length === 0) {
      // A coccopilot block (or one that names a `tool`) that won't parse is a protocol
      // error worth reporting. A broken ```json snippet with a "name" key (a partial
      // package.json, say) is just an illustration and stays prose.
      if (!strict || /"(tool|tool_name)"\s*:/.test(body)) {
        parseError = `could not parse JSON in fenced block: ${body.slice(0, 200)}`;
        rawBlock = body;
      }
      continue;
    }

    const extracted = values.flatMap((v) => extractCalls(v, strict));
    if (extracted.length > 0) {
      calls.push(...extracted);
      rawBlock = body;
    }
  }

  let prose = stripFences(text);

  // Fall back to an unfenced call object. Only run when the fenced pass found nothing,
  // so a normal reply can never be reinterpreted by this looser path.
  // Fenced bodies were already tried above, so only the prose outside them is scanned.
  if (calls.length === 0) {
    const bare = scanBareCalls(prose);
    if (bare) {
      if (bare.calls.length > 0) {
        calls.push(...bare.calls);
        rawBlock = bare.raw;
        prose = stripSpans(prose, bare.spans).trim();
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
 * carries a call key (`tool`, `tool_name` or `name`). We only
 * treat the object as a call when it actually resolves to one, so incidental braces
 * in prose are ignored. An object that names a routine but is not valid JSON is
 * reported as a parse error rather than silently becoming prose.
 */
function scanBareCalls(text: string): BareScan | undefined {
  // Object-key shaped: quoted or unquoted, at the start of the object or after a comma.
  const gate = /(?:^|[{,\s])["']?(?:tool|tool_name|name)["']?\s*:/;
  // Only an object that names a `tool` is worth a parse error; `{ name: ... }` in prose
  // is far more often an illustration than a broken call.
  const errorGate = /(?:^|[{,\s])["']?(?:tool|tool_name)["']?\s*:/;
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
      if (!error && errorGate.test(body)) {
        error = `could not parse JSON in bare object: ${body.slice(0, 200)}`;
        raw = body;
      }
      continue;
    }
    const extracted = extractCalls(parsed, true);
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
  return stripSpans(text, scanFences(text).map((f): [number, number] => [f.start, f.end])).trim();
}

function parseOrUndefined(body: string): unknown | undefined {
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

/**
 * Fix the two slips models make most often in hand-written JSON: raw newlines/tabs
 * inside a string (typical in a long `write_file` content) and trailing commas.
 * Only used after strict parsing failed, so valid JSON is never rewritten.
 */
export function repairJson(body: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      else if (ch === "\n") { out += "\\n"; continue; }
      else if (ch === "\r") { out += "\\r"; continue; }
      else if (ch === "\t") { out += "\\t"; continue; }
      out += ch;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === ",") {
      const next = /^\s*([}\]])/.exec(body.slice(i + 1));
      if (next) continue;
    }
    out += ch;
  }
  return out;
}

function tryParseJson(body: string): unknown | undefined {
  const direct = parseOrUndefined(body) ?? parseOrUndefined(repairJson(body));
  if (direct !== undefined) return direct;
  // Try to salvage the first {...} object.
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start >= 0 && end > start) {
    const slice = body.slice(start, end + 1);
    return parseOrUndefined(slice) ?? parseOrUndefined(repairJson(slice));
  }
  return undefined;
}

/**
 * Parse the body of a fenced block into zero or more JSON values. A single well-formed
 * value (object or array) is preferred; otherwise we accept several values emitted in
 * one block — concatenated objects/arrays (`{…}\n{…}`) or comma-separated ones — which
 * some Copilot clients produce when batching multiple tool calls under one fence. The
 * scanner walks brace/bracket-balanced spans so a `}` inside a string never splits a
 * value early.
 */
function tryParseJsonValues(body: string): unknown[] {
  const whole = tryParseJson(body);
  if (whole !== undefined) return [whole];

  const values: unknown[] = [];
  for (const span of jsonValueSpans(body)) {
    const parsed = tryParseJson(span);
    if (parsed !== undefined) values.push(parsed);
  }
  return values;
}

/** Spans of top-level brace/bracket-balanced JSON values in `text`, skipping strings. */
function jsonValueSpans(text: string): string[] {
  const spans: string[] = [];
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
    } else if (ch === "{" || ch === "[") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}" || ch === "]") {
      if (depth > 0) {
        depth--;
        if (depth === 0 && start >= 0) {
          spans.push(text.slice(start, i + 1));
          start = -1;
        }
      }
    }
  }
  return spans;
}

/**
 * Accept a single call object, an array of calls, or `{ tools: [...] }`. `strict` is set
 * outside a `coccopilot` fence, where JSON is often just an illustration.
 */
function extractCalls(value: unknown, strict = false): ToolCall[] {
  const one = (v: unknown) => normalizeCall(v, strict);
  if (Array.isArray(value)) {
    return value.map(one).filter((c): c is ToolCall => c !== undefined);
  }
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if (Array.isArray(obj.tools)) {
      return obj.tools.map(one).filter((c): c is ToolCall => c !== undefined);
    }
  }
  const single = one(value);
  return single ? [single] : [];
}

/**
 * Accept a few shapes the model might produce:
 *   { "tool": "x", "args": {...} }
 *   { "name": "x", "arguments": {...} }   (tolerant)
 *   { "tool": "x", "path": "...", ... }   (args inline)
 */
function normalizeCall(value: unknown, strict = false): ToolCall | undefined {
  if (!value || typeof value !== "object") return undefined;
  const obj = value as Record<string, unknown>;

  const name = obj.tool ?? obj.name ?? obj.tool_name;
  if (typeof name !== "string" || name.length === 0) return undefined;

  const argsCandidate = obj.args ?? obj.arguments ?? obj.parameters ?? obj.input;
  // Outside a coccopilot fence, `{ "name": "my-app", "version": "1.0.0" }` is a
  // package.json, not a call: `name` only counts when an arguments object comes with it.
  if (strict && obj.tool === undefined && obj.tool_name === undefined && argsCandidate === undefined) {
    return undefined;
  }

  let args: Record<string, unknown> = {};
  if (argsCandidate && typeof argsCandidate === "object" && !Array.isArray(argsCandidate)) {
    args = argsCandidate as Record<string, unknown>;
  } else {
    // Inline args: everything except the reserved keys.
    const reserved = new Set(["tool", "name", "tool_name", "args", "arguments", "parameters", "input", "done", "summary"]);
    for (const [k, v] of Object.entries(obj)) {
      if (!reserved.has(k)) args[k] = v;
    }
  }

  return { tool: name, args };
}
