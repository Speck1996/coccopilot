import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Workspace } from "../sandbox/workspace.js";
import type { ChangeOp, SearchReplace } from "./format.js";

export interface FileChange {
  path: string;
  /** Content before (null: the file did not exist). */
  before: string | null;
  /** Content after (null: the file is deleted). */
  after: string | null;
  /** Set when this change is the new side of a RENAME. */
  renamedFrom?: string;
}

export interface Plan {
  changes: FileChange[];
  /** Operations that could not be applied, with enough context for Copilot to fix them. */
  failures: string[];
  /** Operations that turned out to be no-ops (e.g. a FILE identical to what is on disk). */
  notes: string[];
}

interface VirtualFile {
  /** LF-normalized content, null when absent. */
  content: string | null;
  original: string | null;
  crlf: boolean;
}

function toLines(content: string): string[] {
  if (content === "") return [];
  return (content.endsWith("\n") ? content.slice(0, -1) : content).split("\n");
}

function fromLines(lines: string[], trailingNewline: boolean): string {
  if (lines.length === 0) return "";
  return lines.join("\n") + (trailingNewline ? "\n" : "");
}

function leadingWhitespace(s: string): string {
  return /^[ \t]*/.exec(s)![0];
}

/** Where a SEARCH landed: `length` file lines from `index` (not always the SEARCH length). */
type Match = { index: number; length: number; reindent?: { from: string; to: string } };

/**
 * Find the single place `search` occurs in `lines`. Tries an exact match first, then
 * ignores trailing whitespace, then ignores indentation (re-indenting the replacement
 * to the file's indentation), then also ignores blank lines, which models often drop
 * when quoting. The first tier that matches decides; more than one match there is
 * ambiguous and fails rather than guessing.
 */
function locate(lines: string[], search: string[]): Match | { error: string } {
  const tiers: Array<(a: string, b: string) => boolean> = [
    (a, b) => a === b,
    (a, b) => a.trimEnd() === b.trimEnd(),
    (a, b) => a.trim() === b.trim(),
  ];
  for (let t = 0; t < tiers.length; t++) {
    const eq = tiers[t];
    const hits: number[] = [];
    for (let i = 0; i + search.length <= lines.length; i++) {
      let ok = true;
      for (let j = 0; j < search.length && ok; j++) ok = eq(lines[i + j], search[j]);
      if (ok) hits.push(i);
    }
    if (hits.length > 1) {
      return { error: `the SEARCH text matches ${hits.length} places (lines ${hits.map((h) => h + 1).join(", ")}); add surrounding lines to make it unique` };
    }
    if (hits.length === 1) {
      if (t < 2) return { index: hits[0], length: search.length };
      const first = search.findIndex((s) => s.trim() !== "");
      return {
        index: hits[0],
        length: search.length,
        reindent: { from: leadingWhitespace(search[first]), to: leadingWhitespace(lines[hits[0] + first]) },
      };
    }
  }

  // Last tier: compare only the non-blank lines, then map the hit back to a file span.
  const wanted = search.filter((s) => s.trim() !== "");
  const kept = lines.flatMap((l, i) => (l.trim() === "" ? [] : [i]));
  const hits: number[] = [];
  for (let k = 0; k + wanted.length <= kept.length; k++) {
    let ok = true;
    for (let j = 0; j < wanted.length && ok; j++) ok = lines[kept[k + j]].trim() === wanted[j].trim();
    if (ok) hits.push(k);
  }
  if (hits.length > 1) {
    return { error: `the SEARCH text matches ${hits.length} places (lines ${hits.map((h) => kept[h] + 1).join(", ")}); add surrounding lines to make it unique` };
  }
  if (hits.length === 1) {
    const start = kept[hits[0]];
    return {
      index: start,
      length: kept[hits[0] + wanted.length - 1] - start + 1,
      reindent: { from: leadingWhitespace(wanted[0]), to: leadingWhitespace(lines[start]) },
    };
  }
  return { error: "the SEARCH text was not found" };
}

/** Show Copilot the real text near where its SEARCH probably meant to land. */
function nearby(lines: string[], search: string[]): string {
  // The file line sharing the longest prefix with any SEARCH line, if it is a close one.
  let best = { score: 0, line: -1, offset: 0 };
  search.forEach((raw, offset) => {
    const s = raw.trim();
    if (s.length <= 3) return;
    lines.forEach((l, line) => {
      const t = l.trim();
      let n = 0;
      while (n < s.length && n < t.length && s[n] === t[n]) n++;
      const score = n / s.length;
      if (score >= 0.6 && score > best.score) best = { score, line, offset };
    });
  });
  if (best.line < 0) return "";
  const idx = Math.max(0, best.line - best.offset);
  const from = Math.max(0, idx - 3);
  const to = Math.min(lines.length, idx + search.length + 3);
  return `\n  The file currently has, at lines ${from + 1}-${to}:\n` + lines.slice(from, to).map((l) => `    ${l}`).join("\n");
}

function applyBlocks(path: string, content: string | null, blocks: SearchReplace[]): { content: string } | { error: string } {
  const trailing = content === null || content === "" || content.endsWith("\n");
  let lines = content === null ? [] : toLines(content);
  for (let b = 0; b < blocks.length; b++) {
    const { search, replace } = blocks[b];
    const label = blocks.length > 1 ? `EDIT ${path}, block ${b + 1}/${blocks.length}` : `EDIT ${path}`;
    if (search.every((s) => s.trim() === "")) {
      lines = [...lines, ...replace]; // empty SEARCH: create the file or append to it
      continue;
    }
    if (content === null) return { error: `${label}: the file does not exist (use "@@@ FILE" to create it)` };
    const found = locate(lines, search);
    if ("error" in found) {
      return { error: `${label}: ${found.error}.${found.error.endsWith("not found") ? nearby(lines, search) : ""}` };
    }
    let replacement = replace;
    const re = found.reindent;
    if (re && re.from !== re.to) {
      replacement = replace.map((l) => (l.startsWith(re.from) ? re.to + l.slice(re.from.length) : l));
    }
    lines = [...lines.slice(0, found.index), ...replacement, ...lines.slice(found.index + found.length)];
  }
  return { content: fromLines(lines, trailing) };
}

/**
 * Work out what the change set does without touching the disk. Operations apply in
 * order to an in-memory view, so several EDITs of one file, or an EDIT after a RENAME,
 * compose as Copilot intended.
 */
export async function planChanges(workspace: Workspace, ops: ChangeOp[]): Promise<Plan> {
  const files = new Map<string, VirtualFile>();
  const failed = new Set<string>();
  const renames = new Map<string, string>();
  const failures: string[] = [];
  const notes: string[] = [];

  const key = (raw: string): string => {
    const abs = workspace.resolveInside(raw);
    const rel = workspace.relativeToRoot(abs).split("\\").join("/");
    if (rel === "." || rel.split("/").includes(".git")) throw new Error(`refusing to write ${raw}`);
    return rel;
  };
  const load = async (rel: string): Promise<VirtualFile> => {
    let file = files.get(rel);
    if (!file) {
      const raw = await readFile(workspace.resolveInside(rel), "utf8").catch(() => null);
      const crlf = raw !== null && raw.includes("\r\n");
      const content = raw === null ? null : raw.replace(/\r\n/g, "\n");
      file = { content, original: raw, crlf };
      files.set(rel, file);
    }
    return file;
  };

  for (const op of ops) {
    try {
      if (op.kind === "file") {
        const file = await load(key(op.path));
        file.content = op.content;
      } else if (op.kind === "edit") {
        const file = await load(key(op.path));
        const result = applyBlocks(op.path, file.content, op.blocks);
        if ("error" in result) {
          failures.push(result.error);
          failed.add(key(op.path));
        }
        else file.content = result.content;
      } else if (op.kind === "delete") {
        const file = await load(key(op.path));
        if (file.content === null) notes.push(`DELETE ${op.path}: already absent`);
        file.content = null;
      } else {
        const fromKey = key(op.from);
        const toKey = key(op.to);
        const from = await load(fromKey);
        const to = await load(toKey);
        if (from.content === null) failures.push(`RENAME ${op.from} -> ${op.to}: ${op.from} does not exist`);
        else if (to.content !== null) failures.push(`RENAME ${op.from} -> ${op.to}: ${op.to} already exists`);
        else {
          to.content = from.content;
          to.crlf = from.crlf;
          from.content = null;
          renames.set(toKey, fromKey);
        }
      }
    } catch (err) {
      failures.push(`${op.kind.toUpperCase()} ${"path" in op ? op.path : op.from}: ${(err as Error).message}`);
    }
  }

  const changes: FileChange[] = [];
  for (const [path, file] of files) {
    const after = file.content === null ? null : file.crlf ? file.content.replace(/\n/g, "\r\n") : file.content;
    if (after === file.original) {
      if (file.original !== null && !failed.has(path)) notes.push(`${path}: unchanged`);
      continue;
    }
    changes.push({ path, before: file.original, after, renamedFrom: renames.get(path) });
  }
  changes.sort((a, b) => a.path.localeCompare(b.path));
  return { changes, failures, notes };
}

/** Write a plan to disk. Deletions run last so a rename never loses content. */
export async function writePlan(workspace: Workspace, plan: Plan): Promise<void> {
  for (const change of plan.changes) {
    if (change.after === null) continue;
    const abs = workspace.resolveInside(change.path);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, change.after, "utf8");
  }
  for (const change of plan.changes) {
    if (change.after !== null) continue;
    await unlink(workspace.resolveInside(change.path)).catch((err: NodeJS.ErrnoException) => {
      if (err.code !== "ENOENT") throw err;
    });
  }
}

/** Approximate +added/-removed line counts (common prefix and suffix trimmed). */
export function lineStats(before: string | null, after: string | null): { added: number; removed: number } {
  const a = before === null ? [] : toLines(before.replace(/\r\n/g, "\n"));
  const b = after === null ? [] : toLines(after.replace(/\r\n/g, "\n"));
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let end = 0;
  while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++;
  return { added: b.length - start - end, removed: a.length - start - end };
}

/** One line per change, `git status --short` style, for the terminal. */
export function describePlan(plan: Plan): string[] {
  const renamedAway = new Set(plan.changes.map((c) => c.renamedFrom).filter(Boolean));
  const out: string[] = [];
  for (const c of plan.changes) {
    if (c.after === null && renamedAway.has(c.path)) continue;
    const { added, removed } = lineStats(c.renamedFrom ? null : c.before, c.after);
    if (c.renamedFrom) out.push(`R  ${c.renamedFrom} -> ${c.path}`);
    else if (c.before === null) out.push(`A  ${c.path} (+${added})`);
    else if (c.after === null) out.push(`D  ${c.path} (-${removed})`);
    else out.push(`M  ${c.path} (+${added} -${removed})`);
  }
  return out;
}

/** The message for Copilot when a change set could not be applied. */
export function failureReport(parseErrors: string[], failures: string[], wroteNothing: boolean): string {
  const problems = [...parseErrors, ...failures];
  return [
    `coccopilot could not apply ${problems.length === 1 ? "one part" : `${problems.length} parts`} of your change set${wroteNothing ? ", so nothing was written" : ""}:`,
    "",
    ...problems.map((p) => `- ${p}`),
    "",
    wroteNothing
      ? "Please send the complete change set again with these fixed. Copy SEARCH text exactly from the current file, character for character."
      : "The other changes were applied. Please send only the fixed blocks, written against the files as they are now.",
  ].join("\n");
}
