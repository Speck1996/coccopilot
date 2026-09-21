import type { ToolRegistry } from "../tools/registry.js";
import type { ToolCall, ToolContext, ToolResult } from "../tools/types.js";
import { frameToolResults } from "./prompt.js";
import { agentVocabulary, type Vocabulary } from "./vocabulary.js";

export interface ExecuteOptions {
  registry: ToolRegistry;
  ctx: ToolContext;
  log: (msg: string) => void;
  /** Observe each tool call as it is about to execute, then again with its result. */
  onToolCall?: (call: ToolCall, result?: ToolResult) => void;
  /** Vocabulary used to frame results for the model. Defaults to the agent identity. */
  vocabulary?: Vocabulary;
}

/** Run a batch of tool calls in order and collect their results. */
export async function executeToolCalls(calls: ToolCall[], opts: ExecuteOptions): Promise<ToolResult[]> {
  const results: ToolResult[] = [];
  for (const call of calls) {
    opts.log(`tool: ${call.tool} ${JSON.stringify(call.args)}`);
    opts.onToolCall?.(call);
    const result = await opts.registry.execute(call, opts.ctx);
    opts.onToolCall?.(call, result);
    opts.log(`result: ${result.ok ? "ok" : "error"} — ${result.summary}`);
    results.push(result);
  }
  return results;
}

/** Run a batch and frame the results as the next message to the model. */
export async function executeAndFrame(calls: ToolCall[], opts: ExecuteOptions): Promise<string> {
  return frameToolResults(await executeToolCalls(calls, opts), opts.vocabulary ?? agentVocabulary);
}
