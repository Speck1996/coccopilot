import { createInterface, type Interface } from "node:readline";

/**
 * A single long-lived readline interface over stdin/stdout. The human bridge keeps
 * this open for the whole session so Enter-to-continue and manual paste mode can
 * share the same input stream.
 */
export class HumanTerminal {
  private rl: Interface;
  private lines: string[] = [];
  private waiters: Array<(line: string) => void> = [];
  private closed = false;
  private readonly output: NodeJS.WritableStream;

  constructor(input: NodeJS.ReadableStream = process.stdin, output: NodeJS.WritableStream = process.stdout) {
    this.output = output;
    this.rl = createInterface({ input, output, terminal: false });
    this.rl.on("line", (line) => {
      const waiter = this.waiters.shift();
      if (waiter) waiter(line);
      else this.lines.push(line);
    });
    this.rl.on("close", () => {
      this.closed = true;
      const waiters = this.waiters;
      this.waiters = [];
      for (const w of waiters) w("");
    });
  }

  get interactive(): boolean {
    return Boolean(process.stdin.isTTY);
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /**
   * True when lines are already buffered (e.g. piped/scripted input). A closed
   * stdin may still have lines queued, so callers that need to know whether more
   * input is available should check this as well as `isClosed`.
   */
  hasBufferedInput(): boolean {
    return this.lines.length > 0;
  }

  /**
   * Resolve with the next line the operator submits. Aborting `signal` withdraws the
   * wait (resolving "") so a line typed later is not swallowed by a stale reader.
   */
  nextLine(signal?: AbortSignal): Promise<string> {
    const queued = this.lines.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    if (this.closed || signal?.aborted) return Promise.resolve("");
    return new Promise<string>((resolve) => {
      const onAbort = () => {
        const i = this.waiters.indexOf(waiter);
        if (i >= 0) this.waiters.splice(i, 1);
        resolve("");
      };
      const waiter = (line: string) => {
        signal?.removeEventListener("abort", onAbort);
        resolve(line);
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.waiters.push(waiter);
    });
  }

  /**
   * Read a manually pasted block until the sentinel line. Used when no clipboard
   * backend is available, or when the operator prefers not to use one. Lines already
   * buffered are drained even after stdin closes, so piped input is not lost.
   */
  async readUntil(sentinel: string): Promise<string> {
    const chunks: string[] = [];
    const target = sentinel.trim();
    while (true) {
      if (this.lines.length === 0 && this.closed) break;
      const line = await this.nextLine();
      if (line.trim() === target) break;
      if (line === "" && this.closed && this.lines.length === 0) break;
      chunks.push(line);
    }
    return chunks.join("\n");
  }

  write(message: string): void {
    this.output.write(message.endsWith("\n") ? message : `${message}\n`);
  }

  /** Ring the terminal bell so the operator notices a hand-off is ready. TTY only. */
  bell(): void {
    if ((this.output as NodeJS.WriteStream).isTTY) this.output.write("\x07");
  }

  close(): void {
    this.rl.close();
  }
}
