import { spawn } from "node:child_process";
import type { Tool } from "./types.js";
import type { InputRequest } from "../sandbox/policy.js";

const MAX_OUTPUT_LINES = 200;
const MAX_OUTPUT_CHARS = 20_000;
/** How long the process must be silent before we consider it blocked on a prompt. */
const PROMPT_IDLE_MS = 1500;
/** Cap the number of interactive prompts handled for a single command. */
const MAX_PROMPTS = 5;

interface PromptEvent {
  prompt: string;
  answer?: string;
  secret: boolean;
}

interface RunOutcome {
  code: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  output: string;
  prompts: PromptEvent[];
  /** Set when a prompt could not be answered and the command was aborted. */
  inputError?: string;
}

/**
 * Output tails that look like a question awaiting an answer. Deliberately narrow:
 * we only fire when the process has gone idle, so a busy command emitting these
 * words mid-stream does not trigger it.
 */
const PROMPT_PATTERNS: RegExp[] = [
  /\[(y\/n|yes\/no|y\/N|Y\/n)\]\s*[:?]?\s*$/i,
  /\((y\/n|yes\/no|y\/N|Y\/n)\)\s*[:?]?\s*$/i,
  /\b(y\/n|yes\/no)\b\s*[:?]?\s*$/i,
  /\b(do you want to|are you sure|would you like to)\b[^\n]*\?/i,
  /\b(proceed|continue|overwrite|replace|install|confirm)\b[^\n]*\?\s*$/i,
  /\bpress (any key|enter|y)\b/i,
  /\bplease (confirm|enter|provide|type)\b[^\n]*[:?]?\s*$/i,
];

/** Credential prompts are never routed to the chat/terminal — abort instead. */
const SECRET_PATTERNS: RegExp[] = [
  /\bpassword\b/i,
  /\bpassphrase\b/i,
  /\bapi[-_ ]?key\b/i,
  /\b(access|secret|auth)[-_ ]?token\b/i,
  /\bclient[-_ ]?secret\b/i,
  /\busername\b/i,
  /\blogin\b/i,
];

function tail(text: string, n = 400): string {
  const trimmed = text.replace(/\s+$/, "");
  return trimmed.length > n ? trimmed.slice(trimmed.length - n) : trimmed;
}

function looksLikePrompt(output: string): string | undefined {
  const lastLine = output.replace(/\s+$/, "").split(/\r?\n/).pop() ?? "";
  if (!lastLine.trim()) return undefined;
  for (const re of PROMPT_PATTERNS) {
    if (re.test(lastLine)) return lastLine.trim();
  }
  return undefined;
}

/**
 * A credential prompt: the idle output tail names a secret and looks like it is
 * asking for it (ends with `:`/`?`, or says enter/provide/type). Narrower than a
 * bare keyword match so routine log lines mentioning "login" don't abort.
 */
function looksLikeSecret(output: string): string | undefined {
  const lastLine = output.replace(/\s+$/, "").split(/\r?\n/).pop() ?? "";
  const trimmed = lastLine.trim();
  if (!trimmed) return undefined;
  const asks = /[:?]\s*$/.test(trimmed) || /\b(enter|provide|type|input|supply)\b/i.test(trimmed);
  if (!asks) return undefined;
  return SECRET_PATTERNS.some((re) => re.test(trimmed)) ? trimmed : undefined;
}

function truncateOutput(text: string): string {
  let out = text;
  if (out.length > MAX_OUTPUT_CHARS) {
    out = `…[truncated]\n${out.slice(out.length - MAX_OUTPUT_CHARS)}`;
  }
  const lines = out.split(/\r?\n/);
  if (lines.length > MAX_OUTPUT_LINES) {
    out = `…[${lines.length - MAX_OUTPUT_LINES} earlier lines omitted]\n` + lines.slice(-MAX_OUTPUT_LINES).join("\n");
  }
  return out;
}

async function runShell(
  command: string,
  cwd: string,
  timeoutMs: number,
  approver?: { provideInput(req: InputRequest): Promise<string | undefined> },
  log?: (msg: string) => void,
): Promise<RunOutcome> {
  return new Promise((resolve) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      env: { ...process.env, CI: process.env.CI ?? "1", NO_COLOR: "1", GIT_PAGER: "cat", PAGER: "cat" },
      // stdin is a pipe (not ignored) so we can answer interactive prompts.
      stdio: ["pipe", "pipe", "pipe"],
    });

    let output = "";
    let timedOut = false;
    let settled = false;
    let awaitingInput = false;
    let idleTimer: NodeJS.Timeout | undefined;
    let handledPrompt = "";
    const prompts: PromptEvent[] = [];

    const onData = (buf: Buffer) => {
      output += buf.toString("utf8");
      // Bound memory during long-running commands.
      if (output.length > MAX_OUTPUT_CHARS * 4) output = output.slice(-MAX_OUTPUT_CHARS * 2);
      // Any new output resets the idle window and allows the next prompt to fire.
      handledPrompt = "";
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => void checkPrompt().catch(() => {}), PROMPT_IDLE_MS);
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);

    function finalize(outcome: Omit<RunOutcome, "output" | "prompts"> & { output?: string }): void {
      if (settled) return;
      settled = true;
      if (idleTimer) clearTimeout(idleTimer);
      clearTimeout(timer);
      resolve({
        code: outcome.code,
        signal: outcome.signal,
        timedOut: outcome.timedOut,
        output: outcome.output ?? output,
        prompts,
        inputError: outcome.inputError,
      });
    }

    async function checkPrompt(): Promise<void> {
      if (settled || awaitingInput || child.exitCode !== null || child.signalCode !== null) return;
      if (child.stdin?.destroyed || !child.stdin?.writable) return;
      // Credential prompts are checked first: they must never be routed, and a
      // bare "Password:" is not otherwise shaped like a y/n question.
      const secretPrompt = looksLikeSecret(output);
      if (secretPrompt && secretPrompt !== handledPrompt) {
        handledPrompt = secretPrompt;
        const secretEvent: PromptEvent = { prompt: secretPrompt, secret: true };
        prompts.push(secretEvent);
        log?.(`prompt: credential prompt detected — aborting (${secretPrompt})`);
        child.stdin.end();
        child.kill("SIGTERM");
        finalize({
          code: null,
          signal: "SIGTERM",
          timedOut: false,
          inputError:
            `the command asked for a credential (${secretPrompt}). coccopilot does not route ` +
            `secrets through the chat. Configure credentials out-of-band and retry.`,
        });
        return;
      }

      const prompt = looksLikePrompt(output);
      if (!prompt || prompt === handledPrompt) return;
      handledPrompt = prompt;

      if (!approver) {
        log?.(`prompt: command is waiting for input but no interactive approver is configured`);
        child.stdin.end();
        child.kill("SIGTERM");
        finalize({
          code: null,
          signal: "SIGTERM",
          timedOut: false,
          inputError: `the command is waiting for input (${prompt}) and cannot be answered in this mode.`,
        });
        return;
      }

      if (prompts.length >= MAX_PROMPTS) {
        child.stdin.end();
        child.kill("SIGTERM");
        finalize({
          code: null,
          signal: "SIGTERM",
          timedOut: false,
          inputError: `the command asked too many interactive questions (>${MAX_PROMPTS}).`,
        });
        return;
      }

      awaitingInput = true;
      const event: PromptEvent = { prompt, secret: false };
      prompts.push(event);
      let answer: string | undefined;
      try {
        answer = await approver.provideInput({ command, prompt, secret: false });
      } catch (err) {
        log?.(`prompt: input request failed (${(err as Error).message})`);
        answer = undefined;
      }
      awaitingInput = false;
      if (settled) return;

      if (answer === undefined) {
        log?.(`prompt: no answer for "${prompt}"; aborting command`);
        child.stdin.end();
        child.kill("SIGTERM");
        finalize({
          code: null,
          signal: "SIGTERM",
          timedOut: false,
          inputError: `the command was waiting for input (${prompt}) and no answer was given.`,
        });
        return;
      }

      event.answer = answer;
      log?.(`prompt: answered "${prompt}" with "${answer}"`);
      output += `\n${answer}\n`;
      try {
        child.stdin.write(answer + "\n");
      } catch (err) {
        log?.(`prompt: could not write answer (${(err as Error).message})`);
      }
    }

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.on("error", (err) => {
      if (idleTimer) clearTimeout(idleTimer);
      finalize({ code: null, signal: null, timedOut, output: `${output}\n[spawn error] ${err.message}` });
    });

    child.on("close", (code, signal) => {
      finalize({ code, signal, timedOut });
    });
  });
}

export const runCommandTool: Tool = {
  name: "run_command",
  description:
    "Run a shell command in the workspace root and return its exit code and combined stdout/stderr. " +
    "Use this for tests, type-checking, linting, builds, git, and installing dependencies. " +
    "If a command asks an interactive question (e.g. a y/n confirmation), coccopilot asks you for the " +
    "answer rather than letting it hang.",
  signature: "run_command(command: string, timeout_ms?: number) — runs in the workspace root",
  async run(call, ctx) {
    const command = call.args.command;
    if (typeof command !== "string" || command.trim().length === 0) {
      return { ok: false, summary: "run_command: missing 'command' argument" };
    }

    const decision = ctx.policy.evaluate(command);
    if (!decision.allowed) {
      return { ok: false, summary: `run_command: ${decision.reason}`, detail: `command: ${command}` };
    }

    if (decision.requiresApproval) {
      const approved = await ctx.approver.confirm(command, "command is not on the routine list");
      if (!approved) {
        return {
          ok: false,
          summary: "run_command: denied by user",
          detail: `The command was not approved:\n${command}`,
        };
      }
    }

    const requested = typeof call.args.timeout_ms === "number" ? call.args.timeout_ms : undefined;
    const timeoutMs = ctx.policy.clampTimeout(requested);
    ctx.log(`$ ${command}  (cwd=${ctx.workspace.root}, timeout=${timeoutMs}ms)`);

    const inputApprover = ctx.approver.provideInput
      ? { provideInput: (req: InputRequest) => ctx.approver.provideInput!(req) }
      : undefined;
    const outcome = await runShell(command, ctx.workspace.root, timeoutMs, inputApprover, ctx.log);

    if (outcome.inputError) {
      return {
        ok: false,
        summary: `run_command: interactive prompt could not be answered`,
        detail: `${outcome.inputError}\n\nObserved prompt: ${tail(outcome.output, 200)}`,
      };
    }

    const body = truncateOutput(outcome.output.trim());

    const status = outcome.timedOut
      ? `timed out after ${timeoutMs}ms`
      : outcome.code === 0
        ? "exit 0"
        : `exit ${outcome.code ?? `signal ${outcome.signal}`}`;

    let detail = body || "(no output)";
    if (outcome.code === 127) {
      detail +=
        "\n\nNote: exit 127 usually means the command was not found. " +
        "Use the ensure_tool tool to install missing tools (e.g. pytest, pyspark).";
    }

    return {
      ok: !outcome.timedOut && outcome.code === 0,
      summary: `run_command: ${status}`,
      detail,
    };
  },
};
