import type { Tool, ToolCall, ToolContext, ToolResult } from "./types.js";
import { writeFileTool, editFileTool, readFileTool, listDirTool, globTool, grepTool } from "./fs.js";
import { runCommandTool } from "./shell.js";
import { ensureToolTool } from "./ensure.js";

export class ToolRegistry {
  private tools = new Map<string, Tool>();

  constructor(tools: Tool[] = []) {
    for (const tool of tools) this.register(tool);
  }

  register(tool: Tool): void {
    this.tools.set(tool.name, tool);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  names(): string[] {
    return [...this.tools.keys()].sort();
  }

  /** All registered tools, in registration order. */
  all(): Tool[] {
    return [...this.tools.values()];
  }

  /** Description block injected into the system prompt. */
  describe(): string {
    return [...this.tools.values()]
      .map((t) => `- ${t.signature}\n  ${t.description}`)
      .join("\n");
  }

  async execute(call: ToolCall, ctx: ToolContext): Promise<ToolResult> {
    const tool = this.tools.get(call.tool);
    if (!tool) {
      return {
        ok: false,
        summary: `unknown tool "${call.tool}". Available: ${this.names().join(", ")}`,
      };
    }
    try {
      return await tool.run(call, ctx);
    } catch (err) {
      return { ok: false, summary: `${call.tool}: threw ${(err as Error).message}` };
    }
  }
}

export function defaultRegistry(): ToolRegistry {
  return new ToolRegistry([
    readFileTool,
    writeFileTool,
    editFileTool,
    listDirTool,
    globTool,
    grepTool,
    runCommandTool,
    ensureToolTool,
  ]);
}
