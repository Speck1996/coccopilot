import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { call, done, removeWorkspace, runSession, workspaceFromFixture } from "./support/harness.js";

test("ux: a reply with no tool call is nudged, then recovers", async () => {
  const result = await runSession({
    task: "List the files.",
    replies: [
      "I think the workspace contains some source files.",
      "You're right, let me actually look.\n" + call("list_dir", { path: "." }),
      done("Listed the workspace."),
    ],
  });

  assert.ok(
    result.logs.some((l) => l.includes("nudging (1/2)")),
    "the first no-call reply should be nudged",
  );
  assert.ok(result.toolCalls.some((c) => c.tool === "list_dir"), "recovery emitted a real call");
  assert.ok(result.logs.some((l) => l.includes("task complete")));
});

test("ux: an unfenced tool call (e.g. copied from a code block) still runs", async () => {
  const dir = await workspaceFromFixture();
  try {
    const bare = '{ "tool": "run_command", "args": { "command": "rm hello.txt" } }';
    const result = await runSession({
      workspaceDir: dir,
      task: "Create then remove hello.txt.",
      replies: [
        call("write_file", { path: "hello.txt", content: "hi\n" }),
        bare,
        done("Removed hello.txt."),
      ],
    });

    const ran = result.toolCalls.find((c) => c.tool === "run_command");
    assert.equal(ran?.args.command, "rm hello.txt", "the unfenced call must execute");
    assert.ok(!existsSync(join(dir, "hello.txt")), "the unfenced rm should have removed the file");
    assert.ok(!result.logs.some((l) => l.includes("no tool call")), "no nudge should be needed");
    assert.ok(result.logs.some((l) => l.includes("task complete")));
  } finally {
    await removeWorkspace(dir);
  }
});

test("ux: a malformed tool block gets a correction frame and can recover", async () => {
  const malformed = "```coccopilot\n{ tool: read_file, args: { path: './x' } }\n```";
  const result = await runSession({
    task: "Read a file.",
    replies: [malformed, call("list_dir", { path: "." }), done("Recovered.")],
  });

  assert.ok(result.logs.some((l) => l.includes("protocol: could not parse JSON")));
  const correction = result.outbound.find((m) => m.includes("could not parse") || m.includes("malformed"));
  assert.ok(correction, "a correction frame should have been posted");
  assert.ok(result.toolCalls.some((c) => c.tool === "list_dir"));
});

test("ux: a protocol refusal is nudged, then re-primed once", async () => {
  const refusal = "I don't actually have access to your local files, so I can't read them. Please upload the repository.";
  const result = await runSession({
    task: "Explain the code.",
    replies: [refusal, refusal, refusal, call("list_dir", { path: "." }), done("Done after re-prime.")],
  });

  assert.ok(result.logs.some((l) => l.includes("protocol refusal")), "refusal should be detected");
  assert.ok(result.logs.some((l) => l.includes("re-priming")), "a re-prime should fire after nudges");
  // The re-prime restates the system prompt and hands over a concrete opener.
  const reprime = result.outbound.find((m) => m.includes("Resume the task"));
  assert.ok(reprime, "re-prime should include the resume framing");
  assert.ok(result.toolCalls.some((c) => c.tool === "list_dir"));
});

test("ux: interpreter drift is nudged back to the protocol", async () => {
  const drifted =
    "I'll run this in the code interpreter and save the output to /mnt/data/results.csv so you can download it.";
  const result = await runSession({
    task: "Summarise the project.",
    replies: [drifted, call("list_dir", { path: "." }), done("Summarised.")],
  });

  assert.ok(result.logs.some((l) => l.includes("interpreter drift")), "drift should be detected");
  const nudge = result.outbound.find((m) => m.includes("Code Interpreter"));
  assert.ok(nudge, "a drift-specific nudge should be posted");
  assert.ok(result.toolCalls.some((c) => c.tool === "list_dir"));
});

test("ux: the step budget extends, then forces a done block that is still handled", async () => {
  const result = await runSession({
    task: "Lots of steps.",
    maxTurns: 1,
    maxContinuations: 1,
    replies: [
      call("list_dir", { path: "." }), // step 1 -> budget hit -> continue
      "Once more.\n" + call("list_dir", { path: "." }), // step 1 again -> budget hit -> continuations exhausted -> done prompt
      done("Finished after the budget was exhausted."),
    ],
  });

  assert.ok(result.logs.some((l) => l.includes("continuing (1/1)")), "budget should extend once");
  assert.ok(result.logs.some((l) => l.includes("requesting the done block")), "then force done");
  assert.ok(
    result.logs.some((l) => l.includes("task complete")),
    "the done block after the forced prompt must still close the task",
  );
});

test("ux: without a task the primer goes idle at once — no acknowledgement to carry back", async () => {
  const result = await runSession({
    replies: [call("list_dir", { path: "." }), done("Listed.")],
  });

  assert.equal(result.outbound.length, 2, "primer, then one result frame");
  assert.ok(result.toolCalls.some((c) => c.tool === "list_dir"), "the first reply already starts a task");
  assert.ok(result.logs.some((l) => l.includes("task complete")));
});

test("ux: the primer fits a single clipboard paste", async () => {
  const result = await runSession({ replies: [] });
  assert.ok(result.outbound[0].length <= 8000, `primer is ${result.outbound[0].length} chars`);
  assert.doesNotMatch(result.outbound[0], /\{\{TOOLS\}\}/);
});

test("ux: a repeated reply (e.g. copying an older message) is never run twice", async () => {
  const edit = call("write_file", { path: "once.txt", content: "x\n" });
  const result = await runSession({
    task: "Write once.txt.",
    replies: [edit, edit, done("Wrote it.")],
  });

  assert.equal(result.toolCalls.filter((c) => c.tool === "write_file").length, 1);
  assert.ok(result.logs.some((l) => l.includes("NOT run again")));
  assert.ok(result.logs.some((l) => l.includes("task complete")));
});
