import { isAbsolute, relative, resolve, sep } from "node:path";

export class Workspace {
  readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  /**
   * Resolve `p` against the workspace root and reject anything that escapes it.
   * Relative inputs are resolved from the root; absolute inputs must already live
   * inside the root.
   */
  resolveInside(p: string): string {
    if (!p || typeof p !== "string") {
      throw new Error("path is required");
    }
    if (p.includes("\0")) {
      throw new Error("path contains a NUL byte");
    }

    const abs = isAbsolute(p) ? resolve(p) : resolve(this.root, p);
    const rel = relative(this.root, abs);

    if (rel === "") return abs; // the root itself
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw new Error(`path escapes workspace root: ${p}`);
    }
    return abs;
  }

  relativeToRoot(abs: string): string {
    const rel = relative(this.root, abs);
    return rel === "" ? "." : rel;
  }
}
