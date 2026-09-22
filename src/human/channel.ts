import { detectClipboard, normalizeClipboard, type Clipboard } from "./clipboard.js";
import { resolveCachePath, writeCache } from "./cache.js";
import { HumanTerminal } from "./terminal.js";
import { TranscriptChannel } from "./transcript.js";

/**
 * The human-in-the-loop transport to the Copilot webapp. coccopilot never touches
 * the browser: the operator drives it. A channel only renders text for the operator
 * to send and captures the text the operator brings back.
 */
export interface CopilotChannel {
  readonly mode: "clipboard" | "manual" | "cache";
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
  /**
   * Inject a clipboard backend instead of detecting one (used by tests). `undefined`
   * auto-detects; an explicit `null` means "no clipboard available".
   */
  clipboard?: Clipboard | null;
  /**
   * Use the cache markdown file as the primary transport. The outgoing frame is
   * written to a file the operator attaches/copies from, which is not bound by the
   * Copilot composer's paste limit.
   */
  cache?: boolean;
  /** Cache markdown path. Defaults to `<workspace>/​.coccopilot/cache.md`. */
  cachePath?: string;
  /** Workspace root, used to resolve the default cache path. */
  workspaceRoot?: string;
  /**
   * Largest outgoing message (characters) to hand over in one paste. In clipboard
   * mode, messages above this are split into numbered parts; in cache mode it is the
   * cap above which the frame is written to the file only (the clipboard is skipped).
   * Zero or undefined disables splitting/capping.
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

/**
 * Cache channel: the outgoing frame is written to a markdown cache file (overwritten
 * each turn), which the operator attaches or opens to hand to Copilot. This sidesteps
 * the composer's paste limit, so a large batched `TOOL RESULT` frame arrives intact.
 * When a clipboard is available and the frame fits, it is also copied, so a small turn
 * can still be pasted directly. Replies are pasted into the terminal, with bare Enter
 * reading the clipboard as the fast path.
 */
class CacheChannel extends TranscriptChannel {
  readonly mode = "cache" as const;
  private lastCopied = "";
  private instructionsShown = false;

  private readonly sentinel: string;

  constructor(
    private readonly cachePath: string,
    private readonly terminal: HumanTerminal,
    private readonly webappUrl: string,
    sentinel: string,
    private readonly log: (msg: string) => void,
    private readonly clipboard: Clipboard | null,
    private readonly clipboardCap?: number,
  ) {
    // The file is the transport, so never split the frame into parts.
    super(0);
    this.sentinel = sentinel;
  }

  protected async onSend(message: string): Promise<void> {
    await writeCache(this.cachePath, message);

    const fits = this.clipboard !== null && (!this.clipboardCap || message.length <= this.clipboardCap);
    if (fits && this.clipboard) {
      try {
        await this.clipboard.write(message);
        this.lastCopied = message;
      } catch (err) {
        this.log(`clipboard write failed: ${(err as Error).message}`);
      }
    } else {
      this.lastCopied = "";
    }

    this.terminal.write(`\n${RULE}`);
    if (!this.instructionsShown) {
      this.instructionsShown = true;
      this.terminal.write(
        `[coccopilot] results written to ${this.cachePath} (${charCount(message)}).`,
      );
      if (this.lastCopied) {
        this.terminal.write(`[coccopilot] also copied to your clipboard (fits the paste limit).`);
      } else if (this.clipboard) {
        this.terminal.write(
          `[coccopilot] too large for the composer — attach or open the cache file instead.`,
        );
      } else {
        this.terminal.write(
          `[coccopilot] no clipboard — attach or open the cache file, then send it to Copilot.`,
        );
      }
      this.terminal.write("");
      this.terminal.write(`  1. Open the Copilot webapp:  ${this.webappUrl}`);
      this.terminal.write(
        this.lastCopied
          ? "  2. Paste the copied results into the composer and send."
          : "  2. Attach the cache file (or copy its contents) and send it.",
      );
      this.terminal.write("  3. Copy/select Copilot's full reply.");
    } else {
      const how = this.lastCopied ? "also copied to clipboard" : "written to the cache file";
      this.terminal.write(`[coccopilot] results ${how} (${charCount(message)}).`);
    }
    this.terminal.write(`${RULE}`);
  }

  protected async nextReply(status?: string): Promise<string> {
    while (true) {
      const hint = this.clipboard ? " (Or just press Enter to read the clipboard.)" : "";
      this.terminal.write(
        `[coccopilot] ${compactStatus(status)}Paste Copilot's reply below; finish with a line containing only ${this.sentinel}.${hint}`,
      );
      const first = await this.terminal.nextLine();
      const closed = this.terminal.isClosed;

      // A bare Enter means "read the clipboard" — handy when the operator copied the
      // reply rather than typing it.
      if (first.trim().length === 0) {
        if (closed) return "";
        if (!this.clipboard) {
          this.terminal.write(
            "[coccopilot] nothing pasted and no clipboard backend — paste the reply, then the sentinel.",
          );
          continue;
        }
        let text: string;
        try {
          text = await this.clipboard.read();
        } catch (err) {
          this.log(`clipboard read failed: ${(err as Error).message}`);
          this.terminal.write("[coccopilot] could not read the clipboard; paste the reply, then the sentinel.");
          continue;
        }
        if (!text.trim()) {
          this.terminal.write("[coccopilot] the clipboard is empty — paste Copilot's reply, then the sentinel.");
          continue;
        }
        if (this.lastCopied && normalizeClipboard(text) === normalizeClipboard(this.lastCopied)) {
          this.terminal.write(
            "[coccopilot] the clipboard still holds the message we gave you — paste Copilot's reply instead.",
          );
          continue;
        }
        return text;
      }

      // The first line begins a pasted reply; collect the rest until the sentinel. A
      // closed stdin (piped input) ends the paste after the buffered lines.
      const rest = await this.terminal.readUntil(this.sentinel);
      return rest ? `${first}\n${rest}` : first;
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

  // A clipboard backend is useful in every mode: cache mode copies small frames to it,
  // clipboard mode requires it, manual mode falls back gracefully without one.
  // `forceManual` means "do not touch the clipboard at all"; an explicit `null` injects
  // "no clipboard" (used by tests) without triggering detection.
  const clipboard = opts.forceManual
    ? null
    : opts.clipboard !== undefined
      ? opts.clipboard
      : await detectClipboard(opts.log);

  if (opts.cache) {
    const cachePath = resolveCachePath(opts.workspaceRoot ?? process.cwd(), opts.cachePath);
    const handle = clipboard
      ? `, clipboard copy when ≤ ${opts.maxMessageChars ?? "∞"} chars`
      : ", file only";
    return {
      channel: new CacheChannel(
        cachePath,
        terminal,
        opts.webappUrl,
        sentinel,
        opts.log,
        clipboard,
        opts.maxMessageChars,
      ),
      description: `cache file (${cachePath})${handle}`,
    };
  }

  if (!opts.forceManual) {
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
