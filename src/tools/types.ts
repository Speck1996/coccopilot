export interface ToolCall {
  tool: string;
  args: Record<string, unknown>;
}

export interface ToolResult {
  ok: boolean;
  /** Short human/agent-readable summary of what happened. */
  summary: string;
  /** Optional structured/large payload to feed back to the model. */
  detail?: string;
  /** Terminal signal — the agent loop stops when this is set. */
  done?: boolean;
}

export interface ToolContext {
  workspace: import("../sandbox/workspace.js").Workspace;
  policy: import("../sandbox/policy.js").CommandPolicy;
  approver: import("../sandbox/policy.js").Approver;
  log: (msg: string) => void;
}

export interface Tool {
  name: string;
  description: string;
  /** One-line argument documentation injected into the system prompt. */
  signature: string;
  run(call: ToolCall, ctx: ToolContext): Promise<ToolResult>;
}
