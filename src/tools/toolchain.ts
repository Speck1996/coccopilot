import { spawn } from "node:child_process";

export type Platform = "darwin" | "linux" | "win32" | "other";

export interface ToolSpec {
  /** Canonical name used by `coccopilot install <name>` and the `ensure_tool` tool. */
  name: string;
  /** Human description. */
  description: string;
  /** Binaries to probe, in order. The first one found wins. */
  binaries: string[];
  /** Argument that prints a version (best-effort). */
  versionArgs: string[];
  /** Platform-specific install commands. `{python}` resolves to the detected python. */
  install: Partial<Record<Platform, string>>;
  /** Extra note shown in `doctor` (e.g. runtime prerequisites). */
  note?: string;
}

/**
 * Tools coccopilot knows how to detect and install. Detection is best-effort; the
 * install commands run through the normal shell policy (routine commands need no
 * approval; system/brew installs do).
 */
export const TOOL_SPECS: ToolSpec[] = [
  {
    name: "node",
    description: "Node.js runtime",
    binaries: ["node"],
    versionArgs: ["--version"],
    install: {
      darwin: "brew install node",
      linux: "sudo apt-get install -y nodejs",
      win32: "winget install OpenJS.NodeJS",
    },
  },
  {
    name: "npm",
    description: "npm package manager",
    binaries: ["npm"],
    versionArgs: ["--version"],
    install: { darwin: "brew install node", linux: "sudo apt-get install -y npm", win32: "winget install OpenJS.NodeJS" },
  },
  {
    name: "git",
    description: "Git version control",
    binaries: ["git"],
    versionArgs: ["--version"],
    install: { darwin: "brew install git", linux: "sudo apt-get install -y git", win32: "winget install Git.Git" },
  },
  {
    name: "python",
    description: "Python interpreter (python3 preferred)",
    binaries: ["python3", "python"],
    versionArgs: ["--version"],
    install: {
      darwin: "brew install python",
      linux: "sudo apt-get install -y python3 python3-pip python3-venv",
      win32: "winget install Python.Python.3.12",
    },
  },
  {
    name: "pip",
    description: "Python package manager",
    binaries: ["pip3", "pip"],
    versionArgs: ["--version"],
    install: {
      darwin: "python3 -m ensurepip --upgrade",
      linux: "sudo apt-get install -y python3-pip",
      win32: "python -m ensurepip --upgrade",
    },
  },
  {
    name: "pytest",
    description: "Python test runner",
    binaries: ["pytest"],
    versionArgs: ["--version"],
    install: {
      darwin: "python3 -m pip install --user pytest",
      linux: "python3 -m pip install --user pytest",
      win32: "python -m pip install --user pytest",
    },
    note: "runs via `python3 -m pytest` even if the pytest shim is not on PATH",
  },
  {
    name: "pyspark",
    description: "Apache Spark Python API",
    binaries: ["pyspark", "spark-submit"],
    versionArgs: ["--version"],
    install: {
      darwin: "python3 -m pip install --user pyspark",
      linux: "python3 -m pip install --user pyspark",
      win32: "python -m pip install --user pyspark",
    },
    note: "requires a Java runtime (JDK 8/11/17); install with `brew install openjdk` or `apt-get install -y default-jre`",
  },
  {
    name: "uv",
    description: "Fast Python package/project manager",
    binaries: ["uv"],
    versionArgs: ["--version"],
    install: {
      // Prefer pip over the `curl | sh` installer so the deny-list (downloads piped
      // into a shell) doesn't block it, and so it lands in the active Python env.
      darwin: "python3 -m pip install --user uv",
      linux: "python3 -m pip install --user uv",
      win32: "python -m pip install --user uv",
    },
  },
  {
    name: "docker",
    description: "Docker container runtime",
    binaries: ["docker"],
    versionArgs: ["--version"],
    install: { darwin: "brew install --cask docker", linux: "sudo apt-get install -y docker.io", win32: "winget install Docker.DockerDesktop" },
  },
];

export function currentPlatform(): Platform {
  if (process.platform === "darwin") return "darwin";
  if (process.platform === "linux") return "linux";
  if (process.platform === "win32") return "win32";
  return "other";
}

export function findSpec(name: string): ToolSpec | undefined {
  const key = name.trim().toLowerCase();
  return TOOL_SPECS.find((s) => s.name === key || s.binaries.includes(key));
}

function which(binary: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    const finder = process.platform === "win32" ? "where" : "which";
    const child = spawn(finder, [binary], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    child.stdout?.on("data", (b) => (out += b.toString("utf8")));
    child.on("error", () => resolve(undefined));
    child.on("close", (code) => {
      const first = out.split(/\r?\n/).find((l) => l.trim());
      resolve(code === 0 && first ? first.trim() : undefined);
    });
  });
}

function version(binary: string, args: string[]): Promise<string | undefined> {
  return new Promise((resolve) => {
    const child = spawn(binary, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    const grab = (b: Buffer) => {
      if (out.length < 400) out += b.toString("utf8");
    };
    child.stdout?.on("data", grab);
    child.stderr?.on("data", grab);
    child.on("error", () => resolve(undefined));
    child.on("close", () => {
      const first = out.split(/\r?\n/).find((l) => l.trim());
      resolve(first?.trim() || undefined);
    });
    setTimeout(() => child.kill("SIGKILL"), 5000).unref?.();
  });
}

export interface ToolStatus {
  spec: ToolSpec;
  found: boolean;
  /** Resolved path of the first matching binary. */
  path?: string;
  binary?: string;
  version?: string;
}

export async function detect(spec: ToolSpec): Promise<ToolStatus> {
  for (const binary of spec.binaries) {
    const path = await which(binary);
    if (path) {
      const v = await version(binary, spec.versionArgs);
      return { spec, found: true, path, binary, version: v };
    }
  }
  return { spec, found: false };
}

export async function detectAll(): Promise<ToolStatus[]> {
  return Promise.all(TOOL_SPECS.map((spec) => detect(spec)));
}

/** Resolve the install command for a spec on the current platform. */
export function installCommand(spec: ToolSpec, platform: Platform = currentPlatform()): string | undefined {
  return spec.install[platform];
}
