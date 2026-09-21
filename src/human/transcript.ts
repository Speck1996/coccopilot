import type { CopilotChannel } from "./channel.js";

/** One entry in a session transcript, in the order it happened. */
export interface TranscriptEntry {
  seq: number;
  direction: "out" | "in";
  /** Outbound: the message handed to the operator. Inbound: the raw reply. */
  text: string;
  /** Inbound only: the status label coccopilot passed to `receive`, if any. */
  status?: string;
}

/**
 * Base channel that records every outbound message and inbound reply as an ordered
 * transcript, so a session can be replayed or asserted against. Subclasses implement
 * `nextReply`, which is the only place a reply is obtained — scripted in tests,
 * clipboard/terminal-backed (or any other driver) in real runs.
 */
export abstract class TranscriptChannel implements CopilotChannel {
  abstract readonly mode: "clipboard" | "manual";
  readonly transcript: TranscriptEntry[] = [];
  private seq = 0;
  protected closed = false;
  private parts: string[] = [];
  private partCursor = 0;

  constructor(protected readonly maxMessageChars?: number) {}

  /**
   * Hand a message to the backend. A message larger than the paste budget is split
   * into numbered parts; the first is delivered now and the rest wait in
   * `sendNextPart`. This keeps every clipboard write under the Copilot composer's
   * paste limit, which silently rejects an oversized paste.
   */
  async send(message: string): Promise<void> {
    this.transcript.push({ seq: this.seq++, direction: "out", text: message });
    this.parts = this.partition(message);
    this.partCursor = 0;
    await this.deliverNextPart();
    // A split message is handed over one part at a time: the operator pastes and
    // sends part n, then signals here for part n+1, so no single paste is oversized.
    while (this.remainingParts() > 0) {
      const proceed = await this.beforeNextPart(this.partNumber + 1, this.partCount);
      if (!proceed || this.closed) return;
      await this.deliverNextPart();
    }
  }

  /** Number of parts still waiting to be delivered after the current one. */
  remainingParts(): number {
    return Math.max(0, this.parts.length - this.partCursor);
  }

  /** Total number of parts in the message currently being delivered (1 if unsplit). */
  get partCount(): number {
    return Math.max(1, this.parts.length);
  }

  /** 1-based index of the part just delivered. */
  get partNumber(): number {
    return this.partCursor === 0 ? 1 : this.partCursor;
  }

  /** True when the message just delivered was one of several parts. */
  get wasSplit(): boolean {
    return this.parts.length > 1;
  }

  private async deliverNextPart(): Promise<void> {
    if (this.partCursor >= this.parts.length) return;
    const text = this.parts[this.partCursor];
    this.partCursor++;
    await this.onSend(text);
  }

  private partition(message: string): string[] {
    const limit = this.maxMessageChars;
    if (!limit || limit <= 0 || message.length <= limit) return [message];
    // Leave room for the part header/footer and the channel's own frame.
    const budget = Math.max(200, limit - 240);
    const chunks = chunkMessage(message, budget);
    return chunks.map((chunk, i) => framePart(chunk, i + 1, chunks.length));
  }

  async receive(status?: string): Promise<string> {
    if (status) this.lastStatus = status;
    const reply = await this.nextReply(status);
    this.transcript.push({ seq: this.seq++, direction: "in", text: reply, status });
    return reply;
  }

  close(): void {
    this.closed = true;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /** The most recent status line coccopilot asked to display. */
  lastStatus: string | undefined;

  /**
   * Ask the backend to show a status line (e.g. on a terminal status line) for the
   * turn currently being waited on. No-op when `receive` already renders it.
   */
  report(status: string): void {
    this.lastStatus = status;
  }

  /** Every outbound message, in order. */
  get outbound(): string[] {
    return this.transcript.filter((e) => e.direction === "out").map((e) => e.text);
  }

  /** Every inbound reply, in order. */
  get inbound(): string[] {
    return this.transcript.filter((e) => e.direction === "in").map((e) => e.text);
  }

  /** Hook for a backend that renders outgoing messages (clipboard/terminal). */
  protected async onSend(_message: string): Promise<void> {}

  /**
   * Wait for the operator to signal the next part of a split message can be handed
   * over. Return false to abandon the rest (e.g. closed session). Default: proceed.
   */
  protected async beforeNextPart(_index: number, _total: number): Promise<boolean> {
    return true;
  }

  /** Produce the next reply. Return "" to end the session. */
  protected abstract nextReply(status?: string): Promise<string>;
}

/**
 * Split a message into chunks of at most `budget` characters. It breaks just after
 * the latest line boundary that fits, then after the latest whitespace, then hard at
 * the budget — so a split never lands mid-line when a boundary exists. The split is
 * lossless: concatenating the chunks returns the original text exactly.
 */
export function chunkMessage(text: string, budget: number): string[] {
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > budget) {
    let cut = rest.lastIndexOf("\n", budget);
    if (cut <= 0) cut = rest.lastIndexOf(" ", budget);
    if (cut > 0) cut += 1; // keep the boundary character with this chunk
    else cut = budget;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  chunks.push(rest);
  return chunks;
}

/** Wrap a chunk with `part i/n` markers so the human knows a split happened. */
export function framePart(chunk: string, index: number, total: number): string {
  return `[coccopilot part ${index}/${total}]\n${chunk}\n[coccopilot end part ${index}/${total}]`;
}
