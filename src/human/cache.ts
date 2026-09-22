import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";

/** Directory (relative to the workspace root) that holds the cache hand-off file. */
export const CACHE_DIRNAME = ".coccopilot";
/** File name of the cache markdown hand-off. */
export const CACHE_FILENAME = "cache.md";

/**
 * Resolve the cache markdown path. Defaults to `<workspace>/.coccopilot/cache.md`; an
 * operator override may be relative to the workspace or absolute. The path is not
 * confined to the workspace — the operator chooses it — so no sandbox check applies.
 */
export function resolveCachePath(workspaceRoot: string, override?: string): string {
  if (override && override.trim()) {
    return isAbsolute(override) ? resolve(override) : resolve(workspaceRoot, override);
  }
  return join(resolve(workspaceRoot), CACHE_DIRNAME, CACHE_FILENAME);
}

export interface CacheMeta {
  /** 1-based turn number, when known. */
  turn?: number;
  /** Number of tool results merged into this frame. */
  results?: number;
}

/**
 * Write the outgoing frame to the cache file, overwriting the previous turn so the
 * operator never re-sends stale content. The write is atomic (temp file + rename) so a
 * file watcher or editor never observes a partial frame. Also drops a `.gitignore` in
 * the cache directory so the file is never committed by the target project.
 */
export async function writeCache(path: string, payload: string, meta: CacheMeta = {}): Promise<void> {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, ".gitignore"), "*\n", "utf8").catch(() => undefined);

  const header = cacheHeader(payload, meta);
  const body = `${header}\n${payload}\n`;
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, body, "utf8");
  await rename(tmp, path);
}

function cacheHeader(payload: string, meta: CacheMeta): string {
  const bits: string[] = ["coccopilot cache"];
  if (meta.turn !== undefined) bits.push(`turn ${meta.turn}`);
  if (meta.results !== undefined) bits.push(`${meta.results} result${meta.results === 1 ? "" : "s"}`);
  bits.push(`${payload.length} chars`);
  bits.push(new Date().toISOString());
  return `<!-- ${bits.join(" · ")} -->`;
}

/** Read the cache file (for diagnostics). Returns "" when it does not exist yet. */
export async function readCache(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return "";
  }
}
