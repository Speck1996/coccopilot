import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { loadPrompt } from "../agent/prompt.js";
import { detectClipboard, normalizeClipboard, watchClipboard, type Clipboard } from "../human/clipboard.js";
import { CACHE_DIRNAME } from "../human/cache.js";
import { HumanTerminal } from "../human/terminal.js";
import { Workspace } from "../sandbox/workspace.js";
import { describePlan, failureReport, planChanges, writePlan } from "./apply.js";
import { INSTRUCTIONS_CLOSE, INSTRUCTIONS_OPEN, parseChanges } from "./format.js";
import { buildPack, DEFAULT_MAX_FILE_BYTES } from "./pack.js";

const log = (msg: string) => console.log(`[coccopilot] ${msg}`);

export interface PackArgs {
  cwd?: string;
  output?: string;
  exclude: string[];
  defaultExcludes: boolean;
  maxFileBytes?: number;
  maxChars?: number;
  clipboard: boolean;
  task: string;
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

export function parsePackArgs(argv: string[]): PackArgs {
  const args: PackArgs = { exclude: [], defaultExcludes: true, clipboard: true, task: "" };
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--cwd") args.cwd = takeValue(argv, ++i, a);
    else if (a === "-o" || a === "--output") args.output = takeValue(argv, ++i, a);
    else if (a === "--exclude") args.exclude.push(takeValue(argv, ++i, a));
    else if (a === "--no-default-excludes") args.defaultExcludes = false;
    else if (a === "--max-file-bytes") args.maxFileBytes = Number(takeValue(argv, ++i, a));
    else if (a === "--max-chars") args.maxChars = Number(takeValue(argv, ++i, a));
    else if (a === "--no-clipboard") args.clipboard = false;
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
      "  pack:  encode the workspace (folder structure + every text file) into one .txt file",
      "         to upload to Copilot, and copy a kick-off message that teaches it the change format.",
      "  apply: decode the change set from Copilot's reply (clipboard by default, a file, or",
      "         stdin with -) and apply it to the workspace. Nothing is written unless every",
      "         change applies cleanly.",
      "",
      "pack options:",
      "  --cwd <dir>              workspace root (default: current directory)",
      "  -o, --output <path>      pack file (default: <workspace>/.coccopilot/<name>.pack.txt)",
      "  --exclude <glob>         leave matching files out (repeatable; \"dir/\" for a directory)",
      "  --no-default-excludes    also inline lockfiles, minified bundles and source maps",
      `  --max-file-bytes <n>     list larger files without their content (default: ${DEFAULT_MAX_FILE_BYTES})`,
      "  --max-chars <n>          split the pack into parts of about n characters (default: one file)",
      "  --no-clipboard           don't copy the kick-off message",
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

function partPath(base: string, index: number, total: number): string {
  if (total === 1) return base;
  return base.replace(/(\.txt)?$/i, (ext) => `.part${index}of${total}${ext || ".txt"}`);
}

/** The message pasted into the chat with the uploaded pack. */
export function kickoffMessage(fileNames: string[], instructions: string, task: string): string {
  const files = fileNames.map((f) => `"${f}"`).join(", ");
  return [
    `I've attached ${files}: a plain-text snapshot of my repository. It starts with the folder structure,`,
    `then holds every text file between "@@@ FILE <path>" and "@@@ END <path>" lines.`,
    "Please read it as the current state of my code.",
    "",
    INSTRUCTIONS_OPEN,
    instructions.trim(),
    INSTRUCTIONS_CLOSE,
    "",
    task ? `My task: ${task}` : "Wait for my task.",
  ].join("\n");
}

export async function runPack(args: PackArgs): Promise<void> {
  const root = resolve(args.cwd ?? process.cwd());
  const instructions = await loadPrompt("pack.md");
  const output = args.output ? resolve(args.output) : undefined;

  const pack = await buildPack({
    root,
    exclude: args.exclude,
    defaultExcludes: args.defaultExcludes,
    maxFileBytes: args.maxFileBytes,
    maxChars: args.maxChars,
    skipPaths: output ? [output] : [],
    instructions,
  });

  const total = pack.parts.length;
  const base = output ?? join(root, CACHE_DIRNAME, `${pack.name}.pack.txt`);
  const paths = pack.parts.map((_, i) => partPath(base, i + 1, total));
  await mkdir(dirname(base), { recursive: true });
  // Keep the default location out of the packed project's git history.
  if (!output) await writeFile(join(root, CACHE_DIRNAME, ".gitignore"), "*\n", "utf8").catch(() => undefined);
  for (let i = 0; i < total; i++) await writeFile(paths[i], pack.parts[i], "utf8");

  const included = pack.entries.filter((e) => e.content !== undefined).length;
  const chars = pack.parts.reduce((n, p) => n + p.length, 0);
  log(`packed ${included} file(s) from ${root} (${chars} chars, ~${Math.round(chars / 4)} tokens)`);
  for (const e of pack.entries.filter((e) => e.skipped)) log(`  listed only: ${e.path} (${e.skipped})`);
  for (const p of paths) log(`wrote ${p}`);

  const message = kickoffMessage(paths.map((p) => basename(p)), instructions, args.task);
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
