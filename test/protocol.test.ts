import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAssistant } from "../src/agent/protocol.js";
import { call, done } from "./support/harness.js";

test("protocol: a standard fenced block is parsed and stripped from prose", () => {
  const parsed = parseAssistant("Sure.\n" + call("run_command", { command: "rm hello.txt" }));
  assert.equal(parsed.calls.length, 1);
  assert.equal(parsed.calls[0].tool, "run_command");
  assert.equal(parsed.calls[0].args.command, "rm hello.txt");
  assert.equal(parsed.text, "Sure.");
  assert.equal(parsed.parseError, undefined);
});

test("protocol: a bare JSON object with no fence is recognized", () => {
  const raw = 'Let me clean that up.\n{ "tool": "run_command", "args": { "command": "rm hello.txt" } }';
  const parsed = parseAssistant(raw);
  assert.equal(parsed.calls.length, 1);
  assert.equal(parsed.calls[0].tool, "run_command");
  assert.equal(parsed.calls[0].args.command, "rm hello.txt");
  assert.equal(parsed.text, "Let me clean that up.");
});

test("protocol: an inline fence with the body on the tag line is recognized", () => {
  const raw = '```coccopilot { "tool": "run_command", "args": { "command": "rm hello.txt" } }```';
  const parsed = parseAssistant(raw);
  assert.equal(parsed.calls[0]?.tool, "run_command");
  assert.equal(parsed.calls[0]?.args.command, "rm hello.txt");
});

test("protocol: a hyphenated language tag and leading spaces are tolerated", () => {
  const raw = '``` coccopilot-json\n{ "tool": "list_dir", "args": { "path": "." } }\n```';
  const parsed = parseAssistant(raw);
  assert.equal(parsed.calls[0]?.tool, "list_dir");
});

test("protocol: prose braces are not mistaken for a tool call", () => {
  const raw = "The config looks like { foo: 1 } and the task is done.";
  const parsed = parseAssistant(raw);
  assert.equal(parsed.calls.length, 0);
  assert.equal(parsed.done, false);
  assert.equal(parsed.parseError, undefined);
});

test("protocol: a bare object that names a routine but is invalid JSON is a parse error", () => {
  const raw = "Trying to remove it.\n{ tool: run_command, args: { command: 'rm hello.txt' } }";
  const parsed = parseAssistant(raw);
  assert.equal(parsed.calls.length, 0);
  assert.match(parsed.parseError ?? "", /could not parse JSON in bare object/);
});

test("protocol: a bare done object closes the task", () => {
  const parsed = parseAssistant('{ "tool": "done", "args": { "summary": "removed hello.txt" } }');
  assert.equal(parsed.done, true);
  assert.equal(parsed.calls[0]?.tool, "done");
});

test("protocol: fenced calls still win over a stray bare object", () => {
  const raw = "Note { not: json }.\n" + call("list_dir", { path: "." });
  const parsed = parseAssistant(raw);
  assert.equal(parsed.calls.length, 1);
  assert.equal(parsed.calls[0].tool, "list_dir");
});

test("protocol: the done sentinel still closes a fenced batch", () => {
  const parsed = parseAssistant(call("list_dir", { path: "." }) + "\n\n" + done("listed"));
  assert.equal(parsed.done, true);
  assert.equal(parsed.calls.length, 2);
});
