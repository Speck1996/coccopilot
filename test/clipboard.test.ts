import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { createChannel } from "../src/human/channel.js";
import { HumanTerminal } from "../src/human/terminal.js";
import { chunkMessage } from "../src/human/transcript.js";
import type { Clipboard } from "../src/human/clipboard.js";

/** Clipboard stub whose reads are returned from a queue, in order. */
class StubClipboard implements Clipboard {
  readonly description = "stub";
  writes: string[] = [];
  readsUsed = 0;
  constructor(private reads: string[]) {}
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

/** Wait until the terminal has rendered a marker, or the deadline passes. */
async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for terminal output");
    await new Promise((r) => setTimeout(r, 5));
  }
}

test("clipboard: guards against an empty clipboard and a stale last-sent message", async () => {
  const { input, terminal } = makeTerminal();
  const clipboard = new StubClipboard(["", "hello", "```coccopilot\n{}\n```"]);
  const { channel } = await createChannel({
    webappUrl: "https://example.test",
    clipboard,
    terminal,
    log: () => {},
  });

  await channel.send("hello");
  assert.deepEqual(clipboard.writes, ["hello"], "the outbound message is written to the clipboard");

  // Empty clipboard, then the clipboard still holding what we sent, then a real reply.
  input.write("\n\n\n");
  const reply = await channel.receive();
  assert.equal(reply, "```coccopilot\n{}\n```");
  assert.equal(clipboard.readsUsed, 3, "both guards retried before accepting the reply");
});

test("clipboard: a typed line is used as the reply without touching the clipboard", async () => {
  const { input, terminal } = makeTerminal();
  const clipboard = new StubClipboard([]);
  const { channel } = await createChannel({
    webappUrl: "https://example.test",
    clipboard,
    terminal,
    log: () => {},
  });

  input.write("a manually typed reply\n");
  const reply = await channel.receive();
  assert.equal(reply, "a manually typed reply");
});

test("clipboard: full paste instructions print once, then a compact line", async () => {
  const { terminal, rendered } = makeTerminal();
  const clipboard = new StubClipboard([]);
  const { channel } = await createChannel({
    webappUrl: "https://example.test",
    clipboard,
    terminal,
    log: () => {},
  });

  await channel.send("first message");
  await channel.send("second message");

  const out = rendered();
  const full = out.split("1. Open the Copilot webapp").length - 1;
  assert.equal(full, 1, "the numbered steps must appear exactly once");
  assert.ok(out.includes("copied to clipboard"), "later sends use the compact line");
});

test("clipboard: the reply prompt shows the status line", async () => {
  const { input, terminal, rendered } = makeTerminal();
  const clipboard = new StubClipboard(["reply"]);
  const { channel } = await createChannel({
    webappUrl: "https://example.test",
    clipboard,
    terminal,
    log: () => {},
  });

  const received = channel.receive("working · step 3/25");
  await waitFor(() => rendered().includes("[working · step 3/25]"));
  assert.ok(rendered().includes("[working · step 3/25]"), "status should appear beside the input prompt");
  input.write("\n");
  assert.equal(await received, "reply");
});

test("chunk: a split is lossless and respects the budget", () => {
  const text = Array.from({ length: 50 }, (_, i) => `line ${i} of the frame`).join("\n");
  const chunks = chunkMessage(text, 100);
  assert.ok(chunks.length > 1, "a long message splits into several chunks");
  for (const chunk of chunks) assert.ok(chunk.length <= 100, `chunk under budget (${chunk.length})`);
  assert.equal(chunks.join(""), text, "rejoining the chunks restores the original exactly");
});

test("clipboard: an oversized message is handed over in numbered parts", async () => {
  const { input, terminal, rendered } = makeTerminal();
  const clipboard = new StubClipboard([]);
  const { channel } = await createChannel({
    webappUrl: "https://example.test",
    clipboard,
    terminal,
    maxMessageChars: 400,
    log: () => {},
  });

  const message = Array.from({ length: 40 }, (_, i) => `TOOL RESULT line ${i} with some body text`).join("\n");
  const sent = channel.send(message);

  // First part goes out immediately; the rest wait for Enter.
  await waitFor(() => rendered().includes("part 1/"));
  assert.equal(clipboard.writes.length, 1, "only the first part is copied up front");
  assert.ok(clipboard.writes[0].length <= 400, "the first paste is under the budget");
  assert.ok(clipboard.writes[0].includes("[coccopilot part 1/"), "the clipboard text is labelled as part 1");

  input.write("\n\n\n\n\n\n\n\n\n\n");
  await sent;

  assert.ok(clipboard.writes.length > 1, "the remaining parts are copied after Enter");
  for (const w of clipboard.writes) assert.ok(w.length <= 400, `every paste under the budget (${w.length})`);

  // Reassemble the parts and confirm nothing was lost between part markers.
  const body = clipboard.writes
    .map((w) => w.replace(/^\[coccopilot part \d+\/\d+\]\n/, "").replace(/\n\[coccopilot end part \d+\/\d+\]$/, ""))
    .join("");
  assert.equal(body, message, "the parts reassemble into the original message");
});

test("manual: a sentinel-delimited paste is returned as the reply", async () => {
  const { input, terminal } = makeTerminal();
  const { channel, description } = await createChannel({
    webappUrl: "https://example.test",
    forceManual: true,
    sentinel: "END",
    terminal,
    log: () => {},
  });

  assert.match(description, /manual paste/);
  input.write("line one\nline two\nEND\n");
  const reply = await channel.receive();
  assert.equal(reply, "line one\nline two");
});
