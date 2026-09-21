import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  call,
  done,
  emptyWorkspace,
  readWorkspaceFile,
  removeWorkspace,
  runSession,
  workspaceFromFixture,
} from "./support/harness.js";

test("scenario: explaining a repository stays read-only", async () => {
  const result = await runSession({
    task: "Explain what this repository does.",
    replies: [
      "Let me look around.\n" + call("list_dir", { path: "." }),
      "Reading the key files.\n" + call("read_file", { path: "src/greet.js" }) + "\n\n" + call("grep", { pattern: "greet" }),
      "This project exposes two helpers, `greet` and `farewell`, in `src/greet.js`, with a test file.\n\n" +
        done("Explained the sample project: two greeting helpers and their tests."),
    ],
  });

  // Only read-only tools were used; nothing was written.
  const writeTools = result.toolCalls.filter((c) => ["write_file", "edit_file"].includes(c.tool));
  assert.deepEqual(writeTools, [], "explain must not modify the workspace");
  assert.deepEqual(
    [...new Set(result.toolCalls.map((c) => c.tool))].sort(),
    ["grep", "list_dir", "read_file"],
  );

  // Read results were relayed to the model in the outbound frames.
  assert.ok(result.outbound.some((m) => m.includes("read 0") || m.includes("read ") && m.includes("greet.js")));
  assert.ok(result.outbound.some((m) => m.includes("listed")));

  // The task closed on the done block without needing a corrective nudge.
  assert.ok(result.logs.some((l) => l.includes("task complete")), "done should be acknowledged");
  assert.equal(result.replyCount, 3, "each scripted reply was consumed exactly once");
  assert.ok(!result.logs.some((l) => l.includes("nudging")), "no nudges were needed");
});

test("scenario: creating a small project writes files and runs routine commands", async () => {
  const dir = await emptyWorkspace();
  try {
    const result = await runSession({
      workspaceDir: dir,
      task: "Create a small Node project with a hello module and a passing test.",
      autoApprove: true,
      replies: [
        call("write_file", {
          path: "package.json",
          content:
            '{\n  "name": "hello",\n  "type": "module",\n  "scripts": {\n    "test": "node --test src/*.test.js"\n  }\n}\n',
        }),
        call("write_file", {
          path: "src/hello.js",
          content: 'export const hello = (name) => `Hello, ${name}!`;\n',
        }) +
          "\n\n" +
          call("write_file", {
            path: "src/hello.test.js",
            content:
              'import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { hello } from "./hello.js";\ntest("hello", () => assert.equal(hello("world"), "Hello, world!"));\n',
          }),
        call("run_command", { command: "npm test" }),
        done("Created a Node project with a hello module and a passing test."),
      ],
    });

    assert.ok(existsSync(join(dir, "src", "hello.js")), "hello.js should be created");
    assert.match(await readWorkspaceFile(dir, "src/hello.js"), /Hello, \$\{name\}/);

    const ran = result.toolCalls.find((c) => c.tool === "run_command");
    assert.equal(ran?.args.command, "npm test");
    const resultForRun = result.toolResults.find((r) => r.summary.startsWith("run_command"));
    assert.equal(resultForRun?.ok, true, "npm test should pass");
    assert.match(resultForRun?.detail ?? "", /pass 1/);

    // npm test is on the routine list, so it must run without an approval prompt.
    assert.equal(result.approvals.length, 0, "routine commands need no approval");
    assert.ok(result.logs.some((l) => l.includes("task complete")));
  } finally {
    await removeWorkspace(dir);
  }
});

test("scenario: refactoring uses surgical edits and verifies", async () => {
  const dir = await workspaceFromFixture();
  try {
    const before = await readWorkspaceFile(dir, "src/greet.js");
    assert.match(before, /Goodbye, \$\{name\}\./);

    const result = await runSession({
      workspaceDir: dir,
      task: "Rename the farewell function to sayGoodbye across the project.",
      autoApprove: true,
      replies: [
        call("read_file", { path: "src/greet.js" }),
        call("read_file", { path: "src/greet.test.js" }),
        call("edit_file", {
          path: "src/greet.js",
          old_string: "export function farewell(name) {",
          new_string: "export function sayGoodbye(name) {",
        }) +
          "\n\n" +
          call("edit_file", {
            path: "src/greet.test.js",
            old_string: "import { greet, farewell } from \"./greet.js\";",
            new_string: "import { greet, sayGoodbye } from \"./greet.js\";",
          }) +
          "\n\n" +
          call("edit_file", {
            path: "src/greet.test.js",
            old_string: "farewell(\"world\")",
            new_string: "sayGoodbye(\"world\")",
          }),
        call("run_command", { command: "npm test" }),
        done("Renamed farewell to sayGoodbye and verified the tests."),
      ],
    });

    const after = await readWorkspaceFile(dir, "src/greet.js");
    assert.doesNotMatch(after, /function farewell/);
    assert.match(after, /function sayGoodbye/);
    const testFile = await readWorkspaceFile(dir, "src/greet.test.js");
    assert.doesNotMatch(testFile, /import \{[^}]*farewell/);
    assert.match(testFile, /sayGoodbye\("world"\)/);

    const edits = result.toolResults.filter((r) => r.summary.startsWith("edited"));
    assert.equal(edits.length, 3);
    assert.ok(edits.every((r) => r.ok), "all edits should succeed");
    const verify = result.toolResults.find((r) => r.summary.startsWith("run_command"));
    assert.equal(verify?.ok, true, "tests should pass after the rename");
  } finally {
    await removeWorkspace(dir);
  }
});
