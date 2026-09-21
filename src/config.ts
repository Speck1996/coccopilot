import { resolve } from "node:path";

export interface Config {
  workspace: string;
  /** The Copilot webapp URL shown in the hand-off instructions. */
  webappUrl: string;
  /** Use the system clipboard for the reply hand-off when one is available. */
  clipboard: boolean;
  /** Manual-paste sentinel line. */
  sentinel: string;
  /**
   * Largest outgoing message (characters) handed over in a single paste. Messages
   * above this are split into numbered parts, because the Copilot composer rejects
   * an oversized paste. Zero disables splitting.
   */
  maxMessageChars: number;
  /** Steps per continuation before coccopilot asks the model to continue or finish. */
  maxTurns: number;
  /** How many times the per-task step budget may be extended. */
  maxContinuations: number;
  /** Auto-approve non-routine shell commands. */
  autoApprove: boolean;
  /** Continue the previous conversation instead of prime framing. */
  continueSession: boolean;
  /** Add prompt framing that discourages the built-in Code Interpreter. */
  noCodeInterpreter: boolean;
  /** System prompt framing: direct `agent`, or the no-capability `notation` form. */
  persona: "agent" | "notation";
}

function bool(v: string | undefined, fallback: boolean): boolean {
  if (v === undefined) return fallback;
  return /^(1|true|yes|on)$/i.test(v);
}

function num(v: string | undefined, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Whole number that may legitimately be zero (e.g. "disable"). */
function numOrZero(v: string | undefined, fallback: number): number {
  if (v === undefined) return fallback;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export const DEFAULT_WEBAPP_URL = "https://copilot.microsoft.com/";
export const DEFAULT_SENTINEL = "<<<END>>>";
/**
 * Default paste budget, chosen to sit below where the Copilot composer starts
 * rejecting a paste but above the size of the priming message. A batched
 * `TOOL RESULT` frame routinely exceeds this and is split into parts.
 */
export const DEFAULT_MAX_MESSAGE_CHARS = 8000;

export function loadConfig(overrides: Partial<Config> = {}): Config {
  const env = process.env;

  const workspace = resolve(overrides.workspace ?? env.COCCOPILOT_WORKSPACE ?? process.cwd());

  return {
    workspace,
    webappUrl: overrides.webappUrl ?? env.COCCOPILOT_WEBAPP ?? DEFAULT_WEBAPP_URL,
    clipboard: overrides.clipboard ?? bool(env.COCCOPILOT_CLIPBOARD, true),
    sentinel: overrides.sentinel ?? env.COCCOPILOT_SENTINEL ?? DEFAULT_SENTINEL,
    maxMessageChars:
      (overrides.maxMessageChars !== undefined && Number.isFinite(overrides.maxMessageChars)
        ? overrides.maxMessageChars
        : undefined) ?? numOrZero(env.COCCOPILOT_MAX_MESSAGE_CHARS, DEFAULT_MAX_MESSAGE_CHARS),
    maxTurns: overrides.maxTurns ?? num(env.COCCOPILOT_MAX_TURNS, 25),
    maxContinuations: overrides.maxContinuations ?? num(env.COCCOPILOT_MAX_CONTINUATIONS, 5),
    autoApprove: overrides.autoApprove ?? bool(env.COCCOPILOT_YES, false),
    continueSession: overrides.continueSession ?? bool(env.COCCOPILOT_CONTINUE, false),
    noCodeInterpreter: overrides.noCodeInterpreter ?? bool(env.COCCOPILOT_NO_CODE_INTERPRETER, false),
    persona: overrides.persona ?? ((env.COCCOPILOT_PERSONA as Config["persona"]) || "agent"),
  };
}
