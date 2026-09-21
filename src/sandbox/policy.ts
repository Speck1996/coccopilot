import type { Workspace } from "./workspace.js";

export interface PolicyDecision {
  allowed: boolean;
  /** If not allowed, why. */
  reason?: string;
  /** If allowed, whether the user must confirm before it runs. */
  requiresApproval: boolean;
}

export interface CommandPolicy {
  /** Clamp a requested timeout to the policy ceiling. */
  clampTimeout(requestedMs: number | undefined): number;
  /** Decide whether a command may run. */
  evaluate(command: string): PolicyDecision;
}

/** A child process is blocked waiting for input on stdin. */
export interface InputRequest {
  /** The command that is asking. */
  command: string;
  /** The prompt text observed on the process's output. */
  prompt: string;
  /** True for credential prompts (password/token), which must never be routed. */
  secret: boolean;
}

export interface Approver {
  /** Ask the user to approve a command. Returns true if allowed to run. */
  confirm(command: string, reason: string): Promise<boolean>;
  /**
   * Ask the user to answer an interactive prompt from a running command.
   * Returns the text to write (a newline is appended), or undefined to abort.
   * Optional: approvers that do not support live input leave this undefined.
   */
  provideInput?(req: InputRequest): Promise<string | undefined>;
}

/** Always-approve approver, used with --yes. */
export const autoApprover: Approver = {
  async confirm() {
    return true;
  },
  async provideInput() {
    // With --yes the operator has opted out of prompts; answer affirmative so
    // installers/confirmations proceed without blocking.
    return "y";
  },
};

export const autoDenyApprover: Approver = {
  async confirm() {
    return false;
  },
  async provideInput() {
    return undefined;
  },
};

interface DenyRule {
  pattern: RegExp;
  reason: string;
}

/**
 * Catastrophic / clearly-abusive commands. Not a security boundary — a speed bump.
 * The real boundary is the workspace root plus user confirmation.
 */
const DENY_RULES: DenyRule[] = [
  { pattern: /\brm\b[^\n;&|]*\s\/(\s|$|\*)/i, reason: "delete targeting filesystem root" },
  { pattern: /\brm\b[^\n;&|]*\s(~|\$HOME)(\/|\s|$)/i, reason: "delete targeting the home directory" },
  { pattern: /\brm\b[^\n;&|]*\s\/(etc|usr|bin|boot|dev|var|lib)\b/i, reason: "delete targeting a system directory" },
  { pattern: /:\(\)\s*\{.*\};\s*:/, reason: "fork bomb" },
  { pattern: /\bmkfs(\.\w+)?\b/i, reason: "filesystem format" },
  { pattern: /\bdd\b[^\n]*\bof=\/dev\//i, reason: "raw write to a device" },
  { pattern: />\s*\/dev\/(sd|nvme|vd|hd)/i, reason: "write to a raw disk" },
  { pattern: /\b(curl|wget)\b[^\n|]*\|\s*(sudo\s+)?(ba|z|k)?sh\b/i, reason: "piping a download into a shell" },
  { pattern: /\bchmod\s+(-[a-z]+\s+)*777\s+\/(\s|$)/i, reason: "chmod 777 on /" },
  { pattern: /\b(shutdown|reboot|halt|poweroff)\b/i, reason: "host power control" },
  { pattern: /\bkill(all)?\s+-9\s+-1\b/i, reason: "killing all processes" },
  { pattern: /\bsudo\b/i, reason: "privilege escalation" },
];

/**
 * Commands we treat as routine (no confirmation). Everything else is confirmed.
 * This keeps the confirm prompt meaningful instead of firing on every `npm test`.
 */
const AUTO_OK = /^\s*(npm|npx|pnpm|yarn|node|python3?|pip3?|pytest|cargo|go|make|tsc|eslint|prettier|git|ls|cat|head|tail|wc|diff|tree|find|grep|rg|mkdir|touch|cp|mv|rm|echo|pwd|true|false|test)\b/;

export class DefaultCommandPolicy implements CommandPolicy {
  private readonly maxTimeoutMs: number;

  constructor(opts: { maxTimeoutMs?: number } = {}) {
    this.maxTimeoutMs = opts.maxTimeoutMs ?? 120_000;
  }

  clampTimeout(requestedMs: number | undefined): number {
    const requested = Number.isFinite(requestedMs) && (requestedMs as number) > 0 ? (requestedMs as number) : 60_000;
    return Math.min(requested, this.maxTimeoutMs);
  }

  evaluate(command: string): PolicyDecision {
    const trimmed = command.trim();
    if (!trimmed) {
      return { allowed: false, reason: "empty command", requiresApproval: false };
    }
    for (const rule of DENY_RULES) {
      if (rule.pattern.test(trimmed)) {
        return { allowed: false, reason: `blocked by policy: ${rule.reason}`, requiresApproval: false };
      }
    }
    return { allowed: true, requiresApproval: !AUTO_OK.test(trimmed) };
  }
}

/** Convenience: is a resolved path inside the workspace root? */
export function assertInsideWorkspace(workspace: Workspace, abs: string): void {
  workspace.resolveInside(abs);
}
