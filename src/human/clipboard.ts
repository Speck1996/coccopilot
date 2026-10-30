import { spawn } from "node:child_process";

/** A platform clipboard backed by an external command. */
export interface Clipboard {
  /** Human-readable description of the detected backend. */
  readonly description: string;
  /** Read the current clipboard text. Rejects when the backend fails. */
  read(): Promise<string>;
  /** Replace the clipboard contents with `text`. */
  write(text: string): Promise<void>;
}

interface ClipCommand {
  description: string;
  /** Command that prints the clipboard to stdout. */
  read: { file: string; args: string[] };
  /** Command that reads the clipboard from stdin. */
  write: { file: string; args: string[] };
}

const TIMEOUT_MS = 10_000;

/**
 * Candidate clipboard backends, in preference order, per platform. The first one
 * whose read command succeeds during detection wins. coccopilot never bundles a
 * native module; it shells out to what the OS already provides.
 */
function candidates(): ClipCommand[] {
  if (process.platform === "darwin") {
    return [
      {
        description: "pbcopy/pbpaste",
        read: { file: "pbpaste", args: [] },
        write: { file: "pbcopy", args: [] },
      },
    ];
  }
  if (process.platform === "win32") {
    return [
      {
        description: "PowerShell Set-Clipboard/Get-Clipboard",
        read: { file: "powershell", args: ["-NoProfile", "-Command", "Get-Clipboard -Raw"] },
        write: { file: "powershell", args: ["-NoProfile", "-Command", "Set-Clipboard -Value ([Console]::In.ReadToEnd())"] },
      },
    ];
  }
  // Linux/BSD: prefer Wayland, then X11 tools.
  return [
    {
      description: "wl-clipboard (wl-copy/wl-paste)",
      read: { file: "wl-paste", args: ["--no-newline"] },
      write: { file: "wl-copy", args: [] },
    },
    {
      description: "xclip",
      read: { file: "xclip", args: ["-selection", "clipboard", "-o"] },
      write: { file: "xclip", args: ["-selection", "clipboard", "-i"] },
    },
    {
      description: "xsel",
      read: { file: "xsel", args: ["-b", "-o"] },
      write: { file: "xsel", args: ["-b", "-i"] },
    },
  ];
}

function run(file: string, args: string[], input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(new Error(`${file} timed out after ${TIMEOUT_MS}ms`));
    }, TIMEOUT_MS);

    child.stdout?.on("data", (b: Buffer) => {
      stdout += b.toString("utf8");
    });
    child.stderr?.on("data", (b: Buffer) => {
      stderr += b.toString("utf8");
    });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(`${file} exited ${code ?? "?"}${stderr.trim() ? `: ${stderr.trim()}` : ""}`));
    });

    if (input !== undefined) {
      child.stdin?.end(input);
    } else {
      child.stdin?.end();
    }
  });
}

/**
 * Detect a working clipboard backend. Returns null when none is usable (headless
 * server, missing X/Wayland tools, WSL without a clipboard bridge) — the caller
 * then falls back to manual paste mode.
 */
export async function detectClipboard(log?: (msg: string) => void): Promise<Clipboard | null> {
  for (const candidate of candidates()) {
    try {
      await run(candidate.read.file, candidate.read.args);
    } catch {
      continue;
    }
    log?.(`clipboard: using ${candidate.description}`);
    return {
      description: candidate.description,
      read: () => run(candidate.read.file, candidate.read.args),
      write: (text: string) => run(candidate.write.file, candidate.write.args, text).then(() => undefined),
    };
  }
  return null;
}

/** Normalize text for equality checks (trailing newlines differ between tools). */
export function normalizeClipboard(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\s+$/, "").trim();
}

/**
 * True when clipboard text looks like a Copilot reply that carries a coccopilot call.
 * coccopilot's own hand-offs (prefixed `[coccopilot]`, or the cache file with its
 * header comment) are never mistaken for one, even though they quote example blocks.
 */
export function looksLikeToolReply(text: string): boolean {
  const head = text.trimStart();
  if (head.startsWith("[coccopilot]") || head.startsWith("<!-- coccopilot cache")) return false;
  return /```[ \t]*coccopilot/i.test(text) || /["']?tool["']?\s*:\s*["']/.test(text);
}

/** Default interval between clipboard polls while watching for a reply. */
export const WATCH_INTERVAL_MS = 600;

/**
 * Poll the clipboard until it changes to something that looks like a Copilot reply
 * with a coccopilot call, and resolve with it. Whatever is on the clipboard when the
 * watch starts is the baseline, so a stale reply is never taken twice. A candidate is
 * only taken once it has stayed put for two polls: some Copy buttons (M365 Copilot)
 * write the clipboard more than once, and acting on the first write lets the second
 * one land on top of the results. Resolves undefined once `signal` aborts. Read
 * failures are skipped, not fatal: the operator can still paste into the terminal.
 */
export async function watchClipboard(
  clipboard: Clipboard,
  signal: AbortSignal,
  intervalMs = WATCH_INTERVAL_MS,
): Promise<string | undefined> {
  const read = () => clipboard.read().then(normalizeClipboard, () => undefined);
  let baseline = await read();
  let candidate: string | undefined;
  let steadyPolls = 0;
  while (!signal.aborted) {
    await sleep(intervalMs, signal);
    if (signal.aborted) return undefined;
    const text = await read();
    if (text === undefined) continue;
    if (candidate !== undefined && text === candidate) {
      if (++steadyPolls >= 2) return candidate;
      continue;
    }
    if (text === baseline) continue;
    baseline = text;
    candidate = looksLikeToolReply(text) ? text : undefined;
    steadyPolls = 0;
  }
  return undefined;
}

/**
 * For a few seconds after a hand-off, put `text` back if something that looks like a
 * Copilot reply overwrites it — a late second write from a Copy button would otherwise
 * make the operator paste Copilot's own reply instead of the results. No operator can
 * paste, send, and copy a new reply that fast, so nothing legitimate is undone.
 */
export async function guardClipboard(
  clipboard: Clipboard,
  text: string,
  onRestore: () => void,
  windowMs = 4000,
  intervalMs = 250,
): Promise<void> {
  const wanted = normalizeClipboard(text);
  const until = Date.now() + windowMs;
  while (Date.now() < until) {
    await sleep(intervalMs);
    const now = await clipboard.read().then(normalizeClipboard, () => undefined);
    if (now === undefined || now === wanted || !looksLikeToolReply(now)) continue;
    await clipboard.write(text).catch(() => undefined);
    onRestore();
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}
