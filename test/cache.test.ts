import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createChannel } from "../src/human/channel.js";
import { HumanTerminal } from "../src/human/terminal.js";
import { resolveCachePath, writeCache, readCache } from "../src/human/cache.js";
import { guardClipboard, looksLikeToolReply, type Clipboard } from "../src/human/clipboard.js";

/** Clipboard stub whose reads are returned from a queue, in order. */
class StubClipboard implements Clipboard {
  readonly description = "stub";
  writes: string[] = [];
  readsUsed = 0;
  constructor(public reads: string[]) {}
  async read(): Promise<string> {
    this.readsUsed++;
    return this.reads.shift() ?? "";
  }
  async write(text: string): Promise<void> {
    this.writes.push(text);
  }
}

function makeTerminal() {
  const input = new PassThrough();
  const output = new PassThrough();
  let rendered = "";
  output.on("data", (b: Buffer) => {
    rendered += b.toString("utf8");
  });
  const terminal = new HumanTerminal(input, output);
  return { input, terminal, rendered: () => rendered };
}

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "coccopilot-cache-"));
}

test("cache: resolveCachePath defaults into the workspace and honors an override", () => {
  assert.equal(resolveCachePath("/work"), join("/work", ".coccopilot", "cache.md"));
  assert.equal(resolveCachePath("/work", "hand-off/out.md"), join("/work", "hand-off", "out.md"));
  assert.equal(resolveCachePath("/work", "/abs/cache.md"), "/abs/cache.md");
});

test("cache: writeCache overwrites each turn and stamps a header", async () => {
  const dir = await tempDir();
  try {
    const path = resolveCachePath(dir);
    await writeCache(path, "[coccopilot] TOOL RESULT 1/2 (ok): first", { turn: 1, results: 2 });
    const first = await readFile(path, "utf8");
    assert.match(first, /^<!-- coccopilot cache · turn 1 · 2 results · \d+ chars/);
    assert.match(first, /TOOL RESULT 1\/2 \(ok\)/);

    await writeCache(path, "[coccopilot] TOOL RESULT (ok): second", { turn: 2, results: 1 });
    const second = await readFile(path, "utf8");
    assert.match(second, /turn 2/);
    assert.doesNotMatch(second, /first/, "the previous frame is overwritten");

    // The cache directory is gitignored so it is never committed by the target project.
    assert.equal((await readFile(join(dir, ".coccopilot", ".gitignore"), "utf8")).trim(), "*");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("cache: an under-cap frame is written to the file and copied to the clipboard", async () => {
  const dir = await tempDir();
  const { terminal, rendered } = makeTerminal();
  const clipboard = new StubClipboard([]);
  try {
    const cacheFile = resolveCachePath(dir);
    const { channel, description } = await createChannel({
      webappUrl: "https://example.test",
      cache: true,
      cachePath: cacheFile,
      clipboard,
      maxMessageChars: 8000,
      terminal,
      log: () => {},
    });
    assert.match(description, /cache file/);

    const payload = "[coccopilot] TOOL RESULT (ok): read src/greet.js";
    await channel.send(payload);

    assert.match(await readCache(cacheFile), /TOOL RESULT \(ok\): read src\/greet\.js/);
    assert.deepEqual(clipboard.writes, [payload], "the small frame is also copied");
    assert.match(rendered(), /also copied to your clipboard/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("cache: an over-cap frame is written to the file; only its path is copied", async () => {
  const dir = await tempDir();
  const { terminal, rendered } = makeTerminal();
  const clipboard = new StubClipboard([]);
  try {
    const cacheFile = resolveCachePath(dir);
    const { channel } = await createChannel({
      webappUrl: "https://example.test",
      cache: true,
      cachePath: cacheFile,
      clipboard,
      maxMessageChars: 100,
      terminal,
      log: () => {},
    });

    const payload = `[coccopilot] TOOL RESULT (ok):\n${"x".repeat(500)}`;
    await channel.send(payload);

    assert.match(await readCache(cacheFile), /TOOL RESULT \(ok\)/);
    assert.deepEqual(clipboard.writes, [cacheFile], "only the path goes on the clipboard, for the attach dialog");
    assert.match(rendered(), /too large for the composer/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("cache: a merged multi-result frame is written whole to the file", async () => {
  const dir = await tempDir();
  const { terminal } = makeTerminal();
  try {
    const cacheFile = resolveCachePath(dir);
    const { channel } = await createChannel({
      webappUrl: "https://example.test",
      cache: true,
      cachePath: cacheFile,
      clipboard: new StubClipboard([]),
      terminal,
      log: () => {},
    });

    // The bridge frames a batch of tool calls as a single message; the file must hold
    // every result in that one frame.
    const merged =
      "[coccopilot] TOOL RESULT 1/2 (ok): read src/a.js\n\nAAA\n\n---\n\n[coccopilot] TOOL RESULT 2/2 (ok): read src/b.js\n\nBBB";
    await channel.send(merged);

    const body = await readCache(cacheFile);
    assert.match(body, /TOOL RESULT 1\/2/);
    assert.match(body, /TOOL RESULT 2\/2/);
    assert.match(body, /AAA/);
    assert.match(body, /BBB/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("cache: a sentinel-delimited multi-line reply is read from the terminal", async () => {
  const dir = await tempDir();
  const { input, terminal } = makeTerminal();
  try {
    const { channel } = await createChannel({
      webappUrl: "https://example.test",
      cache: true,
      cachePath: resolveCachePath(dir),
      clipboard: null,
      sentinel: "END",
      terminal,
      log: () => {},
    });

    // A leading non-empty line starts the paste; readUntil consumes until the sentinel.
    input.write('```coccopilot\n{ "tool": "list_dir", "args": {"path": "."} }\n```\nEND\n');
    const reply = await channel.receive();
    assert.match(reply, /list_dir/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("cache: a bare Enter reads the clipboard, with guards", async () => {
  const dir = await tempDir();
  const { input, terminal } = makeTerminal();
  const clipboard = new StubClipboard(["", "```coccopilot\n{}\n```"]);
  try {
    const { channel } = await createChannel({
      webappUrl: "https://example.test",
      cache: true,
      cachePath: resolveCachePath(dir),
      clipboard,
      sentinel: "END",
      terminal,
      log: () => {},
    });

    // First Enter: empty clipboard guard. Second Enter: the real reply.
    input.write("\n\n");
    const reply = await channel.receive();
    assert.equal(reply, "```coccopilot\n{}\n```");
    assert.equal(clipboard.readsUsed, 2, "the empty clipboard was rejected before the reply");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("watch: a reply copied to the clipboard is taken without touching the terminal", async () => {
  const dir = await tempDir();
  const { input, terminal, rendered } = makeTerminal();
  const reply = '```coccopilot\n{ "tool": "list_dir", "args": { "path": "." } }\n```';
  // Baseline (our own frame), an unrelated copy, then Copilot's reply.
  // A reply is only taken once it has stayed on the clipboard for a couple of polls.
  const clipboard = new StubClipboard(["[coccopilot] TOOL RESULT (ok): x", "some unrelated text", reply, reply, reply]);
  try {
    const { channel, description } = await createChannel({
      webappUrl: "https://example.test",
      cache: true,
      cachePath: resolveCachePath(dir),
      clipboard,
      sentinel: "END",
      watch: true,
      watchIntervalMs: 1,
      terminal,
      log: () => {},
    });
    assert.match(description, /auto-reads/);
    assert.equal(await channel.receive(), reply);
    assert.match(rendered(), /picked up Copilot's reply/);

    // The withdrawn terminal wait must not swallow the next line typed.
    input.write("typed\nEND\n");
    clipboard.reads.push("typed"); // keep the watcher's baseline quiet
    assert.equal(await channel.receive(), "typed");
  } finally {
    terminal.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("watch: coccopilot's own hand-offs are never mistaken for a reply", () => {
  assert.ok(looksLikeToolReply('Sure.\n```coccopilot\n{ "tool": "read_file", "args": {} }\n```'));
  assert.ok(looksLikeToolReply('{ "tool": "grep", "args": { "pattern": "x" } }'));
  assert.ok(!looksLikeToolReply("[coccopilot] I'm working on a project...\n```coccopilot\n{}\n```"));
  assert.ok(!looksLikeToolReply("<!-- coccopilot cache · 10 chars -->\n```coccopilot\n{}\n```"));
  assert.ok(!looksLikeToolReply("Ready"));
});

test("watch: a second Copy-button write over the results is undone", async () => {
  const reply = '```coccopilot\n{ "tool": "list_dir", "args": { "path": "." } }\n```';
  const results = "[coccopilot] TOOL RESULT (ok): listed";
  const clipboard = new StubClipboard([results, reply]);
  let restored = 0;
  await guardClipboard(clipboard, results, () => restored++, 30, 1);
  assert.equal(restored, 1, "the stale reply is replaced once");
  assert.deepEqual(clipboard.writes, [results]);
});
