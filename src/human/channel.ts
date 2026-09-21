import { detectClipboard, normalizeClipboard, type Clipboard } from "./clipboard.js";
import { HumanTerminal } from "./terminal.js";
import { TranscriptChannel } from "./transcript.js";

/**
 * The human-in-the-loop transport to the Copilot webapp. coccopilot never touches
 * the browser: the operator drives it. A channel only renders text for the operator
 * to send and captures the text the operator brings back.
 */
export interface CopilotChannel {
  readonly mode: "clipboard" | "manual";
  /** Render an outgoing message and hand it to the operator (clipboard or print). */
  send(message: string): Promise<void>;
  /**
   * Wait for the operator to bring back Copilot's reply. `status` is a compact
   * progress line coccopilot shows beside the input prompt (e.g. the current step).
   */
  receive(status?: string): Promise<string>;
  /** Update the status line between turns, when the backend supports it. */
  report?(status: string): void;
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
  /** Inject a clipboard backend instead of detecting one (used by tests). */
  clipboard?: Clipboard | null;
  /**
   * Largest outgoing message (characters) to hand over in one paste. Messages above
   * this are split into numbered parts; the Copilot composer rejects oversized
   * pastes outright, so a large `TOOL RESULT` frame must not arrive in one go.
   * Zero or undefined disables splitting.
   */
  maxMessageChars?: number;
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
class ClipboardChannel extends TranscriptChannel {
  readonly mode = "clipboard" as const;
  private lastSent = "";
  private instructionsShown = false;

  constructor(
    private readonly clipboard: Clipboard,
    private readonly terminal: HumanTerminal,
    private readonly webappUrl: string,
    private readonly log: (msg: string) => void,
    maxMessageChars?: number,
  ) {
    super(maxMessageChars);
  }

  protected async onSend(message: string): Promise<void> {
    await this.clipboard.write(message);
    this.lastSent = message;
    this.terminal.write(`\n${RULE}`);
    if (this.wasSplit) {
      this.terminal.write(
        `[coccopilot] copied part ${this.partNumber}/${this.partCount} (${charCount(message)}). ` +
          "Paste it, send; then press Enter here to copy the next part.",
      );
    } else if (!this.instructionsShown) {
      // The numbered steps are the same every turn; show them once so a long task
      // is not buried under a wall of repeated instructions.
      this.instructionsShown = true;
      this.terminal.write(`[coccopilot] message copied to your clipboard (${charCount(message)}).`);
      this.terminal.write("");
      this.terminal.write(`  1. Open the Copilot webapp:  ${this.webappUrl}`);
      this.terminal.write("  2. Paste it into the composer and send.");
      this.terminal.write("  3. Select Copilot's full reply and copy it (Cmd/Ctrl+C).");
    } else {
      this.terminal.write(`[coccopilot] copied to clipboard (${charCount(message)}) — paste, send, copy the reply.`);
    }
    this.terminal.write(`${RULE}`);
  }

  protected async beforeNextPart(index: number, total: number): Promise<boolean> {
    this.terminal.write(
      `[coccopilot] press Enter to copy part ${index}/${total} once you have sent part ${index - 1}.`,
    );
    await this.terminal.nextLine();
    // Piped/scripted stdin closes while buffered lines remain; keep delivering as
    // long as more input is queued.
    return !this.terminal.isClosed || this.terminal.hasBufferedInput();
  }

  protected async nextReply(status?: string): Promise<string> {
    while (true) {
      this.terminal.write(
        `[coccopilot] ${compactStatus(status)}Press Enter once Copilot's reply is on your clipboard.`,
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
}

/** Manual channel: no clipboard. The operator pastes the reply into the terminal. */
class ManualChannel extends TranscriptChannel {
  readonly mode = "manual" as const;

  constructor(
    private readonly terminal: HumanTerminal,
    private readonly webappUrl: string,
    private readonly sentinel: string,
    maxMessageChars?: number,
  ) {
    super(maxMessageChars);
  }

  protected async onSend(message: string): Promise<void> {
    this.terminal.write(`\n${RULE}`);
    this.terminal.write(
      this.wasSplit
        ? `[coccopilot] send part ${this.partNumber}/${this.partCount} to Copilot, then press Enter for the next part:`
        : `[coccopilot] send this to Copilot (${charCount(message)}):`,
    );
    this.terminal.write(`${RULE}`);
    this.terminal.write(message);
    this.terminal.write(`${RULE}`);
    this.terminal.write(`Open the Copilot webapp: ${this.webappUrl}`);
    this.terminal.write("Select the text above, paste it into the composer, and send.");
  }

  protected async beforeNextPart(index: number, total: number): Promise<boolean> {
    this.terminal.write(
      `[coccopilot] press Enter to print part ${index}/${total} once you have sent part ${index - 1}.`,
    );
    await this.terminal.nextLine();
    // Piped/scripted stdin closes while buffered lines remain; keep delivering as
    // long as more input is queued.
    return !this.terminal.isClosed || this.terminal.hasBufferedInput();
  }

  protected async nextReply(status?: string): Promise<string> {
    this.terminal.write(
      `[coccopilot] ${compactStatus(status)}Paste Copilot's reply below; finish with a line containing only ${this.sentinel}.`,
    );
    return this.terminal.readUntil(this.sentinel);
  }
}

/** Bracketed progress prefix shown beside the input prompt, when a status is known. */
function compactStatus(status?: string): string {
  return status ? `[${status}] ` : "";
}

/**
 * Build the channel. Prefers the clipboard; falls back to manual paste when no
 * backend is detected or `forceManual` is set.
 */
export async function createChannel(opts: ChannelOptions): Promise<ChannelHandle> {
  const terminal = opts.terminal;
  const sentinel = opts.sentinel ?? DEFAULT_SENTINEL;

  if (!opts.forceManual) {
    const clipboard = opts.clipboard ?? (await detectClipboard(opts.log));
    if (clipboard) {
      return {
        channel: new ClipboardChannel(clipboard, terminal, opts.webappUrl, opts.log, opts.maxMessageChars),
        description: `clipboard (${clipboard.description})`,
      };
    }
    opts.log("no clipboard backend found; falling back to manual paste mode");
  }

  return {
    channel: new ManualChannel(terminal, opts.webappUrl, sentinel, opts.maxMessageChars),
    description: `manual paste (finish with ${sentinel})`,
  };
}
