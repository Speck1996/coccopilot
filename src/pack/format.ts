/**
 * The line-oriented text format shared by a repository pack and the change sets Copilot
 * writes back. Every directive is a line that starts with `@@@ ` at column 0:
 *
 *   @@@ FILE <path> [<n> lines]      full file content follows, up to `@@@ END`
 *   @@@ EDIT <path>                  SEARCH/REPLACE pairs follow, up to `@@@ END`
 *   @@@ DELETE <path>
 *   @@@ RENAME <from> -> <to>
 *   @@@ END [<path>]
 *
 * Plain text, so Copilot reads the code as code (no base64), and one marker per file,
 * so it costs a few tokens per file. In a pack the `[<n> lines]` count makes decoding
 * exact even if a file happens to contain a marker line; in Copilot's replies the
 * count is optional and the parser falls back to the `@@@ END` line. Anything outside a
 * block (prose, markdown fences, the pack's tree) is ignored, and directives inside an
 * instructions region are skipped so the format's own examples are never applied.
 */

export const MARKER = "@@@";
export const INSTRUCTIONS_OPEN = "<!-- coccopilot:instructions -->";
export const INSTRUCTIONS_CLOSE = "<!-- /coccopilot:instructions -->";

export interface SearchReplace {
  search: string[];
  replace: string[];
}

export type ChangeOp =
  | { kind: "file"; path: string; content: string; line: number }
  | { kind: "edit"; path: string; blocks: SearchReplace[]; line: number }
  | { kind: "delete"; path: string; line: number }
  | { kind: "rename"; from: string; to: string; line: number };

export interface ParsedChanges {
  ops: ChangeOp[];
  /** Problems that make part of the input unusable (reported, never guessed around). */
  errors: string[];
  /** Tolerated deviations, e.g. a missing `@@@ END`. */
  warnings: string[];
}

const DIRECTIVE = /^@@@[ \t]+(FILE|EDIT|DELETE|RENAME|MOVE|END)\b:?[ \t]*(.*?)[ \t]*$/i;
const LINE_COUNT = /[ \t]*\[(\d+) lines?(, no newline at end)?\][ \t]*$/;
const SEARCH_OPEN = /^<{5,9}[ \t]*SEARCH[ \t]*$/;
const SEARCH_SPLIT = /^={5,9}[ \t]*$/;
const SEARCH_CLOSE = /^>{5,9}[ \t]*REPLACE[ \t]*$/;
const FENCE = /^(`{3,}|~{3,})[\w.+-]*[ \t]*$/;

/** Encode one file as a FILE block with an exact line count. */
export function encodeFile(path: string, content: string): string {
  const noEol = content.length > 0 && !content.endsWith("\n");
  const body = content.endsWith("\n") ? content.slice(0, -1) : content;
  const count = content.length === 0 ? 0 : body.split("\n").length;
  const note = `${count} line${count === 1 ? "" : "s"}${noEol ? ", no newline at end" : ""}`;
  const lines = [`${MARKER} FILE ${path} [${note}]`];
  if (count > 0) lines.push(body);
  lines.push(`${MARKER} END ${path}`);
  return lines.join("\n");
}

/** Strip decorations Copilot tends to add around a path: quotes, backticks, `./`. */
export function cleanPath(raw: string): string {
  return raw
    .trim()
    .replace(/^[`'"]+|[`'"]+$/g, "")
    .replace(/\\/g, "/")
    .replace(/^(\.\/)+/, "");
}

function isMarkdownPath(path: string): boolean {
  return /\.(md|markdown|mdx)$/i.test(path);
}

/** Parse a pack or a Copilot change set into operations. Never throws. */
export function parseChanges(input: string): ParsedChanges {
  const lines = input.replace(/\r\n?/g, "\n").split("\n");
  const ops: ChangeOp[] = [];
  const errors: string[] = [];
  const warnings: string[] = [];
  let i = 0;

  /** Collect body lines up to `@@@ END` (consumed) or the next directive (not consumed). */
  const readBody = (header: number): { body: string[]; terminated: boolean } => {
    const body: string[] = [];
    while (i < lines.length) {
      const m = DIRECTIVE.exec(lines[i]);
      if (m) {
        if (m[1].toUpperCase() === "END") {
          i++;
          return { body, terminated: true };
        }
        warnings.push(`line ${header}: block has no "@@@ END"; it ends at the next directive`);
        return { body, terminated: false };
      }
      body.push(lines[i++]);
    }
    warnings.push(`line ${header}: block has no "@@@ END"; it runs to the end of the input`);
    // The closing fence of the reply is not part of the file.
    while (body.length && (FENCE.test(body[body.length - 1]) || body[body.length - 1].trim() === "")) body.pop();
    return { body, terminated: false };
  };

  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === INSTRUCTIONS_OPEN) {
      while (i < lines.length && lines[i].trim() !== INSTRUCTIONS_CLOSE) i++;
      i++;
      continue;
    }
    const m = DIRECTIVE.exec(line);
    i++;
    if (!m) continue;
    const header = i;
    const kind = m[1].toUpperCase();
    const rest = m[2];

    if (kind === "END") continue; // stray END outside a block (e.g. "@@@ END OF PACK")

    if (kind === "DELETE") {
      const path = cleanPath(rest);
      if (path) ops.push({ kind: "delete", path, line: header });
      else errors.push(`line ${header}: DELETE without a path`);
      continue;
    }

    if (kind === "RENAME" || kind === "MOVE") {
      const parts = rest.split(/\s+(?:->|→|=>)\s+/);
      if (parts.length !== 2 || !cleanPath(parts[0]) || !cleanPath(parts[1])) {
        errors.push(`line ${header}: RENAME must look like "@@@ RENAME old/path -> new/path"`);
        continue;
      }
      ops.push({ kind: "rename", from: cleanPath(parts[0]), to: cleanPath(parts[1]), line: header });
      continue;
    }

    if (kind === "FILE") {
      const count = LINE_COUNT.exec(rest);
      const path = cleanPath(count ? rest.slice(0, count.index) : rest);
      if (!path) {
        errors.push(`line ${header}: FILE without a path`);
        readBody(header);
        continue;
      }
      // Exact decode when the count is present and lands on an END line.
      if (count) {
        const n = Number(count[1]);
        const end = lines[i + n];
        if (end !== undefined && DIRECTIVE.exec(end)?.[1].toUpperCase() === "END") {
          const body = lines.slice(i, i + n);
          i += n + 1;
          const content = n === 0 ? "" : body.join("\n") + (count[2] ? "" : "\n");
          ops.push({ kind: "file", path, content, line: header });
          continue;
        }
      }
      let { body } = readBody(header);
      // Copilot sometimes fences the content inside the block; a non-markdown file
      // never legitimately starts and ends with a fence line.
      if (!isMarkdownPath(path) && body.length >= 2 && FENCE.test(body[0]) && FENCE.test(body[body.length - 1])) {
        body = body.slice(1, -1);
      }
      ops.push({ kind: "file", path, content: body.length ? body.join("\n") + "\n" : "", line: header });
      continue;
    }

    // EDIT
    const path = cleanPath(rest);
    const { body } = readBody(header);
    if (!path) {
      errors.push(`line ${header}: EDIT without a path`);
      continue;
    }
    const blocks: SearchReplace[] = [];
    let state: "out" | "search" | "replace" = "out";
    let current: SearchReplace = { search: [], replace: [] };
    for (const b of body) {
      if (state === "out") {
        if (SEARCH_OPEN.test(b)) {
          current = { search: [], replace: [] };
          state = "search";
        }
      } else if (state === "search") {
        if (SEARCH_SPLIT.test(b)) state = "replace";
        else current.search.push(b);
      } else if (SEARCH_CLOSE.test(b)) {
        blocks.push(current);
        state = "out";
      } else {
        current.replace.push(b);
      }
    }
    if (state !== "out") {
      errors.push(`EDIT ${path} (line ${header}): a SEARCH/REPLACE pair is not closed with ">>>>>>> REPLACE"`);
      continue;
    }
    if (blocks.length === 0) {
      errors.push(`EDIT ${path} (line ${header}): no "<<<<<<< SEARCH" / "=======" / ">>>>>>> REPLACE" pairs found`);
      continue;
    }
    ops.push({ kind: "edit", path, blocks, line: header });
  }

  return { ops, errors, warnings };
}
