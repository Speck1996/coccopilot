// Ways a model's reply (GPT-based Copilot in particular) can be misread, and the
// protocol/bridge behaviour that keeps them from silently going wrong.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAssistant, repairJson } from "../src/agent/protocol.js";
import { malformedDetail, systemLine } from "../src/agent/prompt.js";
import { call, done, runSession } from "./support/harness.js";

const readme = "# Title\n\n```bash\nnpm test\n```\n";

test("misread: a write_file whose content holds ``` lines survives a three-backtick fence", () => {
  const raw = "Writing the README.\n" + call("write_file", { path: "README.md", content: readme });
  const parsed = parseAssistant(raw);
  assert.equal(parsed.parseError, undefined);
  assert.equal(parsed.calls.length, 1);
  assert.equal(parsed.calls[0].args.content, readme);
  assert.equal(parsed.text, "Writing the README.");
});

test("misread: a four-backtick coccopilot fence is accepted", () => {
  const body = JSON.stringify({ tool: "write_file", args: { path: "README.md", content: readme } });
  const parsed = parseAssistant("````coccopilot\n" + body + "\n````\n" + call("list_dir", { path: "." }));
  assert.deepEqual(parsed.calls.map((c) => c.tool), ["write_file", "list_dir"]);
  assert.equal(parsed.calls[0].args.content, readme);
});

test("misread: a package.json snippet in a json fence is not a tool call", () => {
  const raw = 'Your package.json should look like:\n```json\n{ "name": "my-app", "version": "1.0.0" }\n```';
  const parsed = parseAssistant(raw);
  assert.equal(parsed.calls.length, 0);
  assert.equal(parsed.parseError, undefined);
});

test("misread: a partial json snippet does not block the real calls in the same reply", () => {
  const raw =
    'I\'ll add a script:\n```json\n{ "name": "my-app", "scripts": { ... } }\n```\n' +
    call("read_file", { path: "package.json" });
  const parsed = parseAssistant(raw);
  assert.equal(parsed.parseError, undefined);
  assert.equal(parsed.calls.length, 1);
  assert.equal(parsed.calls[0].tool, "read_file");
});

test("misread: a { name, arguments } call is still accepted", () => {
  const parsed = parseAssistant('```json\n{ "name": "read_file", "arguments": { "path": "a.js" } }\n```');
  assert.equal(parsed.calls[0]?.tool, "read_file");
});

test("misread: raw newlines inside a JSON string are repaired", () => {
  const raw = '```coccopilot\n{ "tool": "write_file", "args": { "path": "a.txt", "content": "line 1\nline 2\n" } }\n```';
  const parsed = parseAssistant(raw);
  assert.equal(parsed.parseError, undefined);
  assert.equal(parsed.calls[0]?.args.content, "line 1\nline 2\n");
});

test("misread: a trailing comma is repaired, but commas inside strings are kept", () => {
  assert.equal(repairJson('{ "a": ",}", "b": [1, 2,], }'), '{ "a": ",}", "b": [1, 2] }');
  const parsed = parseAssistant('```coccopilot\n{ "tool": "list_dir", "args": { "path": "." }, }\n```');
  assert.equal(parsed.calls[0]?.tool, "list_dir");
});

test("misread: the malformed-block correction asks for the whole reply again", () => {
  const detail = malformedDetail("could not parse JSON");
  assert.match(detail, /None of the blocks in that reply ran/);
  assert.match(detail, /whole reply again/);
});

test("misread: the system line names the shell for each platform", () => {
  assert.match(systemLine("darwin"), /macOS.*\/bin\/sh/);
  assert.match(systemLine("linux"), /Linux.*\/bin\/sh/);
  assert.match(systemLine("win32"), /cmd\.exe/);
});

test("misread: done in the same reply as a failing command does not close the task", async () => {
  const result = await runSession({
    task: "Make the tests pass.",
    replies: [
      call("run_command", { command: "exit 3" }) + "\n" + done("All green."),
      call("list_dir", { path: "." }),
      done("Really done."),
    ],
    autoApprove: true,
  });
  assert.ok(result.logs.some((l) => l.includes("done block ignored")));
  assert.ok(result.outbound.some((m) => m.includes("was not accepted")));
  assert.ok(result.toolCalls.some((c) => c.tool === "list_dir"), "the task stayed open for the next reply");
  const completions = result.logs.filter((l) => l.includes("task complete"));
  assert.equal(completions.length, 1);
  assert.match(completions[0], /Really done/);
});

test("misread: run_command results name the command, so batched results map back", async () => {
  const result = await runSession({
    task: "Check the toolchain.",
    replies: [call("run_command", { command: "node --version" }), done("Checked.")],
  });
  assert.ok(result.outbound.some((m) => m.includes("run_command `node --version`: exit 0")));
});

test("misread: a question is left to the operator instead of being nudged", async () => {
  const result = await runSession({
    task: "Add a flag.",
    replies: ["Should the flag be called --verbose or --debug?", call("list_dir", { path: "." }), done("Added.")],
  });
  assert.ok(!result.logs.some((l) => l.includes("nudging")), "no automatic nudge for a question");
  assert.ok(result.logs.some((l) => l.includes("asked a question")));
  assert.ok(result.logs.some((l) => l.includes("task complete")));
});
