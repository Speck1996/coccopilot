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

  /** Resolve with the next line the operator submits. */
  nextLine(): Promise<string> {
    const queued = this.lines.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    if (this.closed) return Promise.resolve("");
    return new Promise<string>((resolve) => this.waiters.push(resolve));
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

  close(): void {
    this.rl.close();
  }
}
