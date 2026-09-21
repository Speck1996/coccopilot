import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, relative, isAbsolute, join, sep } from "node:path";
import type { Tool, ToolContext } from "./types.js";

const IGNORED_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", "profiles", ".cache"]);
const MAX_READ_BYTES = 100_000;

function display(ctx: ToolContext, abs: string): string {
  const rel = relative(ctx.workspace.root, abs);
  return rel === "" ? "." : rel;
}

export const writeFileTool: Tool = {
  name: "write_file",
  description: "Create or overwrite a file inside the workspace with the given text content.",
  signature: "write_file(path: string, content: string) — path is relative to the workspace root",
  async run(call, ctx) {
    const rawPath = call.args.path;
    const content = call.args.content;
    if (typeof rawPath !== "string" || rawPath.length === 0) {
      return { ok: false, summary: "write_file: missing 'path' argument" };
    }
    if (typeof content !== "string") {
      return { ok: false, summary: "write_file: missing 'content' argument" };
    }

    let abs: string;
    try {
      abs = ctx.workspace.resolveInside(rawPath);
    } catch (err) {
      return { ok: false, summary: `write_file: ${(err as Error).message}` };
    }

    try {
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, content, "utf8");
    } catch (err) {
      return { ok: false, summary: `write_file: failed to write ${rawPath}: ${(err as Error).message}` };
    }

    return { ok: true, summary: `wrote ${content.length} bytes to ${display(ctx, abs)}` };
  },
};

export const editFileTool: Tool = {
  name: "edit_file",
  description:
    "Replace an exact snippet of text in an existing file. By default old_string must appear " +
    "exactly once; set replace_all to change every occurrence. Use this for surgical edits.",
  signature:
    "edit_file(path: string, old_string: string, new_string: string, replace_all?: boolean)",
  async run(call, ctx) {
    const rawPath = call.args.path;
    const oldString = call.args.old_string;
    const newString = call.args.new_string;
    const replaceAll = call.args.replace_all === true;

    if (typeof rawPath !== "string" || rawPath.length === 0) {
      return { ok: false, summary: "edit_file: missing 'path' argument" };
    }
    if (typeof oldString !== "string" || oldString.length === 0) {
      return { ok: false, summary: "edit_file: missing 'old_string' argument" };
    }
    if (typeof newString !== "string") {
      return { ok: false, summary: "edit_file: missing 'new_string' argument" };
    }

    let abs: string;
    try {
      abs = ctx.workspace.resolveInside(rawPath);
    } catch (err) {
      return { ok: false, summary: `edit_file: ${(err as Error).message}` };
    }

    let original: string;
    try {
      original = await readFile(abs, "utf8");
    } catch (err) {
      return { ok: false, summary: `edit_file: cannot read ${rawPath}: ${(err as Error).message}` };
    }

    const first = original.indexOf(oldString);
    if (first === -1) {
      return {
        ok: false,
        summary: `edit_file: old_string not found in ${display(ctx, abs)}`,
        detail: "Read the file again and match the existing text exactly, including whitespace.",
      };
    }

    const occurrences = original.split(oldString).length - 1;
    if (occurrences > 1 && !replaceAll) {
      return {
        ok: false,
        summary: `edit_file: old_string appears ${occurrences} times in ${display(ctx, abs)}`,
        detail: "Include more surrounding context to make it unique, or set replace_all: true.",
      };
    }

    const updated = replaceAll
      ? original.split(oldString).join(newString)
      : original.slice(0, first) + newString + original.slice(first + oldString.length);

    try {
      await writeFile(abs, updated, "utf8");
    } catch (err) {
      return { ok: false, summary: `edit_file: failed to write ${rawPath}: ${(err as Error).message}` };
    }

    const count = replaceAll ? occurrences : 1;
    return {
      ok: true,
      summary: `edited ${display(ctx, abs)} (${count} replacement${count === 1 ? "" : "s"})`,
    };
  },
};

export const readFileTool: Tool = {
  name: "read_file",
  description: "Read a UTF-8 text file inside the workspace and return its contents.",
  signature: "read_file(path: string) — path is relative to the workspace root",
  async run(call, ctx) {
    const rawPath = call.args.path;
    if (typeof rawPath !== "string" || rawPath.length === 0) {
      return { ok: false, summary: "read_file: missing 'path' argument" };
    }
    let abs: string;
    try {
      abs = ctx.workspace.resolveInside(rawPath);
    } catch (err) {
      return { ok: false, summary: `read_file: ${(err as Error).message}` };
    }
    try {
      const info = await stat(abs);
      if (info.isDirectory()) {
        return { ok: false, summary: `read_file: ${display(ctx, abs)} is a directory (use list_dir)` };
      }
      if (info.size > MAX_READ_BYTES) {
        return { ok: false, summary: `read_file: ${display(ctx, abs)} is ${info.size} bytes (limit ${MAX_READ_BYTES})` };
      }
      const content = await readFile(abs, "utf8");
      return { ok: true, summary: `read ${content.length} bytes from ${display(ctx, abs)}`, detail: content };
    } catch (err) {
      return { ok: false, summary: `read_file: ${(err as Error).message}` };
    }
  },
};

export const listDirTool: Tool = {
  name: "list_dir",
  description: "List the entries of a directory inside the workspace, with sizes for files.",
  signature: 'list_dir(path?: string) — directory relative to the workspace root (default ".")',
  async run(call, ctx) {
    const rawPath = typeof call.args.path === "string" && call.args.path ? call.args.path : ".";
    let abs: string;
    try {
      abs = ctx.workspace.resolveInside(rawPath);
    } catch (err) {
      return { ok: false, summary: `list_dir: ${(err as Error).message}` };
    }
    try {
      const entries = await readdir(abs, { withFileTypes: true });
      const lines: string[] = [];
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (entry.isDirectory()) {
          lines.push(`${entry.name}/`);
        } else {
          const info = await stat(join(abs, entry.name)).catch(() => null);
          lines.push(`${entry.name} (${info?.size ?? "?"} bytes)`);
        }
      }
      const detail = lines.length ? lines.join("\n") : "(empty directory)";
      return {
        ok: true,
        summary: `listed ${lines.length} entr${lines.length === 1 ? "y" : "ies"} in ${display(ctx, abs)}`,
        detail,
      };
    } catch (err) {
      return { ok: false, summary: `list_dir: ${(err as Error).message}` };
    }
  },
};

interface WalkEntry {
  rel: string;
  abs: string;
  size: number;
}

async function walk(root: string, dir: string, out: WalkEntry[], maxEntries: number): Promise<void> {
  if (out.length >= maxEntries) return;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (out.length >= maxEntries) return;
    if (entry.name.startsWith(".") || IGNORED_DIRS.has(entry.name)) continue;
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(root, abs, out, maxEntries);
    } else if (entry.isFile()) {
      const info = await stat(abs).catch(() => null);
      out.push({ rel: relative(root, abs), abs, size: info?.size ?? 0 });
    }
  }
}

export const globTool: Tool = {
  name: "glob",
  description: "Find files in the workspace whose path matches a glob pattern (supports * and **).",
  signature: 'glob(pattern: string) — e.g. "**/*.ts" or "src/*.py"',
  async run(call, ctx) {
    const pattern = call.args.pattern;
    if (typeof pattern !== "string" || pattern.length === 0) {
      return { ok: false, summary: "glob: missing 'pattern' argument" };
    }
    const all: WalkEntry[] = [];
    await walk(ctx.workspace.root, ctx.workspace.root, all, 5000);
    const re = globToRegExp(pattern);
    const matches = all.filter((e) => re.test(e.rel)).map((e) => e.rel);
    return {
      ok: true,
      summary: `${matches.length} file(s) matching ${pattern}`,
      detail: matches.slice(0, 200).join("\n") || "(no matches)",
    };
  },
};

export const grepTool: Tool = {
  name: "grep",
  description: "Search file contents in the workspace for a regular expression, returning matching lines.",
  signature: 'grep(pattern: string, glob?: string) — glob optionally restricts which files are searched',
  async run(call, ctx) {
    const pattern = call.args.pattern;
    if (typeof pattern !== "string" || pattern.length === 0) {
      return { ok: false, summary: "grep: missing 'pattern' argument" };
    }
    let re: RegExp;
    try {
      re = new RegExp(pattern, "i");
    } catch (err) {
      return { ok: false, summary: `grep: invalid pattern: ${(err as Error).message}` };
    }
    const fileGlob = typeof call.args.glob === "string" && call.args.glob ? call.args.glob : undefined;
    const fileRe = fileGlob ? globToRegExp(fileGlob) : undefined;

    const all: WalkEntry[] = [];
    await walk(ctx.workspace.root, ctx.workspace.root, all, 5000);

    const hits: string[] = [];
    for (const entry of all) {
      if (fileRe && !fileRe.test(entry.rel)) continue;
      if (entry.size > MAX_READ_BYTES) continue;
      let content: string;
      try {
        content = await readFile(entry.abs, "utf8");
      } catch {
        continue;
      }
      if (content.includes("\0")) continue; // skip binary
      const lines = content.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i])) {
          hits.push(`${entry.rel}:${i + 1}: ${lines[i].trim()}`);
          if (hits.length >= 300) break;
        }
      }
      if (hits.length >= 300) break;
    }
    return {
      ok: true,
      summary: `${hits.length} matching line(s) for /${pattern}/`,
      detail: hits.join("\n") || "(no matches)",
    };
  },
};

/** Minimal glob → RegExp: supports *, **, ?, and literal path segments. */
function globToRegExp(pattern: string): RegExp {
  const norm = pattern.replace(/\\/g, "/").replace(/^\.\//, "");
  let re = "";
  for (let i = 0; i < norm.length; i++) {
    const ch = norm[i];
    if (ch === "*") {
      if (norm[i + 1] === "*") {
        // "**/" or "**"
        const next = norm[i + 2];
        if (next === "/") {
          re += "(?:.*/)?";
          i += 2;
        } else {
          re += ".*";
          i += 1;
        }
      } else {
        re += "[^/]*";
      }
    } else if (ch === "?") {
      re += "[^/]";
    } else if ("\\^$.|+()[]{}".includes(ch)) {
      re += "\\" + ch;
    } else {
      re += ch;
    }
  }
  return new RegExp(`^${re}$`);
}
