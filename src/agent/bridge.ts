import type { ToolRegistry } from "../tools/registry.js";
import type { ToolCall, ToolContext, ToolResult } from "../tools/types.js";
import type { Workspace } from "../sandbox/workspace.js";
import type { Approver, CommandPolicy } from "../sandbox/policy.js";
import type { CopilotChannel } from "../human/channel.js";
import { parseAssistant } from "./protocol.js";
import { executeToolCalls } from "./executor.js";
import {
  loadSystemPrompt,
  wrapUserTask,
  frameToolResults,
  donePrompt,
  continuePrompt,
  refusalNudge,
  noToolNudge,
  driftNudge,
  classifyReply,
  missedCallSummary,
  malformedSummary,
  malformedDetail,
  reprimePrompt,
  standbyMessage,
  idlePrimer,
  renderRegister,
  type Persona,
} from "./prompt.js";
import { vocabularyFor, type Vocabulary } from "./vocabulary.js";
import { detectDrift } from "./drift.js";

export interface BridgeOptions {
  /** Optional task to seed the first turn; when omitted the session opens idle. */
  task?: string;
  /** Human-in-the-loop transport to the Copilot webapp. */
  channel: CopilotChannel;
  registry: ToolRegistry;
  workspace: Workspace;
  policy: CommandPolicy;
  /** Approver for non-routine commands and interactive command prompts. */
  approver: Approver;
  /** Steps per continuation before coccopilot asks the model to continue or finish. */
  maxTurns: number;
  /** How many times the step budget may be extended before forcing the done block. */
  maxContinuations: number;
  log: (msg: string) => void;
  /** Observe each tool call as it is about to run, then again with its result. */
  onToolCall?: (call: ToolCall, result?: ToolResult) => void;
  /** Prime a fresh conversation with the protocol before going idle. */
  injectPrimer?: boolean;
  noCodeInterpreter?: boolean;
  persona?: Persona;
}

export interface Bridge {
  /** Stop the loop and resolve `wait`. */
  stop(): void;
  /** Resolves once the bridge has stopped. */
  wait(): Promise<void>;
}

type State = "priming" | "idle" | "working";

const MAX_NUDGES = 2;
const MARKER = "[coccopilot]";
const RULE = "─".repeat(64);

/**
 * Human-operated bridge. coccopilot does not touch the browser: it renders each
 * outgoing message for the operator to paste into the Copilot webapp, reads back the
 * reply the operator brings, executes any `coccopilot` tool blocks it contains, and
 * renders the framed results for the next paste. The loop is synchronous — every turn
 * is a deliberate operator action.
 */
export function runBridge(opts: BridgeOptions): Bridge {
  const { channel, registry, workspace, policy, maxTurns, maxContinuations, log } = opts;
  const persona = opts.persona ?? "agent";
  const vocabulary: Vocabulary = vocabularyFor(persona);

  let state: State = "priming";
  let taskTurns = 0;
  let continuations = 0;
  let nudges = 0;
  let reprimed = false;
  let systemPrompt = "";
  let stopped = false;
  let resolveWait: () => void = () => {};
  const waitPromise = new Promise<void>((r) => (resolveWait = r));

  const ctx: ToolContext = { workspace, policy, approver: opts.approver, log };

  /** Render an outgoing message for the operator (splitting is the channel's job). */
  async function dispatch(text: string): Promise<void> {
    await channel.send(`${MARKER} ${text}`);
  }

  async function post(message: string): Promise<void> {
    await dispatch(message);
  }

  async function runCalls(calls: ReturnType<typeof parseAssistant>["calls"]): Promise<void> {
    const results = await executeToolCalls(calls, {
      registry,
      ctx,
      log,
      vocabulary,
      onToolCall: opts.onToolCall,
    });
    await post(frameToolResults(results, vocabulary));
  }

  /** Compact progress line shown beside the reply input prompt. */
  function statusLine(): string {
    if (state === "priming") return "priming · waiting for the protocol acknowledgement";
    if (state === "idle") return "idle · waiting for a task";
    return `working · step ${taskTurns + 1}/${maxTurns}`;
  }

  /** Update the progress line immediately (not only at the next input prompt). */
  function refreshStatus(): void {
    channel.report?.(statusLine());
  }

  async function handleReply(raw: string): Promise<void> {
    const parsed = parseAssistant(raw, vocabulary);
    if (parsed.text) log(`copilot: ${truncate(parsed.text, 600)}`);

    const executable = parsed.calls.filter((c) => c.tool !== "done");
    const doneCall = parsed.calls.find((c) => c.tool === "done");

    if (parsed.parseError) {
      // A malformed tool block is a clear signal Copilot tried to act, even while
      // idle, so correct it regardless of state.
      log(`protocol: ${parsed.parseError}`);
      await post(
        frameToolResults(
          [
            {
              ok: false,
              summary: malformedSummary(persona),
              detail: malformedDetail(persona, parsed.parseError),
            },
          ],
          vocabulary,
        ),
      );
      return;
    }

    if (state === "idle") {
      // The operator owns the chat while idle. Only act on an actual tool request;
      // ordinary prose is left alone so casual conversation isn't interrupted.
      if (executable.length === 0) {
        if (parsed.text) log("idle: assistant reply used no coccopilot block; leaving it alone");
        return;
      }
      log("idle: tool request detected; starting a task");
      state = "working";
      startTask();
      await runCalls(executable);
      if (doneCall) finishTask(doneCall.args.summary);
      else await extendIfNeeded();
      return;
    }

    if (state === "priming") {
      if (executable.length === 0) {
        log("primed: protocol acknowledged; now idle — hand in a task");
        state = "idle";
        return;
      }
      // Copilot acted on the primer itself; run it and keep waiting for the ack.
      await runCalls(executable);
      return;
    }

    // state === "working": reacting to our own injected results.
    if (executable.length > 0) {
      taskTurns++;
      await runCalls(executable);
      if (doneCall) finishTask(doneCall.args.summary);
      else await extendIfNeeded();
      return;
    }

    if (doneCall) {
      finishTask(doneCall.args.summary);
      return;
    }

    // No tool call while we asked for one: nudge, re-prime, then stand by.
    // Drift is checked before refusal: a reply that reached for the built-in
    // interpreter is not a refusal, even though the refusal matcher also lists
    // those markers, and it needs the interpreter-specific corrective.
    const drifted = detectDrift(raw);
    const kind = classifyReply(parsed.text || raw);
    const refusal = !drifted && kind === "refusal";
    if (nudges < MAX_NUDGES) {
      nudges++;
      log(
        drifted
          ? `no tool call; built-in interpreter drift — nudging back to the protocol (${nudges}/${MAX_NUDGES})`
          : refusal
            ? `no tool call; protocol refusal — nudging (${nudges}/${MAX_NUDGES})`
            : `no tool call (${kind}) — nudging (${nudges}/${MAX_NUDGES})`,
      );
      await post(
        frameToolResults(
          [
            {
              ok: false,
              summary: missedCallSummary(persona),
              detail: drifted ? driftNudge(persona) : refusal ? refusalNudge(persona) : noToolNudge(persona),
            },
          ],
          vocabulary,
        ),
      );
      return;
    }

    // Nudges exhausted. A full re-prime is the strongest remaining recovery: it
    // restates the whole protocol in-context and hands over a concrete opener.
    if ((refusal || drifted) && !reprimed && systemPrompt) {
      reprimed = true;
      nudges = 0;
      log(
        drifted
          ? "interpreter drift persisted; re-priming the protocol once"
          : "refusal persisted; re-priming the protocol once",
      );
      await post(reprimePrompt(systemPrompt, workspace.root, persona));
      return;
    }

    log("no tool call after nudges; standing by");
    await post(standbyMessage(persona));
    state = "idle";
  }

  /** Reset per-task counters. */
  function startTask(): void {
    taskTurns = 0;
    continuations = 0;
    nudges = 0;
    reprimed = false;
  }

  /**
   * Extend the step budget rather than stopping, so the model keeps working. After
   * `maxContinuations` extensions, force the seal.
   */
  async function extendIfNeeded(): Promise<void> {
    if (taskTurns < maxTurns) return;
    taskTurns = 0;
    if (continuations < maxContinuations) {
      continuations++;
      log(`step budget reached; continuing (${continuations}/${maxContinuations})`);
      await post(continuePrompt(persona));
      return;
    }
    // Stay in "working": the model's done block must be handled, and a done emitted
    // while idle would just be left alone. If the model instead keeps working, it is
    // asked for the done block again.
    log(`step budget and continuations exhausted (${maxContinuations}); requesting the done block`);
    await post(donePrompt(persona));
  }

  function finishTask(summary: unknown): void {
    const text = typeof summary === "string" && summary.trim() ? summary : "(no summary)";
    log(`${RULE}\n${MARKER} task complete: ${text}\n${MARKER} standing by — hand in the next task, or Ctrl-C to exit.\n${RULE}`);
    state = "idle";
    taskTurns = 0;
    continuations = 0;
    nudges = 0;
    reprimed = false;
  }

  async function prime(): Promise<void> {
    // The register is rendered through the active vocabulary, so the notation persona
    // sees neutral routine names/descriptions instead of internal tool names.
    systemPrompt = await loadSystemPrompt(renderRegister(vocabulary, registry.all()), {
      noCodeInterpreter: opts.noCodeInterpreter,
      persona,
      interactive: true,
    });

    if (opts.injectPrimer === false) {
      if (opts.task) {
        log("primer disabled; sending only the task (assumes a primed thread)");
        state = "working";
        startTask();
        await dispatch(wrapUserTask(opts.task, workspace.root, persona));
      } else {
        log("primer disabled and no task given; starting idle (assumes a primed thread)");
        state = "idle";
      }
      return;
    }

    if (opts.task) {
      log("priming session and seeding the first task");
      state = "working";
      startTask();
      await dispatch(`${systemPrompt}\n\n---\n\n${wrapUserTask(opts.task, workspace.root, persona)}`);
      return;
    }

    log("priming session with the tool protocol; then you drive from Copilot");
    state = "priming";
    await dispatch(`${systemPrompt}\n\n---\n\n${idlePrimer(workspace.root, persona)}`);
  }

  async function loop(): Promise<void> {
    try {
      await prime();
      while (!stopped) {
        const reply = await channel.receive(statusLine());
        if (stopped) break;
        if (!reply.trim()) {
          log("no reply received; ending the session");
          break;
        }
        await handleReply(reply);
        refreshStatus();
      }
    } catch (err) {
      log(`bridge error: ${(err as Error).message}`);
    } finally {
      stopped = true;
      resolveWait();
    }
  }

  void loop();

  return {
    stop() {
      if (stopped) return;
      stopped = true;
      channel.close();
      resolveWait();
    },
    wait() {
      return waitPromise;
    },
  };
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}
