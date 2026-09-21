#!/usr/bin/env node
import { spawn } from "node:child_process";
import { loadConfig, type Config, DEFAULT_WEBAPP_URL, DEFAULT_SENTINEL } from "./config.js";
import { Workspace } from "./sandbox/workspace.js";
import { DefaultCommandPolicy, type Approver, type InputRequest } from "./sandbox/policy.js";
import { defaultRegistry } from "./tools/registry.js";
import { detectAll, findSpec, installCommand, TOOL_SPECS } from "./tools/toolchain.js";
import { detectClipboard } from "./human/clipboard.js";
import { HumanTerminal } from "./human/terminal.js";
import { createChannel, type CopilotChannel } from "./human/channel.js";
import { runBridge } from "./agent/bridge.js";

interface CliArgs {
  task: string;
  cwd?: string;
  webapp?: string;
  maxTurns?: number;
  maxContinuations?: number;
  yes: boolean;
  continueSession: boolean;
  dryRun: boolean;
  noCodeInterpreter: boolean;
  persona: "agent" | "notation";
  injectPrimer: boolean;
  clipboard: boolean;
  sentinel?: string;
}

function parseArgs(argv: string[]): CliArgs {
  const positionals: string[] = [];
  let cwd: string | undefined;
  let webapp: string | undefined;
  let maxTurns: number | undefined;
  let maxContinuations: number | undefined;
  let yes = false;
  let continueSession = false;
  let dryRun = false;
  let noCodeInterpreter = false;
  let persona: CliArgs["persona"] = "agent";
  let injectPrimer = true;
  let clipboard = true;
  let sentinel: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--cwd") cwd = argv[++i];
    else if (arg === "--webapp") webapp = argv[++i];
    else if (arg === "--max-turns") maxTurns = Number(argv[++i]);
    else if (arg === "--continuations") maxContinuations = Number(argv[++i]);
    else if (arg === "--dry-run") dryRun = true;
    else if (arg === "--no-code-interpreter") noCodeInterpreter = true;
    else if (arg === "--no-primer") injectPrimer = false;
    else if (arg === "--no-clipboard") clipboard = false;
    else if (arg === "--sentinel") sentinel = argv[++i];
    else if (arg === "--persona") persona = argv[++i] as CliArgs["persona"];
    else if (arg === "--yes" || arg === "-y") yes = true;
    else if (arg === "--continue" || arg === "-c") continueSession = true;
    else if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    } else if (arg.startsWith("--")) throw new Error(`unknown flag: ${arg}`);
    else positionals.push(arg);
  }

  const task = positionals.join(" ").trim();
  return {
    task,
    cwd,
    webapp,
    maxTurns,
    maxContinuations,
    yes,
    continueSession,
    dryRun,
    noCodeInterpreter,
    persona,
    injectPrimer,
    clipboard,
    sentinel,
  };
}

function printUsage(): void {
  console.error(
    [
      'usage: coccopilot [options] ["<optional first task>"]',
      "       coccopilot doctor | install <tool> | install --all",
      "",
      "  Runs a human-operated bridge: it renders each message for you to paste into",
      "  the Copilot webapp, reads back the reply you bring (via the clipboard), and",
      "  executes the `coccopilot` tool blocks it contains against your workspace.",
      "  coccopilot drives no browser, sends no synthetic input, and scrapes no transport.",
      "",
      "options:",
      "  --cwd <dir>            workspace root (default: current directory)",
      "  --webapp <url>         Copilot webapp URL shown in the hand-off (default: copilot.microsoft.com)",
      "  --no-clipboard         paste replies into the terminal instead of using the clipboard",
      "  --sentinel <text>      line that ends a manual paste (default: " + DEFAULT_SENTINEL + ")",
      "  --max-turns <n>        steps per continuation (default: 25)",
      "  --continuations <n>    times the step budget may be extended before sealing (default: 5)",
      "  --dry-run              probe the clipboard and print the hand-off mode; send nothing",
      "  --no-code-interpreter  add prompt framing forbidding the built-in Code Interpreter",
      "  --no-primer            skip priming (assumes the thread already has the protocol)",
      "  --persona <name>       agent | notation (default: agent)",
      "  -y, --yes              auto-approve non-routine shell commands",
      "  -c, --continue         continue the previous conversation instead of priming fresh",
      "  -h, --help             show this help",
      "",
      "commands:",
      "  doctor                 check for required/external tools and show install hints",
      "  install <tool>         install a known tool (pytest, pyspark, python, git, …)",
      "  install --all          install every known tool that is missing",
    ].join("\n"),
  );
}

const TERMINAL_PROMPT_TIMEOUT_MS = 300_000;

/**
 * Ask a single question on the shared terminal with a timeout. Resolves undefined if
 * stdin is not a TTY or no answer arrives in time, so the caller never blocks forever.
 */
async function askTerminal(
  terminal: HumanTerminal,
  question: string,
  timeoutMs = TERMINAL_PROMPT_TIMEOUT_MS,
): Promise<string | undefined> {
  if (!terminal.interactive) return Promise.resolve(undefined);
  process.stdout.write(question);
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => {
      console.log("\n[coccopilot] no answer in time; continuing without approval");
      resolve(undefined);
    }, timeoutMs);
  });
  const answer = await Promise.race([terminal.nextLine(), timeout]);
  if (timer) clearTimeout(timer);
  return answer;
}

function makeApprover(terminal: HumanTerminal, autoApprove: boolean): Approver {
  if (autoApprove) {
    return {
      async confirm(command) {
        console.log(`[coccopilot] auto-approved: ${command}`);
        return true;
      },
      async provideInput() {
        return "y";
      },
    };
  }
  return {
    async confirm(command, reason) {
      const answer = await askTerminal(
        terminal,
        `\n[coccopilot] run this command? (${reason})\n  $ ${command}\n  [y/N] `,
      );
      return /^y(es)?$/i.test((answer ?? "").trim());
    },
    async provideInput(req: InputRequest) {
      if (req.secret) {
        console.log("[coccopilot] refusing to answer a credential prompt on the terminal");
        return undefined;
      }
      const answer = await askTerminal(terminal, `\n[coccopilot] a command is asking: ${req.prompt}\n  > `);
      return answer === undefined ? undefined : answer.replace(/\r?\n/g, " ").trim();
    },
  };
}

async function runDryRun(config: Config, log: (msg: string) => void): Promise<void> {
  log("dry-run: checking the human hand-off path (nothing will be sent)");
  const clipboard = await detectClipboard(log);
  const mode = clipboard
    ? `clipboard (${clipboard.description})`
    : config.clipboard
      ? "manual paste — no clipboard backend detected"
      : "manual paste (--no-clipboard)";

  log(`dry-run: webapp      — ${config.webappUrl}`);
  log(`dry-run: workspace   — ${config.workspace}`);
  log(`dry-run: reply input — ${mode}`);
  if (!clipboard && config.clipboard) {
    log("dry-run: INFO install a clipboard tool (wl-clipboard, xclip, or xsel on Linux) to enable clipboard mode");
  }
  log("dry-run: hand-off path looks ready");
}

function printDoctorUsage(): void {
  console.error(
    [
      "usage:",
      "  coccopilot doctor              check for required/external tools and show install hints",
      "  coccopilot install <tool>      install a known tool",
      "  coccopilot install --all       install every known tool that is missing",
      "",
      "known tools: " + TOOL_SPECS.map((s) => s.name).join(", "),
    ].join("\n"),
  );
}

async function runDoctor(): Promise<void> {
  console.log("[coccopilot] checking toolchain");
  const statuses = await detectAll();
  for (const s of statuses) {
    const spec = s.spec;
    if (s.found) {
      console.log(`  ok    ${spec.name.padEnd(9)} ${s.version ?? ""} (${s.path ?? s.binary})`);
    } else {
      const cmd = installCommand(spec);
      console.log(`  MISS  ${spec.name.padEnd(9)} not found${cmd ? ` — install: ${cmd}` : ""}`);
    }
    if (s.spec.note && !s.found) console.log(`        note: ${s.spec.note}`);
  }
  const missing = statuses.filter((s) => !s.found).length;
  console.log(
    missing === 0
      ? "[coccopilot] all known tools are present"
      : `[coccopilot] ${missing} tool(s) missing — run: coccopilot install <tool>`,
  );
}

async function runInstall(rest: string[], autoApprove: boolean): Promise<void> {
  const positional = rest.filter((a) => !a.startsWith("-"));
  const all = rest.includes("--all") || positional.length === 0;
  const policy = new DefaultCommandPolicy();
  const terminal = new HumanTerminal();
  const approver = makeApprover(terminal, autoApprove);

  try {
    const statuses = await detectAll();
    const targets = all ? TOOL_SPECS : positional.map((n) => findSpec(n));
    for (const spec of targets) {
      if (!spec) {
        console.log(`[coccopilot] unknown tool: ${positional.find((n) => !findSpec(n))}`);
        continue;
      }
      const status = statuses.find((s) => s.spec === spec);
      if (status?.found) {
        console.log(`[coccopilot] ${spec.name} already installed${status.version ? ` (${status.version})` : ""}`);
        continue;
      }
      const command = installCommand(spec);
      if (!command) {
        console.log(`[coccopilot] no install command for ${spec.name} on this platform`);
        continue;
      }
      const decision = policy.evaluate(command);
      if (!decision.allowed) {
        console.log(`[coccopilot] ${spec.name}: blocked by policy (${decision.reason})`);
        continue;
      }
      if (decision.requiresApproval && !(await approver.confirm(command, `installing ${spec.name}`))) {
        console.log(`[coccopilot] ${spec.name}: install denied`);
        continue;
      }
      console.log(`[coccopilot] installing ${spec.name}: ${command}`);
      const code = await new Promise<number | null>((resolve) => {
        const child = spawn(command, { shell: true, stdio: "inherit", env: { ...process.env, CI: process.env.CI ?? "1" } });
        child.on("error", () => resolve(null));
        child.on("close", (c) => resolve(c));
      });
      console.log(
        code === 0
          ? `[coccopilot] ${spec.name} install finished`
          : `[coccopilot] ${spec.name} install failed (exit ${code ?? "?"})`,
      );
    }
  } finally {
    terminal.close();
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv[0] === "doctor") {
    await runDoctor();
    return;
  }
  if (argv[0] === "install") {
    const rest = argv.slice(1);
    if (rest.includes("--help") || rest.includes("-h")) {
      printDoctorUsage();
      return;
    }
    await runInstall(rest, argv.includes("--yes") || argv.includes("-y"));
    return;
  }

  const args = parseArgs(argv);
  const config = loadConfig({
    workspace: args.cwd,
    webappUrl: args.webapp,
    maxTurns: args.maxTurns,
    maxContinuations: args.maxContinuations,
    autoApprove: args.yes,
    continueSession: args.continueSession,
    noCodeInterpreter: args.noCodeInterpreter,
    persona: args.persona,
    clipboard: args.clipboard,
    sentinel: args.sentinel,
  });

  const log = (msg: string) => console.log(`[coccopilot] ${msg}`);
  log(`webapp:    ${config.webappUrl}`);
  log(`workspace: ${config.workspace}`);
  log(`session:   ${config.continueSession ? "continue previous" : "fresh"}`);

  const workspace = new Workspace(config.workspace);
  const registry = defaultRegistry();
  const policy = new DefaultCommandPolicy();

  if (args.dryRun) {
    await runDryRun(config, log);
    return;
  }

  const terminal = new HumanTerminal();
  const approver = makeApprover(terminal, config.autoApprove);
  const { channel, description } = await createChannel({
    webappUrl: config.webappUrl,
    sentinel: config.sentinel,
    forceManual: !config.clipboard,
    terminal,
    log,
  });
  log(`reply input: ${description}`);

  let bridge: ReturnType<typeof runBridge> | undefined;
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`${signal} received; shutting down`);
    bridge?.stop();
    terminal.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  try {
    bridge = runBridge({
      task: args.task || undefined,
      channel: channel as CopilotChannel,
      registry,
      workspace,
      policy,
      approver,
      maxTurns: config.maxTurns,
      maxContinuations: config.maxContinuations,
      noCodeInterpreter: config.noCodeInterpreter,
      persona: config.persona,
      injectPrimer: args.injectPrimer && !config.continueSession,
      log,
    });

    log("human bridge running — follow the clipboard hand-off prompts (Ctrl-C to exit)");
    await bridge.wait();
  } finally {
    bridge?.stop();
    terminal.close();
  }
}

main().catch((err) => {
  console.error(`[coccopilot] fatal: ${(err as Error).message}`);
  process.exitCode = 1;
});
