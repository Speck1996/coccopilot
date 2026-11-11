import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve } from "node:path";
import { CACHE_DIRNAME } from "../human/cache.js";
import { INSTRUCTIONS_CLOSE, INSTRUCTIONS_OPEN, MARKER } from "./format.js";
import { DEFAULT_EXCLUDES, DEFAULT_MAX_FILE_BYTES, WALK_IGNORED_DIRS } from "./pack.js";

/**
 * Pack mode's XML flavor: the repository packed by Repomix (https://repomix.com) into one
 * XML file, `<directory_structure>` then `<files>` with one `<file path="…">` per text
 * file, and coccopilot's change-format instructions in the trailing `<instruction>`.
 * Copilot still answers with the plain-text `@@@` change set, so `apply` is unchanged;
 * `parseChanges` also reads `<file path>` blocks, so `apply` can unpack the XML itself.
 */

/** Pinned so the XML layout the prompt describes doesn't move under us. */
export const REPOMIX_VERSION = "1.19.0";

export interface RepomixOptions {
  root: string;
  output: string;
  include?: string[];
  exclude?: string[];
  defaultExcludes?: boolean;
  maxFileBytes?: number;
  instructions: string;
  /** Override the repomix command (default: COCCOPILOT_REPOMIX, `repomix` on PATH, else npx). */
  command?: string[];
}

export interface RepomixResult {
  name: string;
  /** Paths of the files inlined in the XML. */
  files: string[];
  xml: string;
}

/** Last line of the instruction section: the whole XML was read when Copilot can see it. */
export const XML_EOF = `${MARKER} EOF`;

function run(cmd: string, args: string[], cwd: string): Promise<{ ok: boolean; out: string }> {
  return new Promise((done) => {
    execFile(
      cmd,
      args,
      { cwd, maxBuffer: 64 * 1024 * 1024, shell: process.platform === "win32", env: { ...process.env, NO_COLOR: "1" } },
      (err, stdout, stderr) => done({ ok: !err, out: `${stdout}${stderr}`.trim() || String(err?.message ?? "") }),
    );
  });
}

/** How to run repomix: an explicit command, a `repomix` on PATH, or `npx` with the pinned version. */
export async function repomixCommand(override?: string[]): Promise<string[]> {
  if (override?.length) return override;
  const env = process.env.COCCOPILOT_REPOMIX?.trim();
  if (env) return env.split(/\s+/);
  const probe = await run("repomix", ["--version"], process.cwd());
  if (probe.ok) return ["repomix"];
  return ["npx", "--yes", `repomix@${REPOMIX_VERSION}`];
}

/**
 * Translate coccopilot's glob conventions to repomix's: a pattern without "/" matches
 * any path segment ("**\/p"), "dir/" means the directory and everything under it.
 */
export function toRepomixIgnore(pattern: string): string[] {
  const p = pattern.trim().replace(/^\.\//, "");
  if (!p) return [];
  if (p.endsWith("/")) {
    const dir = p.slice(0, -1);
    return [dir.includes("/") ? `${dir}/**` : `**/${dir}/**`];
  }
  return p.includes("/") ? [p] : [`**/${p}`];
}

/** A plain path ("src/billing", "README.md") includes itself and everything under it. */
export function toRepomixInclude(pattern: string): string[] {
  const p = pattern.trim().replace(/^\.\//, "").replace(/\/$/, "");
  if (!p) return [];
  if (/[*?[\]{}]/.test(p)) return [p];
  return [p, `${p}/**`];
}

/** The `@@@` instructions, fenced by the markers `parseChanges` skips, then the EOF line. */
export function instructionSection(instructions: string): string {
  return [INSTRUCTIONS_OPEN, instructions.trim(), INSTRUCTIONS_CLOSE, "", XML_EOF, ""].join("\n");
}

export function headerText(name: string, commit?: string): string {
  return [
    `COCCOPILOT PACK v1 (xml) · ${name}${commit ? ` @ ${commit}` : ""}.`,
    `This XML file is a snapshot of the repository "${name}": <directory_structure> lists the folders and files,`,
    `and each <file path="…"> element in <files> holds the full content of one text file, verbatim (not XML-escaped).`,
    `Paths are relative to the repository root. The <instruction> section at the end says how to answer with code`,
    `changes: always as a plain-text "${MARKER}" change set, never as XML. The file ends with a "${XML_EOF}" line.`,
  ].join("\n");
}

const FILE_TAG = /^<file path="([^"]+)">\s*$/gm;

function git(root: string, args: string[]): Promise<string | undefined> {
  return new Promise((done) => execFile("git", args, { cwd: root }, (err, stdout) => done(err ? undefined : stdout)));
}

/** Run repomix over `root` and write one XML file to `output`. */
export async function buildRepomixPack(opts: RepomixOptions): Promise<RepomixResult> {
  const root = resolve(opts.root);
  const output = resolve(opts.output);
  const name = basename(root);
  const commit = (await git(root, ["rev-parse", "--short", "HEAD"]))?.trim();

  const tmp = await mkdtemp(join(tmpdir(), "coccopilot-repomix-"));
  try {
    const instructionPath = join(tmp, "instructions.md");
    await writeFile(instructionPath, instructionSection(opts.instructions), "utf8");
    // Our own config, so a repomix.config.json in the project can't change the layout
    // (line numbers, compression, comment stripping would all break SEARCH matching).
    const configPath = join(tmp, "repomix.config.json");
    await writeFile(
      configPath,
      JSON.stringify({ input: { maxFileSize: opts.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES } }, null, 2),
      "utf8",
    );

    const ignore = [`${CACHE_DIRNAME}/**`, ...(opts.exclude ?? []).flatMap(toRepomixIgnore)];
    if (opts.defaultExcludes !== false) ignore.push(...DEFAULT_EXCLUDES.flatMap(toRepomixIgnore));
    // Repomix's built-in patterns also drop lockfiles; without them, still keep
    // dependency and build directories out.
    else ignore.push(...[...WALK_IGNORED_DIRS].flatMap((d) => toRepomixIgnore(`${d}/`)));
    const rel = relative(root, output).split("\\").join("/");
    if (rel && !rel.startsWith("..")) ignore.push(rel);
    const include = (opts.include ?? []).flatMap(toRepomixInclude);

    const [cmd, ...pre] = await repomixCommand(opts.command);
    const args = [
      ...pre,
      ".",
      "--config", configPath,
      "--style", "xml",
      "--output", output,
      "--header-text", headerText(name, commit),
      "--instruction-file-path", instructionPath,
      "--no-git-sort-by-changes",
      "--quiet",
      ...(include.length ? ["--include", include.join(","), "--include-full-directory-structure"] : []),
      ...(ignore.length ? ["--ignore", ignore.join(",")] : []),
      ...(opts.defaultExcludes === false ? ["--no-default-patterns"] : []),
    ];
    const res = await run(cmd, args, root);
    if (!res.ok) {
      throw new Error(
        `repomix failed (${[cmd, ...pre].join(" ")}): ${res.out}\n` +
          "Install it with `npm i -g repomix`, or point COCCOPILOT_REPOMIX at a repomix command.",
      );
    }
    const xml = await readFile(output, "utf8");
    const files = [...xml.matchAll(FILE_TAG)].map((m) => m[1]);
    return { name, files, xml };
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}
