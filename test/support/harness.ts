import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Workspace } from "../../src/sandbox/workspace.js";
import { DefaultCommandPolicy, type Approver } from "../../src/sandbox/policy.js";
import { defaultRegistry } from "../../src/tools/registry.js";
import type { ToolCall, ToolResult } from "../../src/tools/types.js";
import { runBridge } from "../../src/agent/bridge.js";
import { TranscriptChannel } from "../../src/human/transcript.js";
import type { Persona } from "../../src/agent/prompt.js";
import type { TranscriptEntry } from "../../src/human/transcript.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const FIXTURES_DIR = resolve(__dirname, "..", "fixtures");

/**
 * A scripted "Copilot" for tests: replies are queued up front and handed back one
 * per turn, exactly as a real operator would carry them. A reply may be a literal
 * string or a function of the inbound harness message, so tests can react to what
 * the bridge actually sent. When the queue empties, the last reply repeats.
 */
export type ScriptedReply = string | ((inbound: string, turn: number) => string);

export class ScriptedChannel extends TranscriptChannel {
  readonly mode = "scripted" as unknown as "clipboard";
  private index = 0;

  constructor(private readonly replies: ScriptedReply[]) {
    super();
  }

  /** Number of replies actually handed back to the bridge. */
  get replyCount(): number {
    return this.index;
  }

  protected async nextReply(_status?: string): Promise<string> {
    if (this.index >= this.replies.length) return ""; // end the session
    const entry = this.replies[this.index];
    this.index++;
    if (typeof entry === "function") return entry(this.lastOutbound(), this.index - 1);
    return entry;
  }

  private lastOutbound(): string {
    for (let i = this.transcript.length - 1; i >= 0; i--) {
      if (this.transcript[i].direction === "out") return this.transcript[i].text;
    }
    return "";
  }
}

/** Format a tool call as a fenced `coccopilot` block, as Copilot would emit it. */
export function block(payload: Record<string, unknown>): string {
  return "```coccopilot\n" + JSON.stringify(payload) + "\n```";
}

/** A single tool call block. */
export function call(tool: string, args: Record<string, unknown> = {}): string {
  return block({ tool, args });
}

/** The done block. */
export function done(summary = "finished"): string {
  return block({ tool: "done", args: { summary } });
}

export interface SessionOptions {
  /** Copilot's replies, in order. */
  replies: ScriptedReply[];
  /** Workspace directory. Defaults to a fresh copy of the sample-project fixture. */
  workspaceDir?: string;
  /** Seed the first turn with this task. */
  task?: string;
  persona?: Persona;
  maxTurns?: number;
  maxContinuations?: number;
  /** Skip priming (assumes the thread already has the protocol). */
  injectPrimer?: boolean;
  /** Approve non-routine commands. Default: deny. */
  approve?: (command: string, reason: string) => boolean | Promise<boolean>;
  /** Auto-approve everything (equivalent to --yes). */
  autoApprove?: boolean;
}

export interface SessionResult {
  channel: ScriptedChannel;
  outbound: string[];
  inbound: string[];
  transcript: TranscriptEntry[];
  toolCalls: ToolCall[];
  toolResults: ToolResult[];
  approvals: { command: string; reason: string; approved: boolean }[];
  logs: string[];
  /** The final outbound message (the last thing handed to the operator). */
  last: string;
  /** Number of replies the scripted Copilot actually handed back. */
  replyCount: number;
}

/** Read a file from the session workspace. */
export async function readWorkspaceFile(dir: string, path: string): Promise<string> {
  return readFile(join(dir, path), "utf8");
}

/** Create a temp copy of a fixture project. Caller is responsible for cleanup. */
export async function workspaceFromFixture(name = "sample-project"): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "coccopilot-test-"));
  await cp(join(FIXTURES_DIR, name), dir, { recursive: true });
  return dir;
}

/** Create an empty temp workspace. */
export async function emptyWorkspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), "coccopilot-test-"));
}

export async function removeWorkspace(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

/**
 * Run the bridge to completion against a scripted Copilot and collect everything
 * that happened: the transcript, tool calls/results, approvals, and logs.
 */
export async function runSession(opts: SessionOptions): Promise<SessionResult> {
  const workspaceDir = opts.workspaceDir ?? (await workspaceFromFixture());
  const channel = new ScriptedChannel(opts.replies);
  const logs: string[] = [];
  const toolCalls: ToolCall[] = [];
  const toolResults: ToolResult[] = [];
  const approvals: SessionResult["approvals"] = [];

  const approver: Approver = {
    async confirm(command, reason) {
      const approved = opts.autoApprove ? true : ((await opts.approve?.(command, reason)) ?? false);
      approvals.push({ command, reason, approved });
      return approved;
    },
    async provideInput() {
      return undefined;
    },
  };

  // When these tests themselves run under `node --test`, NODE_TEST_CONTEXT is
  // inherited by the commands the bridge spawns, which makes a nested `node --test`
  // (e.g. `npm test` in a scenario) skip running. Clear it so subprocess commands
  // behave as they would for a real operator.
  const savedTestContext = process.env.NODE_TEST_CONTEXT;
  delete process.env.NODE_TEST_CONTEXT;
  try {
    const bridge = runBridge({
      task: opts.task,
      channel,
      registry: defaultRegistry(),
      workspace: new Workspace(workspaceDir),
      policy: new DefaultCommandPolicy(),
      approver,
      maxTurns: opts.maxTurns ?? 25,
      maxContinuations: opts.maxContinuations ?? 5,
      persona: opts.persona,
      injectPrimer: opts.injectPrimer,
      log: (m) => logs.push(m),
      onToolCall: (c, r) => {
        if (r === undefined) toolCalls.push(c);
        else toolResults.push(r);
      },
    });

    await bridge.wait();
  } finally {
    if (savedTestContext === undefined) delete process.env.NODE_TEST_CONTEXT;
    else process.env.NODE_TEST_CONTEXT = savedTestContext;
  }

  return {
    channel,
    outbound: channel.outbound,
    inbound: channel.inbound,
    transcript: channel.transcript,
    toolCalls,
    toolResults,
    approvals,
    logs,
    last: channel.outbound[channel.outbound.length - 1] ?? "",
    replyCount: channel.replyCount,
  };
}
