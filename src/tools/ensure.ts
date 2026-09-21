import { spawn } from "node:child_process";
import type { Tool } from "./types.js";
import { detect, findSpec, installCommand, TOOL_SPECS } from "./toolchain.js";

const MAX_OUTPUT_CHARS = 20_000;

interface InstallOutcome {
  code: number | null;
  output: string;
}

function runInstall(command: string, cwd: string, timeoutMs: number): Promise<InstallOutcome> {
  return new Promise((resolve) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      env: { ...process.env, CI: process.env.CI ?? "1", NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    const grab = (b: Buffer) => {
      output += b.toString("utf8");
      if (output.length > MAX_OUTPUT_CHARS * 2) output = output.slice(-MAX_OUTPUT_CHARS);
    };
    child.stdout?.on("data", grab);
    child.stderr?.on("data", grab);
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: null, output: `${output}\n[spawn error] ${err.message}` });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, output });
    });
  });
}

export const ensureToolTool: Tool = {
  name: "ensure_tool",
  description:
    "Check whether a developer tool (e.g. pytest, pyspark, python, git, npm, docker) is installed, " +
    "and install it if missing. Installs run through the workspace command policy: routine package " +
    "managers run directly, while system installs (e.g. brew, apt with sudo) require approval. " +
    "Use this when a command fails with 'command not found' (exit 127) instead of giving up.",
  signature:
    "ensure_tool(name: string, install?: boolean) — name is one of: " +
    TOOL_SPECS.map((s) => s.name).join(", ") +
    "; set install:false to only check",
  async run(call, ctx) {
    const name = call.args.name;
    if (typeof name !== "string" || name.trim().length === 0) {
      return {
        ok: false,
        summary: "ensure_tool: missing 'name' argument",
        detail: `Known tools: ${TOOL_SPECS.map((s) => s.name).join(", ")}`,
      };
    }

    const spec = findSpec(name);
    if (!spec) {
      return {
        ok: false,
        summary: `ensure_tool: unknown tool "${name}"`,
        detail: `Known tools: ${TOOL_SPECS.map((s) => s.name).join(", ")}`,
      };
    }

    const before = await detect(spec);
    if (before.found) {
      return {
        ok: true,
        summary: `ensure_tool: ${spec.name} is installed${before.version ? ` (${before.version})` : ""}`,
        detail: `path: ${before.path ?? before.binary}`,
      };
    }

    const wantsInstall = call.args.install !== false;
    const command = installCommand(spec);
    if (!wantsInstall) {
      return {
        ok: false,
        summary: `ensure_tool: ${spec.name} is not installed`,
        detail: command
          ? `Install command: ${command}`
          : `No install command is known for this platform. Install ${spec.name} manually.`,
      };
    }
    if (!command) {
      return {
        ok: false,
        summary: `ensure_tool: no install command for ${spec.name} on this platform`,
        detail: spec.note ?? "Install it manually and retry.",
      };
    }

    const decision = ctx.policy.evaluate(command);
    if (!decision.allowed) {
      return {
        ok: false,
        summary: `ensure_tool: install blocked by policy (${decision.reason})`,
        detail: `command: ${command}`,
      };
    }
    if (decision.requiresApproval) {
      const approved = await ctx.approver.confirm(command, `installing missing tool: ${spec.name}`);
      if (!approved) {
        return {
          ok: false,
          summary: `ensure_tool: install of ${spec.name} denied by user`,
          detail: `command: ${command}`,
        };
      }
    }

    const timeoutMs = ctx.policy.clampTimeout(180_000);
    ctx.log(`$ ${command}  (installing ${spec.name}, timeout=${timeoutMs}ms)`);
    const outcome = await runInstall(command, ctx.workspace.root, timeoutMs);
    const body = outcome.output.trim();
    const detail = body.length > MAX_OUTPUT_CHARS ? `…[truncated]\n${body.slice(-MAX_OUTPUT_CHARS)}` : body;

    if (outcome.code !== 0) {
      return {
        ok: false,
        summary: `ensure_tool: install of ${spec.name} failed (exit ${outcome.code ?? "?"})`,
        detail: `${detail}\n\ncommand: ${command}${spec.note ? `\nnote: ${spec.note}` : ""}`,
      };
    }

    const after = await detect(spec);
    if (after.found) {
      return {
        ok: true,
        summary: `ensure_tool: installed ${spec.name}${after.version ? ` (${after.version})` : ""}`,
        detail: `path: ${after.path ?? after.binary}\n\n${detail}`.trim(),
      };
    }

    return {
      ok: false,
      summary: `ensure_tool: install of ${spec.name} finished but it is still not on PATH`,
      detail:
        `${detail}\n\ncommand: ${command}` +
        (spec.note ? `\nnote: ${spec.note}` : "") +
        "\nIt may need a new shell or a PATH update before the binary is visible.",
    };
  },
};
