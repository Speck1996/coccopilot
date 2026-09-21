import { detectClipboard, normalizeClipboard, type Clipboard } from "./clipboard.js";
import { HumanTerminal } from "./terminal.js";

/**
 * The human-in-the-loop transport to the Copilot webapp. coccopilot never touches
 * the browser: the operator drives it. A channel only renders text for the operator
 * to send and captures the text the operator brings back.
 */
export interface CopilotChannel {
  readonly mode: "clipboard" | "manual";
  /** Render an outgoing message and hand it to the operator (clipboard or print). */
  send(message: string): Promise<void>;
  /** Wait for the operator to bring back Copilot's reply. */
  receive(prompt?: string): Promise<string>;
  close(): void;
}

export const DEFAULT_SENTINEL = "<<<END>>>";

export interface ChannelOptions {
  /** The webapp URL, shown in the hand-off instructions. */
  webappUrl: string;
  /** Manual-paste sentinel terminator. */
  sentinel?: string;
  /** Force manual paste mode even if a clipboard is available. */
  forceManual?: boolean;
  /**
   * Shared stdin reader. The caller owns it so command approvals can use the same
   * input stream instead of opening a competing readline.
   */
  terminal: HumanTerminal;
  log: (msg: string) => void;
}

export interface ChannelHandle {
  channel: CopilotChannel;
  /** Human-readable description of the reply input path. */
  description: string;
}

const RULE = "─".repeat(64);

function charCount(text: string): string {
  return `${text.length} char${text.length === 1 ? "" : "s"}`;
}

/** Clipboard channel: outgoing copied for paste; replies read back from the clipboard. */
class ClipboardChannel implements CopilotChannel {
  readonly mode = "clipboard" as const;
  private lastSent = "";

  constructor(
    private readonly clipboard: Clipboard,
    private readonly terminal: HumanTerminal,
    private readonly webappUrl: string,
    private readonly log: (msg: string) => void,
  ) {}

  async send(message: string): Promise<void> {
    await this.clipboard.write(message);
    this.lastSent = message;
    this.terminal.write(`\n${RULE}`);
    this.terminal.write(`[coccopilot] message copied to your clipboard (${charCount(message)}).`);
    this.terminal.write("");
    this.terminal.write(`  1. Open the Copilot webapp:  ${this.webappUrl}`);
    this.terminal.write("  2. Paste it into the composer and send.");
    this.terminal.write("  3. Select Copilot's full reply and copy it (Cmd/Ctrl+C).");
    this.terminal.write(`${RULE}`);
  }

  async receive(prompt?: string): Promise<string> {
    while (true) {
      this.terminal.write(
        `[coccopilot] ${prompt ?? "Press Enter once Copilot's reply is on your clipboard."}`,
      );
      const typed = await this.terminal.nextLine();
      const closed = this.terminal.isClosed;

      // A non-empty line is a manually supplied reply (handy for short replies or
      // when the clipboard is being stubborn). An empty line means "read clipboard".
      if (typed.trim().length > 0) return typed;
      if (closed) return "";

      let text: string;
      try {
        text = await this.clipboard.read();
      } catch (err) {
        this.log(`clipboard read failed: ${(err as Error).message}`);
        this.terminal.write("[coccopilot] could not read the clipboard; press Enter to retry, or type the reply.");
        continue;
      }

      if (!text.trim()) {
        this.terminal.write("[coccopilot] the clipboard is empty — copy Copilot's reply first, then press Enter.");
        continue;
      }
      if (this.lastSent && normalizeClipboard(text) === normalizeClipboard(this.lastSent)) {
        this.terminal.write(
          "[coccopilot] the clipboard still holds the message we gave you — copy Copilot's reply instead, then press Enter.",
        );
        continue;
      }
      return text;
    }
  }

  close(): void {
    /* nothing to release */
  }
}

/** Manual channel: no clipboard. The operator pastes the reply into the terminal. */
class ManualChannel implements CopilotChannel {
  readonly mode = "manual" as const;

  constructor(
    private readonly terminal: HumanTerminal,
    private readonly webappUrl: string,
    private readonly sentinel: string,
  ) {}

  async send(message: string): Promise<void> {
    this.terminal.write(`\n${RULE}`);
    this.terminal.write(`[coccopilot] send this to Copilot (${charCount(message)}):`);
    this.terminal.write(`${RULE}`);
    this.terminal.write(message);
    this.terminal.write(`${RULE}`);
    this.terminal.write(`Open the Copilot webapp: ${this.webappUrl}`);
    this.terminal.write("Select the text above, paste it into the composer, and send.");
  }

  async receive(prompt?: string): Promise<string> {
    this.terminal.write(
      `[coccopilot] ${prompt ?? "Paste Copilot's reply below"}; finish with a line containing only ${this.sentinel}.`,
    );
    return this.terminal.readUntil(this.sentinel);
  }

  close(): void {
    /* nothing to release */
  }
}

/**
 * Build the channel. Prefers the clipboard; falls back to manual paste when no
 * backend is detected or `forceManual` is set.
 */
export async function createChannel(opts: ChannelOptions): Promise<ChannelHandle> {
  const terminal = opts.terminal;
  const sentinel = opts.sentinel ?? DEFAULT_SENTINEL;

  if (!opts.forceManual) {
    const clipboard = await detectClipboard(opts.log);
    if (clipboard) {
      return {
        channel: new ClipboardChannel(clipboard, terminal, opts.webappUrl, opts.log),
        description: `clipboard (${clipboard.description})`,
      };
    }
    opts.log("no clipboard backend found; falling back to manual paste mode");
  }

  return {
    channel: new ManualChannel(terminal, opts.webappUrl, sentinel),
    description: `manual paste (finish with ${sentinel})`,
  };
}
