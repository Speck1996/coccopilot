import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ToolResult } from "../tools/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Locate the prompts directory across layouts:
 *   - dev (tsx):        <repo>/src/agent      -> <repo>/prompts
 *   - built-in-repo:    <repo>/dist/src/agent -> <repo>/prompts (via ../../..)
 *   - installed pkg:    <pkg>/dist/src/agent  -> <pkg>/prompts   (via ../../..)
 * The compiled `dist/src/agent` layout puts `prompts/` at the package root, three
 * levels up; `tsx` runs from `src/agent`, two levels up. Pick whichever exists.
 */
function resolvePromptsDir(): string {
  const candidates = [
    resolve(__dirname, "..", "..", "prompts"),
    resolve(__dirname, "..", "..", "..", "prompts"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return candidates[0];
}

const promptsDir = resolvePromptsDir();

/** Header used when framing results for the model. */
export const RESULT_LABEL = "TOOL RESULT";

/**
 * The single system prompt sent to Copilot. It is written in the operator's own voice
 * and describes coccopilot truthfully — Copilot writes blocks, a local program runs
 * them — so there is no capability claim for the chat product to refuse.
 */
export async function loadSystemPrompt(toolsBlock: string): Promise<string> {
  const template = await readFile(resolve(promptsDir, "agent.md"), "utf8");
  return template.replace("{{TOOLS}}", toolsBlock);
}

/** The JSON block that seeds a stalled session. */
export const OPENING_BLOCK = '```coccopilot\n{ "tool": "list_dir", "args": { "path": "." } }\n```';

/**
 * Continue framing used when the per-request turn budget is exhausted: push the model to
 * either take the next action or close out, without waiting for the operator.
 */
export const CONTINUE_PROMPT =
  "That's a lot of steps — please keep going: write the next `coccopilot` block(s), " +
  "packing every independent call into this one reply, or the `done` block if the task is finished.";

export const DONE_PROMPT = "Let's wrap this task up. Reply with the `done` block now, and nothing else.";

/** Summary line used when a reply carried no call, shown in the result frame. */
export const MISSED_CALL_SUMMARY = "your last reply did not contain a coccopilot block";

/** Summary line for a fenced block that could not be parsed. */
export const MALFORMED_SUMMARY = "your last reply had a coccopilot block that is not valid JSON";

/** Detail line asking for a corrected reply after a malformed block. */
export function malformedDetail(parseError: string): string {
  return `${parseError}\n\nPlease resend it as valid JSON (double-quoted keys and strings, newlines escaped as \\n).`;
}

/**
 * Full re-prime: restate the standing instructions and hand over a concrete opener.
 * Used as the last recovery when a refusal persists.
 */
export function reprimePrompt(systemPrompt: string, workspaceRoot: string): string {
  return (
    `${systemPrompt}\n\n---\n\n` +
    `Project folder: ${workspaceRoot}\n\n` +
    "Resume the task. To get going, write exactly this block and coccopilot will list the project for you:\n\n" +
    OPENING_BLOCK
  );
}

/** Message posted when the model stalls and the bridge returns to idle. */
export const STANDBY_MESSAGE = "Nothing was run. Let's pause here — I'll send the next task when I'm ready.";

/**
 * Opening primer used when the bridge primes a fresh chat with no task. The bridge
 * goes idle straight away, so the acknowledgement never has to be carried back.
 */
export function idlePrimer(workspaceRoot: string): string {
  return (
    `Project folder: ${workspaceRoot}\n\n` +
    'If that all makes sense, reply with just "Ready" and wait — my first task is in the next message.'
  );
}

export function wrapUserTask(task: string, workspaceRoot: string): string {
  return (
    `Project folder: ${workspaceRoot}\n\nTask: ${task}\n\n` +
    "Start now with `coccopilot` blocks. If you're unsure where to begin, write:\n\n" +
    OPENING_BLOCK
  );
}

/** Frame one result for the next turn; the detail is passed through verbatim. */
export function frameToolResult(result: ToolResult): string {
  const head = `${RESULT_LABEL} (${result.ok ? "ok" : "error"}): ${result.summary}`;
  return result.detail ? `${head}\n\n${result.detail}` : head;
}

/** Frame one or more tool results for the next turn. */
export function frameToolResults(results: ToolResult[]): string {
  if (results.length === 0) return `${RESULT_LABEL}: (no output)`;
  if (results.length === 1) return frameToolResult(results[0]);
  return results
    .map((r, i) => {
      const head = `${RESULT_LABEL} ${i + 1}/${results.length} (${r.ok ? "ok" : "error"}): ${r.summary}`;
      return r.detail ? `${head}\n\n${r.detail}` : head;
    })
    .join("\n\n---\n\n");
}

/** How an assistant reply relates to the coccopilot protocol. */
export type ReplyKind = "tool" | "done" | "refusal" | "question" | "conversational" | "empty";

/**
 * Classify a reply that contained no tool call into a coarse intent, for logging and
 * for deciding whether a nudge is appropriate. `looksLikeProtocolRefusal` handles the
 * refusal case specifically; this adds question/conversational/empty.
 */
export function classifyReply(reply: string): ReplyKind {
  const text = reply.trim();
  if (!text) return "empty";
  if (looksLikeProtocolRefusal(text)) return "refusal";
  if (/\?\s*$/.test(text) || /\b(would you like|shall i|should i|do you want|can you (confirm|clarify)|which (one|option))\b/i.test(text)) {
    return "question";
  }
  return "conversational";
}

/** True when a reply with no tool call looks like a refusal to use the protocol or
 * drift into the product's built-in Code Interpreter, rather than an ordinary
 * "thinking out loud" message. Used to pick a stronger, more specific nudge.
 */
export function looksLikeProtocolRefusal(reply: string): boolean {
  const text = reply.toLowerCase();
  const patterns = [
    // "tools are not available", "that system isn't available", etc.
    /\b(tools?|system|protocol|mechanism)s? (are|is|aren'?t|isn'?t)? ?(not )?(available|real|connected|supported)\b/,
    /\bnot (actually )?(available|real|connected|supported|possible) in this (chat|session|conversation)\b/,
    /\b(that|this|the) (protocol|system|mechanism)\b[^.\n]{0,30}\b(not|isn'?t|aren'?t)\b/,
    // Refusing to engage with the framing itself.
    /\bfictional\b/,
    /(don'?t|do not|can'?t|cannot|am unable to|unable to|won'?t)[^.\n]{0,40}\b(access|read|write|edit|run|execute|open|create|operate|interact|use|perform|carry (it|this|that) out)\b/,
    /not able to (run|execute|access|read|write|edit|open|operate|interact|perform)/,
    /no (such )?tools?/,
    /can'?t be (used|run)/,
    /outside (of )?my (capabilities|abilities)/,
    // Asking the user to supply the files themselves is a refusal in disguise.
    /please (upload|attach|paste|provide|share)[^.\n]{0,40}\b(files?|repos?|repository|contents?|zip)/,
    /i (don'?t|do not) (actually )?(see|have|can see)[^.\n]{0,40}\b(files?|contents?|workspace|local path|\/users\/|repository)/,
    // The product's canned non-answer when it won't engage with the request.
    /(can'?t|cannot|won'?t) respond to (this|that)/,
    /try a different topic/,
    /\/mnt\/data/,
    /code interpreter/,
    /(python|jupyter) (sandbox|notebook)/,
    /i'?ll (use|run) (this|it) in (the )?(sandbox|code interpreter)/,
    /as an ai/,
  ];
  return patterns.some((re) => re.test(text));
}

/** Refusal nudge: restate, plainly, that Copilot only writes text and coccopilot runs it. */
export const REFUSAL_NUDGE =
  "No problem — you don't need any access yourself. coccopilot is a program on my machine: it reads the " +
  "`coccopilot` blocks you write, runs them in my project, and I paste the results back to you. Please " +
  "just write the next block. If you haven't looked at the project yet, write exactly this:\n\n" +
  OPENING_BLOCK;

/** No-call nudge for a reply that contained no block. */
export const NO_TOOL_NUDGE =
  "Your last reply had no `coccopilot` block, so there was nothing for coccopilot to run. Please continue " +
  "with the next block(s) — or the `done` block if the task is finished. If you're unsure, start with:\n\n" +
  OPENING_BLOCK;

/** Corrective nudge for a reply that drifted into the product's built-in interpreter. */
export const DRIFT_NUDGE =
  "That ran in this chat's own sandbox, which can't see my project, so nothing changed on my side. " +
  "Please don't use the Code Interpreter — write a `coccopilot` `run_command` or file block instead and " +
  "coccopilot will run it in the real project. To look around first, write:\n\n" +
  OPENING_BLOCK;
