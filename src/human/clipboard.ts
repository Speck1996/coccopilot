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
