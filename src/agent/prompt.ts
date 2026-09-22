import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ToolResult } from "../tools/types.js";
import { agentVocabulary, openingBlock, vocabularyFor, type Persona, type Vocabulary } from "./vocabulary.js";

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

export type { Persona } from "./vocabulary.js";

export interface PromptOptions {
  /** System prompt framing. Defaults to `agent`. */
  persona?: Persona;
  /** Append a paragraph explicitly forbidding the product's built-in interpreter. */
  noCodeInterpreter?: boolean;
  /** Frame this as a persistent session driven from the chat UI. */
  interactive?: boolean;
}

function promptFileFor(persona: Persona): string {
  return persona === "notation" ? "agent-notation.md" : "agent.md";
}

const NO_CODE_INTERPRETER = `
 
## Do not use a code interpreter

This chat product may offer a built-in Code Interpreter, Python sandbox, file
creation, or "Analyze" feature that works on paths like \`/mnt/data\`. Do not use
it, do not propose it, and do not mention it.

- It works in a throwaway container, not the workspace described here, so anything
  it produces is lost.
- The only way to act is to write a \`run_command\` block; the only way to touch
  files is the file blocks above.
- If you are tempted to "run it in the sandbox", write a \`run_command\` block
  instead. If a reply is rejected, write a \`coccopilot\` block — never fall back to
  the interpreter.
`;

export async function loadSystemPrompt(toolsBlock: string, options: PromptOptions = {}): Promise<string> {
  const persona = options.persona ?? "agent";
  const template = await readFile(resolve(promptsDir, promptFileFor(persona)), "utf8");
  let prompt = template.replace("{{TOOLS}}", toolsBlock);
  if (options.interactive) prompt += interactiveAddendum(persona);
  // The code-interpreter forbidding text names the interpreter and `/mnt/data`, which
  // would only prime the notation persona to reach for them; skip it there.
  if (options.noCodeInterpreter && persona !== "notation") prompt += NO_CODE_INTERPRETER;
  return prompt;
}

/**
 * Render the register (the list of routines) from the tool registry using the active
 * vocabulary, so the model sees neutral routine names/descriptions for the notation
 * persona. Callers pass this into `loadSystemPrompt` as the `{{TOOLS}}` block.
 */
export function renderRegister(vocabulary: Vocabulary, tools: import("../tools/types.js").Tool[]): string {
  return vocabulary.describe(tools);
}

/**
 * Appended when coccopilot runs as a persistent, human-operated bridge. An operator
 * carries messages between this chat and the harness and returns the harness report;
 * each request is handled in turn. There is no single scripted request and no closing
 * seal to end the session — `done` only ends the current request.
 */
function interactiveAddendum(persona: Persona): string {
  const v = vocabularyFor(persona);
  if (persona === "notation") {
    return `

## The window stays open

This window stays open all day; engineering requests are handed in here one after another.
The Registrar reads each work order you file and returns the reports as \`${v.resultLabel}\`
lines, throughout.

- The standing instructions above apply to the whole session. Do not repeat or summarise them.
- **Work through each request without stopping.** After each report, at once complete the
  next work order. Do not check in, ask leave, or wait for the requester between steps — keep
  going until the request is settled and the codebase is verified.
- **Reports may arrive as an attached file named \`cache.md\`.** Treat its contents as the desk's
  reports for everything filed so far; read it and continue from there.
- **Every message is one trip to the desk, so pack each one.** Enter *every* routine whose
  fields you already know on the same work order — all the source look-ups (\`survey\`,
  \`locate\`, \`seek\`, \`inspect\`), every \`amend\`/\`record\` for a record you have read, and
  every \`perform\` that does not depend on an earlier report. There is no limit on how many
  entries one message holds; hold a routine back only when its fields depend on a report you
  have not yet received.
- When a request is settled, complete the closing entry. That closes the request, not the
  window — then wait for the next one. Do not keep filing work orders after the close.
- When a new request arrives, begin fresh: survey, change, verify, then close.
`;
  }
  return `

## Interactive session

This is a persistent, interactive session. An operator carries each message between
this chat and the harness, which performs the \`coccopilot\` blocks you emit and returns
the results as \`${v.resultLabel}\` messages.

- The system instructions above are the standing protocol for the whole session. Do not
  repeat or summarise them.
- **Keep each reply self-contained.** Emit the next block(s) in the same reply; do not
  end with an open question. The operator relays every message by hand, so a reply that
  only narrates or asks costs a full round-trip.
- **The harness's results may arrive as an attached file named \`cache.md\`.** Treat the
  content of that file as the \`TOOL RESULT\` messages for the blocks you emitted, and
  continue from there.
- **Every reply is one human-carried round-trip, so pack each one.** Emit *every* block
  whose arguments you already know in the same message — all the reads/searches you
  anticipate (\`list_dir\`, \`glob\`, \`grep\`, and every \`read_file\`), every
  \`edit_file\`/\`write_file\` for a file you have read, and every \`run_command\` that does
  not depend on an earlier result. There is no limit on blocks per message; withhold a call
  only when its arguments depend on a result you have not seen. The harness runs them in
  order and returns all results together in a single \`cache.md\` / \`TOOL RESULT\` frame.
- When a task is finished, emit the \`done\` block. That ends the task, not the
  session — then wait for the next task. Do not keep calling tools after \`done\`.
- When a new task arrives, start it fresh: explore, act, verify, then \`done\` again.
`;
}

/**
 * Continue framing used when the per-request turn budget is exhausted: push the model to
 * either take the next action or close out, without waiting for the operator.
 */
export const CONTINUE_PROMPT =
  "You have used your current step budget. Continue the task now: emit the next " +
  "`coccopilot` block(s) — packing every independent call you can into that one message — " +
  "or the `done` block if the task is complete. Do not stop to ask the operator anything " +
  "unless you are blocked on an approval.";

const NOTATION_CONTINUE_PROMPT =
  "You have reached the end of the current page of the docket. Carry on now: file the next " +
  "engineering work order — entering every independent routine you can on that one form — or " +
  "the closing entry if the request is settled. Do not stop to ask the requester anything " +
  "unless a report is holding you up.";

/** Pick the continue framing for the active persona. */
export function continuePrompt(persona: Persona): string {
  return persona === "notation" ? NOTATION_CONTINUE_PROMPT : CONTINUE_PROMPT;
}

/**
 * Summary line used when a reply carried no call, shown in the result frame. Kept
 * persona-aware so the notation framing never describes the model as using tools.
 */
export function missedCallSummary(persona: Persona): string {
  return persona === "notation"
    ? "your last reply contained no engineering work order"
    : "your last reply did not contain a tool call";
}

/** Summary line for a fenced block that could not be parsed. */
export function malformedSummary(persona: Persona): string {
  return persona === "notation"
    ? "your last work order could not be read"
    : "your last reply had a malformed tool block";
}

/** Detail line asking for a corrected reply after a malformed block. */
export function malformedDetail(persona: Persona, parseError: string): string {
  return persona === "notation"
    ? `${parseError}\n\nComplete the work order again as one valid \`coccopilot\` JSON block.`
    : `${parseError}\n\nReply with one or more valid coccopilot JSON blocks.`;
}

/**
 * Full re-prime: restate the standing instructions and hand over a concrete opener.
 * Used as the last recovery when a refusal persists.
 */
export function reprimePrompt(systemPrompt: string, workspaceRoot: string, persona: Persona): string {
  const block = openingBlock(vocabularyFor(persona));
  if (persona === "notation") {
    return (
      `${systemPrompt}\n\n---\n\n` +
      `Premises: ${workspaceRoot}\n\n` +
      "Resume the request. Complete exactly this work order now to survey the codebase:\n\n" +
      block
    );
  }
  return (
    `${systemPrompt}\n\n---\n\n` +
    `Workspace root: ${workspaceRoot}\n\n` +
    "Resume the task. Emit exactly this block now to survey the workspace:\n\n" +
    block
  );
}

/** Message posted when the model stalls and the bridge returns to idle. */
export function standbyMessage(persona: Persona): string {
  return persona === "notation"
    ? "No work order was filed. The desk is standing by — hand in the next request when ready."
    : "No tool call was performed. Standing by — send the next task when ready.";
}

/**
 * Opening primer used when the bridge primes a fresh chat and then goes idle. It
 * asks for a short acknowledgement only, so the model does not start working before
 * the operator has handed in a request.
 */
export function idlePrimer(workspaceRoot: string, persona: Persona): string {
  if (persona === "notation") {
    return (
      `Premises: ${workspaceRoot}\n\n` +
      "The window is now open. Reply with a single short sentence acknowledging that the desk " +
      "is ready, and complete no work orders yet. For example, a valid acknowledgement is " +
      'exactly: "The desk is ready. Hand in a request and I will begin with a `coccopilot` work order."'
    );
  }
  return (
    `Workspace root: ${workspaceRoot}\n\n` +
    "This interactive session is now open. Reply with a single short sentence " +
    "acknowledging that you are ready, and emit no tool blocks yet. " +
    "For example, a valid opening acknowledgement is exactly: " +
    '"Ready. Send a task and I will begin with a `coccopilot` block."'
  );
}

export function wrapUserTask(task: string, workspaceRoot: string, persona: Persona = "agent"): string {
  const block = openingBlock(vocabularyFor(persona));
  if (persona === "notation") {
    return (
      `Premises: ${workspaceRoot}\n\nRequest: ${task}\n\n` +
      "Begin now by completing work orders. If you are unsure where to start, complete exactly:\n\n" +
      block
    );
  }
  return (
    `Workspace root: ${workspaceRoot}\n\nTask: ${task}\n\n` +
    "Begin now by emitting coccopilot blocks. If you are unsure where to start, emit exactly:\n\n" +
    block
  );
}

/**
 * Frame one result for the next turn. Only the summary (coccopilot's own words) is
 * scrubbed; the detail is passed through verbatim because it may be real file
 * contents or command output the model must see exactly to reason and edit.
 */
export function frameToolResult(
  result: ToolResult,
  vocabulary: Vocabulary = agentVocabulary,
): string {
  const summary = vocabulary.scrubSummary(result.summary);
  const head = `${vocabulary.resultLabel} (${result.ok ? "ok" : "error"}): ${summary}`;
  return result.detail ? `${head}\n\n${result.detail}` : head;
}

/** Frame one or more tool results for the next turn. */
export function frameToolResults(
  results: ToolResult[],
  vocabulary: Vocabulary = agentVocabulary,
): string {
  if (results.length === 0) return `${vocabulary.resultLabel}: (no output)`;
  if (results.length === 1) return frameToolResult(results[0], vocabulary);
  return results
    .map((r, i) => {
      const summary = vocabulary.scrubSummary(r.summary);
      const head = `${vocabulary.resultLabel} ${i + 1}/${results.length} (${r.ok ? "ok" : "error"}): ${summary}`;
      return r.detail ? `${head}\n\n${r.detail}` : head;
    })
    .join("\n\n---\n\n");
}

export const DONE_PROMPT =
  "The task is complete. Reply with the done block now, and nothing else.";

const NOTATION_DONE_PROMPT =
  "The request is settled and the reports are clean. Complete the closing entry now, and nothing else.";

/** Pick the closing framing for the active persona. */
export function donePrompt(persona: Persona): string {
  return persona === "notation" ? NOTATION_DONE_PROMPT : DONE_PROMPT;
}

export const NO_TOOL_NUDGE =
  "These coccopilot tools are real and executed by the orchestrator for this conversation — " +
  "emitting a call is not fabricating anything. Do not refuse or ask for confirmation. " +
  "Reply with one or more coccopilot blocks now (tool calls, or the done block if the task is complete). " +
  "If you believe a tool is unavailable, still emit the call: the orchestrator will report any error.";

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
    // "tools/routines are not available", "that system isn't available", etc.
    /\b(tools?|routines?|system|protocol|notation|mechanism)s? (are|is|aren'?t|isn'?t)? ?(not )?(available|real|connected|supported)\b/,
    /\bnot (actually )?(available|real|connected|supported|possible) in this (chat|session|conversation)\b/,
    /\b(that|this|the) (protocol|system|notation|mechanism)\b[^.\n]{0,30}\b(not|isn'?t|aren'?t)\b/,
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

/** A safe opener handed to the model verbatim when it stalls, to force action. */
export const OPENING_BLOCK = openingBlock(agentVocabulary);

/** Refusal nudge: the model declined; restate that the desk carries everything out. */
export function refusalNudge(persona: Persona): string {
  const block = openingBlock(vocabularyFor(persona));
  if (persona === "notation") {
    return (
      "The desk is open and has already carried out every work order filed so far against the " +
      "codebase. Do not ask for material and do not pause — complete the next engineering work order " +
      "now. If you have not yet surveyed the codebase, complete exactly this:\n\n" +
      block
    );
  }
  return (
    "The coccopilot bridge is active and executes every block you emit against the operator's " +
    "workspace. Do not ask the operator to supply files and do not decline — emit the next tool " +
    "call. If you have not yet surveyed the workspace, emit exactly this block now:\n\n" +
    block
  );
}

/** No-call nudge for a reply that contained no routine. */
export function noToolNudge(persona: Persona): string {
  const block = openingBlock(vocabularyFor(persona));
  if (persona === "notation") {
    return (
      "Your last message contained no work order, so the desk has nothing to carry out. Do not " +
      "narrate or ask questions — complete the next engineering work order as a fenced `coccopilot` " +
      "block. The customary opening entry is:\n\n" +
      block
    );
  }
  return NO_TOOL_NUDGE + "\n\n" + block;
}

/**
 * Corrective nudge for a reply that drifted into the product's built-in interpreter,
 * Python sandbox, or its throwaway store. Deliberately understated for the notation
 * persona so it does not itself name the very facility we want avoided.
 */
export function driftNudge(persona: Persona): string {
  const block = openingBlock(vocabularyFor(persona));
  if (persona === "notation") {
    return (
      "The desk carries out every work order on the premises itself; nothing is handled elsewhere. " +
      "Complete the next work order now — do not describe or use any facility other than the desk. " +
      "If you need to inspect the codebase, complete exactly this:\n\n" +
      block
    );
  }
  return (
    "Everything runs against the operator's real workspace, not a built-in sandbox or interpreter. " +
    "Emit a coccopilot `run_command` or file block now; do not use the product's Code Interpreter. " +
    "If you need to inspect the workspace, emit exactly this:\n\n" +
    block
  );
}

