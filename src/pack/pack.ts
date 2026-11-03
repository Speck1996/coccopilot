import { execFile } from "node:child_process";
import { readFile, readdir, stat } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import { globToRegExp } from "../tools/fs.js";
import { encodeFile, INSTRUCTIONS_CLOSE, INSTRUCTIONS_OPEN, MARKER } from "./format.js";

/** Never packed: VCS internals, coccopilot's own state, dependency and build output. */
const ALWAYS_IGNORED_DIRS = new Set([".git", ".hg", ".svn", ".coccopilot"]);
const WALK_IGNORED_DIRS = new Set([
  "node_modules", "dist", "build", "out", "target", ".next", ".nuxt", ".cache", ".venv", "venv",
  "__pycache__", ".pytest_cache", ".mypy_cache", ".tox", ".gradle", ".idea", ".vscode", "coverage",
]);

/** Listed in the tree but not inlined by default: big, generated, useless to read. */
export const DEFAULT_EXCLUDES = [
  "package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml", "bun.lockb",
  "poetry.lock", "uv.lock", "Pipfile.lock", "Cargo.lock", "composer.lock", "Gemfile.lock", "go.sum",
  "*.min.js", "*.min.css", "*.map", ".DS_Store",
];

export const DEFAULT_MAX_FILE_BYTES = 200_000;

export interface PackOptions {
  root: string;
  /** Extra exclude globs. A pattern without "/" matches any path segment. */
  exclude?: string[];
  /** Apply DEFAULT_EXCLUDES (lockfiles, minified bundles, source maps). */
  defaultExcludes?: boolean;
  maxFileBytes?: number;
  /** Split into parts of about this many characters; 0 = one file. */
  maxChars?: number;
  /** Absolute paths that must never be packed (e.g. the pack output itself). */
  skipPaths?: string[];
  /** The change-format instructions embedded in the pack header. */
  instructions: string;
}

export interface PackEntry {
  path: string;
  bytes: number;
  /** Text content, absent when the file is skipped. */
  content?: string;
  /** Why the content was left out. */
  skipped?: string;
}

export interface Pack {
  name: string;
  entries: PackEntry[];
  parts: string[];
}

function git(root: string, args: string[]): Promise<string | undefined> {
  return new Promise((resolveGit) => {
    execFile("git", args, { cwd: root, maxBuffer: 64 * 1024 * 1024 }, (err, stdout) =>
      resolveGit(err ? undefined : stdout),
    );
  });
}

async function walk(root: string, dir: string, out: string[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (ALWAYS_IGNORED_DIRS.has(entry.name) || WALK_IGNORED_DIRS.has(entry.name)) continue;
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) await walk(root, abs, out);
    else if (entry.isFile()) out.push(relative(root, abs).split("\\").join("/"));
  }
}

/**
 * List the files to pack. In a git repository this is what git sees (tracked plus
 * untracked-but-not-ignored), so `.gitignore` is honored; elsewhere a walk that skips
 * the usual dependency and build directories.
 */
export async function listFiles(root: string): Promise<string[]> {
  const listed = await git(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]);
  const paths = listed !== undefined ? listed.split("\0").filter(Boolean) : await (async () => {
    const out: string[] = [];
    await walk(root, root, out);
    return out;
  })();
  const unique = [...new Set(paths)].filter((p) => !p.split("/").some((seg) => ALWAYS_IGNORED_DIRS.has(seg)));
  return unique.sort((a, b) => a.localeCompare(b));
}

/** Compile exclude globs: "dir/" excludes a directory, a "/"-less pattern any segment. */
export function excludeMatcher(patterns: string[]): (path: string) => boolean {
  const res = patterns.map((raw) => {
    const p = raw.trim().replace(/^\.\//, "");
    if (p.endsWith("/")) return { re: globToRegExp(`${p}**`), anySegment: !p.slice(0, -1).includes("/") };
    return { re: globToRegExp(p), anySegment: !p.includes("/") };
  });
  return (path) =>
    res.some(({ re, anySegment }) => {
      if (re.test(path)) return true;
      if (!anySegment) return false;
      const segs = path.split("/");
      return segs.some((seg, i) => re.test(seg) || re.test(segs.slice(i).join("/")));
    });
}

const utf8 = new TextDecoder("utf-8", { fatal: true });

function decodeText(buf: Buffer): string | undefined {
  if (buf.subarray(0, 8192).includes(0)) return undefined;
  try {
    return utf8.decode(buf);
  } catch {
    return undefined;
  }
}

export async function collectEntries(opts: PackOptions): Promise<PackEntry[]> {
  const root = resolve(opts.root);
  const maxBytes = opts.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const defaults = opts.defaultExcludes === false ? [] : DEFAULT_EXCLUDES;
  const isDefaultExcluded = excludeMatcher(defaults);
  const isExcluded = excludeMatcher(opts.exclude ?? []);
  const skip = new Set((opts.skipPaths ?? []).map((p) => resolve(p)));

  const entries: PackEntry[] = [];
  for (const path of await listFiles(root)) {
    const abs = join(root, path);
    if (skip.has(abs) || isExcluded(path)) continue;
    const info = await stat(abs).catch(() => null);
    if (!info?.isFile()) continue; // deleted but still tracked, or a symlink to a dir
    const entry: PackEntry = { path, bytes: info.size };
    if (isDefaultExcluded(path)) entry.skipped = "generated";
    else if (info.size > maxBytes) entry.skipped = `${formatBytes(info.size)}, too large`;
    else {
      const text = decodeText(await readFile(abs));
      if (text === undefined) entry.skipped = `binary, ${formatBytes(info.size)}`;
      else entry.content = text;
    }
    entries.push(entry);
  }
  return entries;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

interface TreeNode {
  dirs: Map<string, TreeNode>;
  files: PackEntry[];
}

/**
 * Render the folder structure as an indented tree. Directory chains with a single
 * child directory and no files collapse into one line (`src/main/java/com/acme/`),
 * which keeps deep Java/Go layouts short. Skipped files carry the reason.
 */
export function renderTree(name: string, entries: PackEntry[]): string {
  const root: TreeNode = { dirs: new Map(), files: [] };
  for (const e of entries) {
    const segs = e.path.split("/");
    let node = root;
    for (const seg of segs.slice(0, -1)) {
      let next = node.dirs.get(seg);
      if (!next) node.dirs.set(seg, (next = { dirs: new Map(), files: [] }));
      node = next;
    }
    node.files.push(e);
  }

  const out: string[] = [`${name}/`];
  const render = (node: TreeNode, depth: number) => {
    const pad = "  ".repeat(depth);
    for (const [dirName, child] of [...node.dirs].sort(([a], [b]) => a.localeCompare(b))) {
      let label = dirName;
      let leaf = child;
      while (leaf.files.length === 0 && leaf.dirs.size === 1) {
        const [[nextName, next]] = [...leaf.dirs];
        label += `/${nextName}`;
        leaf = next;
      }
      out.push(`${pad}${label}/`);
      render(leaf, depth + 1);
    }
    for (const f of node.files) {
      const fileName = f.path.slice(f.path.lastIndexOf("/") + 1);
      out.push(`${pad}${fileName}${f.skipped ? `  (not included: ${f.skipped})` : ""}`);
    }
  };
  render(root, 1);
  return out.join("\n");
}

/**
 * Build the pack: a header with the change-format instructions and the tree, then one
 * FILE block per text file. With `maxChars`, files are distributed over several parts
 * (never split mid-file); part 1 carries the header and tree.
 */
export async function buildPack(opts: PackOptions): Promise<Pack> {
  const root = resolve(opts.root);
  const name = basename(root);
  const entries = await collectEntries(opts);
  const included = entries.filter((e) => e.content !== undefined);
  const commit = (await git(root, ["rev-parse", "--short", "HEAD"]))?.trim();

  const blocks = included.map((e) => encodeFile(e.path, e.content!));
  const maxChars = opts.maxChars ?? 0;
  const groups: string[][] = [[]];
  let size = 0;
  for (const block of blocks) {
    const current = groups[groups.length - 1];
    if (maxChars > 0 && current.length > 0 && size + block.length > maxChars) {
      groups.push([block]);
      size = block.length;
    } else {
      current.push(block);
      size += block.length;
    }
  }

  const total = groups.length;
  const stats = `${included.length} files${entries.length > included.length ? `, ${entries.length - included.length} listed only` : ""}`;
  const parts = groups.map((group, index) => {
    const partNote = total > 1 ? ` · part ${index + 1}/${total}` : "";
    const head = [`${MARKER} COCCOPILOT PACK v1 · ${name}${commit ? ` @ ${commit}` : ""} · ${stats}${partNote}`, ""];
    if (index === 0) {
      head.push(
        `This text file is a snapshot of the repository "${name}": first the folder structure, then the full`,
        `content of every text file, each between a "${MARKER} FILE <path> [<n> lines]" line and a "${MARKER} END <path>" line.`,
        `Paths are relative to the repository root.${total > 1 ? ` The files are spread over ${total} parts; this is part 1.` : ""}`,
        "",
        INSTRUCTIONS_OPEN,
        opts.instructions.trim(),
        INSTRUCTIONS_CLOSE,
        "",
        `${MARKER} TREE`,
        renderTree(name, entries),
        "",
      );
    } else {
      head.push(`Part ${index + 1} of ${total} of the "${name}" snapshot; part 1 has the folder structure and instructions.`, "");
    }
    head.push(`${MARKER} FILES`);
    return [...head, ...group, `${MARKER} EOF`, ""].join("\n");
  });

  return { name, entries, parts };
}
