import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { call, done, removeWorkspace, workspaceFromFixture } from "./support/harness.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, "..");

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Spawn the real CLI in manual mode, feeding scripted replies over stdin. */
function runCli(args: string[], stdin: string): Promise<RunResult> {
  return new Promise((resolveRun) => {
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT; // so the child CLI behaves as it would for a real operator
    const child = spawn(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
      cwd: REPO,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (b: Buffer) => (stdout += b.toString("utf8")));
    child.stderr.on("data", (b: Buffer) => (stderr += b.toString("utf8")));
    child.on("close", (code) => resolveRun({ code, stdout, stderr }));
    child.stdin.end(stdin);
  });
}

test("e2e: the CLI runs a task end to end in manual mode", { timeout: 30_000 }, async () => {
  const dir = await workspaceFromFixture();
  try {
    // Replies are sentinel-delimited; the CLI reads them from piped stdin.
    const replies =
      "surveying\n" +
      call("read_file", { path: "src/greet.js" }) +
      "\nEND\n" +
      done("Explained the fixture project.") +
      "\nEND\n";

    const result = await runCli(
      ["--no-cache", "--no-clipboard", "--sentinel", "END", "--yes", "--cwd", dir, "Explain src/greet.js"],
      replies,
    );

    assert.equal(result.code, 0, `CLI should exit cleanly\n${result.stderr}`);
    assert.match(result.stdout, /\[coccopilot\] workspace:/);
    assert.match(result.stdout, /manual paste/);
    assert.match(result.stdout, /tool: read_file/);
    assert.match(result.stdout, /task complete: Explained the fixture project\./);
    // The reply input prompt carries the status line.
    assert.match(result.stdout, /\[idle · waiting for a task\]/);
  } finally {
    await removeWorkspace(dir);
  }
});

test("e2e: an oversized hand-off is split into numbered parts", { timeout: 30_000 }, async () => {
  const dir = await workspaceFromFixture();
  try {
    // A tiny budget forces the priming frame to split; blank lines advance the parts.
    const replies = call("done", { summary: "Split hand-off verified." }) + "\nEND\n";
    const result = await runCli(
      [
        "--no-cache",
        "--no-clipboard",
        "--sentinel",
        "END",
        "--yes",
        "--max-message-chars",
        "600",
        "--cwd",
        dir,
        "go",
      ],
      "\n".repeat(200) + replies,
    );

    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /send part 1\/\d+ to Copilot/, "the first part is labelled");
    assert.match(result.stdout, /press Enter to print part 2\/\d+/, "later parts wait for Enter");
    assert.match(result.stdout, /\[coccopilot part 1\/\d+\]/);
    assert.match(result.stdout, /\[coccopilot end part 1\/\d+\]/);
    assert.match(result.stdout, /task complete: Split hand-off verified\./);
  } finally {
    await removeWorkspace(dir);
  }
});

test("e2e: the CLI creates a new project in a fresh workspace", { timeout: 30_000 }, async () => {
  const dir = await workspaceFromFixture();
  try {
    const replies =
      call("write_file", { path: "src/answer.js", content: "export const answer = 42;\n" }) +
      "\nEND\n" +
      done("Added src/answer.js.") +
      "\nEND\n";

    const result = await runCli(
      ["--no-cache", "--no-clipboard", "--sentinel", "END", "--yes", "--cwd", dir, "Add an answer module"],
      replies,
    );

    assert.equal(result.code, 0, result.stderr);
    assert.ok(existsSync(join(dir, "src", "answer.js")), "the new file should exist on disk");
    assert.match(result.stdout, /task complete: Added src\/answer\.js\./);
  } finally {
    await removeWorkspace(dir);
  }
});

test("e2e: cache mode writes results to .coccopilot/cache.md", { timeout: 30_000 }, async () => {
  const dir = await workspaceFromFixture();
  try {
    // Default mode is cache; --no-clipboard keeps the test headless and deterministic.
    const replies = call("read_file", { path: "src/greet.js" }) + "\nEND\n" + done("Read greet.js.") + "\nEND\n";
    const result = await runCli(
      ["--no-clipboard", "--sentinel", "END", "--yes", "--cwd", dir, "Read src/greet.js"],
      replies,
    );

    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /cache file/);
    const cache = join(dir, ".coccopilot", "cache.md");
    assert.ok(existsSync(cache), "the cache markdown should be written");
    const body = readFileSync(cache, "utf8");
    assert.match(body, /TOOL RESULT \(ok\): read/);
    assert.match(body, /greet\.js/);
  } finally {
    await removeWorkspace(dir);
  }
});
