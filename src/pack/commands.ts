import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { loadPrompt } from "../agent/prompt.js";
import { detectClipboard, normalizeClipboard, watchClipboard, type Clipboard } from "../human/clipboard.js";
import { CACHE_DIRNAME } from "../human/cache.js";
import { HumanTerminal } from "../human/terminal.js";
import { Workspace } from "../sandbox/workspace.js";
import { describePlan, failureReport, planChanges, writePlan } from "./apply.js";
import { INSTRUCTIONS_CLOSE, INSTRUCTIONS_OPEN, parseChanges } from "./format.js";
import { packToDocx } from "./docx.js";
import { buildRepomixPack, XML_EOF } from "./repomix.js";
import { buildPack, CHARS_PER_TOKEN, CONTEXT_TOKENS, DEFAULT_MAX_CHARS, DEFAULT_MAX_FILE_BYTES, PACK_TOKEN_BUDGET } from "./pack.js";
import { parseSkillList, renderSkills, resolveSkills, type Skill } from "../agent/skills.js";

export const PACK_FORMATS = ["txt", "docx", "xml"] as const;
export type PackFormat = (typeof PACK_FORMATS)[number];

const FORMAT_INFO: Record<PackFormat, { ext: string; kind: string }> = {
  txt: { ext: ".txt", kind: "text file" },
  docx: { ext: ".docx", kind: "Word document" },
  xml: { ext: ".xml", kind: "XML file" },
};

const log = (msg: string) => console.log(`[coccopilot] ${msg}`);

export interface PackArgs {
  cwd?: string;
  output?: string;
  include: string[];
  exclude: string[];
  defaultExcludes: boolean;
  maxFileBytes?: number;
  maxChars?: number;
  /** Output format; undefined = inferred from --output's extension, else txt. */
  format?: PackFormat;
  clipboard: boolean;
  task: string;
  /** Skill names (undefined = COCCOPILOT_SKILLS) and custom skill files. */
  skills?: string[];
  skillFiles: string[];
}

export interface ApplyArgs {
  cwd?: string;
  /** A change-set file, "-" for stdin, or undefined for the clipboard. */
  input?: string;
  dryRun: boolean;
  yes: boolean;
  partial: boolean;
  watch: boolean;
  clipboard: boolean;
}

function takeValue(argv: string[], i: number, flag: string): string {
  const v = argv[i];
  if (v === undefined) throw new Error(`${flag} needs a value`);
  return v;
}

/** "a, b,c" -> ["a", "b", "c"]: lets one flag carry several paths. */
function splitList(value: string): string[] {
  return value.split(",").map((v) => v.trim()).filter(Boolean);
}

export function parsePackArgs(argv: string[]): PackArgs {
  const args: PackArgs = { include: [], exclude: [], defaultExcludes: true, clipboard: true, task: "", skillFiles: [] };
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--cwd") args.cwd = takeValue(argv, ++i, a);
    else if (a === "-o" || a === "--output") args.output = takeValue(argv, ++i, a);
    else if (a === "--include") args.include.push(...splitList(takeValue(argv, ++i, a)));
    else if (a === "--exclude") args.exclude.push(takeValue(argv, ++i, a));
    else if (a === "--no-default-excludes") args.defaultExcludes = false;
    else if (a === "--max-file-bytes") args.maxFileBytes = Number(takeValue(argv, ++i, a));
    else if (a === "--max-chars") args.maxChars = Number(takeValue(argv, ++i, a));
    else if (a === "--format") {
      const v = takeValue(argv, ++i, a).toLowerCase().replace(/^\./, "");
      if (!(PACK_FORMATS as readonly string[]).includes(v)) throw new Error(`--format must be one of ${PACK_FORMATS.join(", ")}, got ${v}`);
      args.format = v as PackFormat;
    } else if (a === "--docx") args.format = "docx";
    else if (a === "--xml" || a === "--repomix") args.format = "xml";
    else if (a === "--no-clipboard") args.clipboard = false;
    else if (a === "--skills") args.skills = [...(args.skills ?? []), ...parseSkillList(takeValue(argv, ++i, a))];
    else if (a === "--skill") args.skillFiles.push(takeValue(argv, ++i, a));
    else if (a.startsWith("-")) throw new Error(`unknown flag for pack: ${a}`);
    else positionals.push(a);
  }
  args.task = positionals.join(" ").trim();
  return args;
}

export function parseApplyArgs(argv: string[]): ApplyArgs {
  const args: ApplyArgs = { dryRun: false, yes: false, partial: false, watch: false, clipboard: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--cwd") args.cwd = takeValue(argv, ++i, a);
    else if (a === "--dry-run") args.dryRun = true;
    else if (a === "-y" || a === "--yes") args.yes = true;
    else if (a === "--partial") args.partial = true;
    else if (a === "--watch") args.watch = true;
    else if (a === "--no-clipboard") args.clipboard = false;
    else if (a === "-") args.input = "-";
    else if (a.startsWith("-")) throw new Error(`unknown flag for apply: ${a}`);
    else if (args.input === undefined) args.input = a;
    else throw new Error(`apply takes one input, got ${args.input} and ${a}`);
  }
  return args;
}

export function printPackUsage(): void {
  console.error(
    [
      'usage: coccopilot pack [options] ["<task>"]',
      "       coccopilot apply [<changes.txt> | -] [options]",
      "",
      "  pack:  encode the workspace (folder structure + every text file) into a .txt, .docx or",
      "         (with repomix) a single .xml file",
      "         to upload to Copilot, and copy a kick-off message that teaches it the change format.",
      "  apply: decode the change set from Copilot's reply (clipboard by default, a file, or",
      "         stdin with -) and apply it to the workspace. Nothing is written unless every",
      "         change applies cleanly.",
      "",
      "pack options:",
      "  --cwd <dir>              workspace root (default: current directory)",
      "  -o, --output <path>      pack file (default: <workspace>/.coccopilot/<name>.pack.<format>)",
      "  --format txt|docx|xml    pack as plain text, a Word document, or one repomix XML file",
      "                           (default: from -o's extension, else txt); --docx and --xml",
      "                           (or --repomix) are short for --format docx / xml. xml runs",
      "                           repomix (on PATH, COCCOPILOT_REPOMIX, else npx) and is never split",
      "  --include <glob>         inline only matching files or folders; repeat it or use commas",
      "                           (--include src/api --include src/db,README.md); a folder path",
      "                           includes everything under it; the rest stay in the tree, listed only",
      "  --exclude <glob>         leave matching files out (repeatable; \"dir/\" for a directory)",
      "  --no-default-excludes    also inline lockfiles, minified bundles and source maps",
      `  --max-file-bytes <n>     list larger files without their content (default: ${DEFAULT_MAX_FILE_BYTES})`,
      `  --max-chars <n>          split the pack into parts of at most about n characters, so Copilot`,
      `                           reads each in full (default: ${DEFAULT_MAX_CHARS}; 0 = one file)`,
      "  --no-clipboard           don't copy the kick-off message",
      "  --skills <list>          roles for Copilot (developer, simplifier, reviewer, documenter, all, …)",
      "  --skill <file.md>        load a custom skill file and use it (repeatable)",
      "",
      "apply options:",
      "  --cwd <dir>              workspace root (default: current directory)",
      "  --dry-run                show what would change; write nothing",
      "  -y, --yes                apply without asking",
      "  --partial                apply the changes that work even if some fail",
      "  --watch                  keep watching the clipboard and apply each new change set",
      "  --no-clipboard           don't read or write the clipboard",
    ].join("\n"),
  );
}

export function partPath(base: string, index: number, total: number, ext = ".txt"): string {
  if (total === 1) return base;
  const re = new RegExp(`(${ext.replace(".", "\\.")})?$`, "i");
  return base.replace(re, (found) => `.part${index}of${total}${found || ext}`);
}

/** --format wins; otherwise a .docx/.xml output path picks that format; otherwise txt. */
export function resolveFormat(args: Pick<PackArgs, "format" | "output">): PackFormat {
  if (args.format) return args.format;
  if (args.output && /\.docx$/i.test(args.output)) return "docx";
  if (args.output && /\.xml$/i.test(args.output)) return "xml";
  return "txt";
}

/** The kick-off message for a repomix XML pack: one file, XML layout, @@@ answers. */
function xmlKickoffMessage(fileName: string, instructions: string, task: string, skills: Skill[]): string {
  return [
    `I've attached "${fileName}": an XML snapshot of my repository made with Repomix. <directory_structure> lists`,
    `its folders and files, and each <file path="…"> element inside <files> holds the full content of one text file,`,
    "verbatim. Files listed in the structure without a <file> element (binaries, very large or generated files) are",
    "not in the snapshot: if you need one, ask me for it.",
    "Please read it as the current state of my code: work from the full file contents, not a summary.",
    `It ends with an "${XML_EOF}" line after the <instruction> section: if you can't see that line, the attachment was cut off.`,
    "If the attachment looks cut off or you can't open part of it, tell me instead of guessing at the missing code.",
    `Answer with the plain-text "@@@" change set described below, never with XML <file> elements: copy SEARCH text`,
    "from inside the <file> elements (without the tags).",
    "",
    INSTRUCTIONS_OPEN,
    instructions.trim(),
    INSTRUCTIONS_CLOSE,
    ...(skills.length ? ["", renderSkills(skills, "pack")] : []),
    "",
    task ? `My task: ${task}` : "Wait for my task.",
  ].join("\n");
}

/** The message pasted into the chat with the uploaded pack. */
export function kickoffMessage(
  fileNames: string[],
  instructions: string,
  task: string,
  format: PackFormat = "txt",
  skills: Skill[] = [],
): string {
  if (format === "xml") return xmlKickoffMessage(fileNames[0], instructions, task, skills);
  const files = fileNames.map((f) => `"${f}"`).join(", ");
  const what = format === "docx" ? "a Word document holding a snapshot" : "a plain-text snapshot";
  const many = fileNames.length > 1;
  return [
    many
      ? `I've attached ${files}: ${fileNames.length} parts of ${what} of my repository. Part 1 starts with the folder`
      : `I've attached ${files}: ${what} of my repository. It starts with the folder structure,`,
    many
      ? `structure; together the parts hold the text files between "@@@ FILE <path>" and "@@@ END <path>" lines.`
      : `then holds the text files between "@@@ FILE <path>" and "@@@ END <path>" lines.`,
    `Files the tree marks "(not included: …)" are not in the snapshot: if you need one, ask me for it.`,
    "Please read it as the current state of my code: work from the full file contents, not a summary.",
    many
      ? `Each part ends with an "@@@ EOF · end of part <n>/${fileNames.length}" line: if you can't see that line in a part, it was cut off.`
      : `It ends with an "@@@ EOF" line: if you can't see that line, the attachment was cut off.`,
    "If the attachment looks cut off or you can't open part of it, tell me instead of guessing at the missing code.",
    "",
    INSTRUCTIONS_OPEN,
    instructions.trim(),
    INSTRUCTIONS_CLOSE,
    ...(skills.length ? ["", renderSkills(skills, "pack")] : []),
    "",
    task ? `My task: ${task}` : "Wait for my task.",
  ].join("\n");
}

export async function runPack(args: PackArgs): Promise<void> {
  const root = resolve(args.cwd ?? process.cwd());
  const instructions = await loadPrompt("pack.md");
  const skills = await resolveSkills(root, args.skills ?? parseSkillList(process.env.COCCOPILOT_SKILLS), args.skillFiles);
  if (skills.length) log(`skills: ${skills.map((s) => s.name).join(", ")}`);
  const output = args.output ? resolve(args.output) : undefined;
  const format = resolveFormat(args);
  const { ext, kind } = FORMAT_INFO[format];
  if (format === "xml") return runRepomixPack(args, root, output, instructions, skills);

  const pack = await buildPack({
    root,
    include: args.include,
    exclude: args.exclude,
    defaultExcludes: args.defaultExcludes,
    maxFileBytes: args.maxFileBytes,
    maxChars: args.maxChars ?? DEFAULT_MAX_CHARS,
    skipPaths: output ? [output] : [],
    instructions,
    documentKind: kind,
  });

  const total = pack.parts.length;
  const base = output ?? join(root, CACHE_DIRNAME, `${pack.name}.pack${ext}`);
  const paths = pack.parts.map((_, i) => partPath(base, i + 1, total, ext));
  await mkdir(dirname(base), { recursive: true });
  // Keep the default location out of the packed project's git history.
  if (!output) await writeFile(join(root, CACHE_DIRNAME, ".gitignore"), "*\n", "utf8").catch(() => undefined);
  for (let i = 0; i < total; i++) {
    const title = `${pack.name} snapshot${total > 1 ? ` (part ${i + 1} of ${total})` : ""}`;
    await writeFile(paths[i], format === "docx" ? packToDocx(pack.parts[i], title) : pack.parts[i]);
  }

  const included = pack.entries.filter((e) => e.content !== undefined).length;
  const chars = pack.parts.reduce((n, p) => n + p.length, 0);
  const tokens = Math.round(chars / CHARS_PER_TOKEN);
  log(`packed ${included} file(s) from ${root} (${chars} chars, ~${tokens} tokens)`);
  const listedOnly = pack.entries.filter((e) => e.skipped);
  const outside = listedOnly.filter((e) => e.skipped === "outside --include");
  for (const e of listedOnly) if (e.skipped !== "outside --include") log(`  listed only: ${e.path} (${e.skipped})`);
  if (outside.length) log(`  listed only: ${outside.length} file(s) outside --include`);
  for (const p of paths) log(`wrote ${p}`);
  if (tokens > PACK_TOKEN_BUDGET) {
    log(
      `warning: ~${tokens} tokens is more than Copilot's ~${CONTEXT_TOKENS / 1000}k-token context window can hold with room ` +
        "to work; it will miss part of the code. Narrow the pack with --include or --exclude.",
    );
  }
  const limit = args.maxChars ?? DEFAULT_MAX_CHARS;
  const oversized = pack.parts.map((p, i) => ({ i, n: p.length })).filter(({ n }) => n > (limit || DEFAULT_MAX_CHARS));
  for (const { i, n } of oversized) {
    log(
      `warning: ${basename(paths[i])} is ${n} chars; Copilot may read only the start of it` +
        (limit ? " (a single file is larger than --max-chars: --exclude it or lower --max-file-bytes)" : " (pass --max-chars to split)"),
    );
  }

  const message = kickoffMessage(paths.map((p) => basename(p)), instructions, args.task, format, skills);
  const clipboard = args.clipboard ? await detectClipboard() : null;
  const copied = clipboard ? await clipboard.write(message).then(() => true, () => false) : false;

  console.log(
    [
      "",
      `  1. Upload ${total === 1 ? "the pack file" : `all ${total} pack files`} to Copilot (attach it, or put it in the`,
      "     workspace/OneDrive folder Copilot can see).",
      copied
        ? "  2. Paste the kick-off message (already on your clipboard), add your task, and send."
        : "  2. Send this kick-off message along with it:\n\n" + message + "\n",
      "  3. Copy Copilot's reply and run `coccopilot apply` (or keep `coccopilot apply --watch` running).",
      "",
    ].join("\n"),
  );
}

/** `pack --format xml`: the whole repository as one repomix XML file. */
async function runRepomixPack(
  args: PackArgs,
  root: string,
  output: string | undefined,
  instructions: string,
  skills: Skill[],
): Promise<void> {
  const path = output ?? join(root, CACHE_DIRNAME, `${basename(root)}.pack.xml`);
  await mkdir(dirname(path), { recursive: true });
  if (!output) await writeFile(join(root, CACHE_DIRNAME, ".gitignore"), "*\n", "utf8").catch(() => undefined);
  if (args.maxChars) log("note: --max-chars is ignored with --format xml; the XML pack is always one file");

  log("packing with repomix…");
  const pack = await buildRepomixPack({
    root,
    output: path,
    include: args.include,
    exclude: args.exclude,
    defaultExcludes: args.defaultExcludes,
    maxFileBytes: args.maxFileBytes,
    instructions,
  });
  const chars = pack.xml.length;
  const tokens = Math.round(chars / CHARS_PER_TOKEN);
  log(`packed ${pack.files.length} file(s) from ${root} (${chars} chars, ~${tokens} tokens)`);
  log(`wrote ${path}`);
  if (tokens > PACK_TOKEN_BUDGET) {
    log(
      `warning: ~${tokens} tokens is more than Copilot's ~${CONTEXT_TOKENS / 1000}k-token context window can hold with room ` +
        "to work; it will miss part of the code. Narrow the pack with --include or --exclude.",
    );
  } else if (chars > DEFAULT_MAX_CHARS) {
    log(
      `warning: ${basename(path)} is ${chars} chars; Copilot's document reader may read only the start of it. ` +
        "Narrow it with --include/--exclude, or use --format txt|docx, which split into parts.",
    );
  }

  const message = kickoffMessage([basename(path)], instructions, args.task, "xml", skills);
  const clipboard = args.clipboard ? await detectClipboard() : null;
  const copied = clipboard ? await clipboard.write(message).then(() => true, () => false) : false;
  console.log(
    [
      "",
      "  1. Upload the XML pack file to Copilot (attach it, or put it in the workspace/OneDrive",
      "     folder Copilot can see).",
      copied
        ? "  2. Paste the kick-off message (already on your clipboard), add your task, and send."
        : "  2. Send this kick-off message along with it:\n\n" + message + "\n",
      "  3. Copy Copilot's reply and run `coccopilot apply` (or keep `coccopilot apply --watch` running).",
      "",
    ].join("\n"),
  );
}

async function readInput(args: ApplyArgs, clipboard: Clipboard | null): Promise<string | undefined> {
  if (args.input === "-") {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks).toString("utf8");
  }
  if (args.input) return readFile(resolve(args.input), "utf8");
  if (!clipboard) throw new Error("no clipboard available: pass the change set as a file, or - for stdin");
  return undefined;
}

const hasOps = (text: string) => parseChanges(text).ops.length > 0;

/** Apply one change set. Returns false when nothing (or not everything) was applied. */
async function applyOnce(
  text: string,
  workspace: Workspace,
  args: ApplyArgs,
  clipboard: Clipboard | null,
  terminal: () => HumanTerminal,
): Promise<boolean> {
  const parsed = parseChanges(text);
  for (const w of parsed.warnings) log(`warning: ${w}`);
  if (parsed.ops.length === 0) {
    log("no change set found (expected \"@@@ EDIT\", \"@@@ FILE\", \"@@@ DELETE\" or \"@@@ RENAME\" lines)");
    for (const e of parsed.errors) log(`  ${e}`);
    return false;
  }

  const plan = await planChanges(workspace, parsed.ops);
  const problems = parsed.errors.length + plan.failures.length;
  const lines = describePlan(plan);
  log(`change set: ${parsed.ops.length} operation(s), ${plan.changes.length} file(s) to change${problems ? `, ${problems} problem(s)` : ""}`);
  for (const l of lines) console.log(`  ${l}`);
  for (const n of plan.notes) log(`  note: ${n}`);

  const willWrite = plan.changes.length > 0 && (problems === 0 || args.partial) && !args.dryRun;
  if (problems > 0) {
    const report = failureReport(parsed.errors, plan.failures, !willWrite);
    console.log(`\n${report}\n`);
    if (clipboard && !args.dryRun) {
      await clipboard.write(report).catch(() => undefined);
      log("the report above is on your clipboard: paste it into Copilot");
    }
  }
  if (!willWrite) {
    if (args.dryRun) {
      log("dry run: nothing written");
      return problems === 0;
    }
    if (problems > 0) log("nothing written (pass --partial to apply the changes that work)");
    return false;
  }

  if (!args.yes) {
    if (!process.stdin.isTTY || args.input === "-") {
      log("refusing to write without confirmation: pass -y to apply non-interactively");
      return false;
    }
    process.stdout.write(`[coccopilot] apply ${plan.changes.length} file change(s)? [y/N] `);
    const answer = await terminal().nextLine();
    if (!/^y(es)?$/i.test(answer.trim())) {
      log("not applied");
      return false;
    }
  }

  await writePlan(workspace, plan);
  log(`applied ${plan.changes.length} file change(s)`);
  return problems === 0;
}

export async function runApply(args: ApplyArgs): Promise<boolean> {
  const workspace = new Workspace(resolve(args.cwd ?? process.cwd()));
  const clipboard = args.clipboard ? await detectClipboard() : null;
  // Created on first use, so `apply -` can read stdin without readline competing for it.
  let terminal: HumanTerminal | undefined;
  const getTerminal = () => (terminal ??= new HumanTerminal());
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);

  try {
    const text = await readInput(args, clipboard);
    if (text !== undefined) return await applyOnce(text, workspace, args, clipboard, getTerminal);

    // Clipboard: use what's there if it is a change set, otherwise wait for one.
    let ok = false;
    let next: string | undefined = await clipboard!.read().then(normalizeClipboard, () => "");
    if (!hasOps(next)) next = undefined;
    do {
      if (next === undefined) {
        log("waiting for a change set: copy Copilot's reply (Ctrl-C to stop)");
        next = await watchClipboard(clipboard!, controller.signal, undefined, hasOps);
        if (next === undefined) break;
        log(`picked up Copilot's reply from the clipboard (${next.length} chars)`);
      }
      ok = await applyOnce(next, workspace, args, clipboard, getTerminal);
      next = undefined;
    } while (args.watch && !controller.signal.aborted);
    return ok;
  } finally {
    process.off("SIGINT", stop);
    terminal?.close();
  }
}
