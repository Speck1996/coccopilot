import { readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, extname, join, resolve } from "node:path";
import { promptsDir } from "./prompt.js";

/**
 * Skills are roles Copilot takes on for a session (the Developer, the Reviewer, …).
 * Each is a markdown file with a small frontmatter header:
 *
 *   ---
 *   name: reviewer
 *   title: The Reviewer
 *   description: one line shown by `coccopilot skills`
 *   ---
 *   …instructions…
 *
 * Built-ins live in `prompts/skills/`. Custom skills are picked up from the user's
 * `~/.coccopilot/skills/` and the project's `.coccopilot-skills/` (committable, so a
 * team can share them); a later source overrides an earlier one with the same name.
 * A file can also be given directly with `--skill <path>`.
 */
export interface Skill {
  /** Lower-case identifier used in `--skills` and in `@name` task prefixes. */
  name: string;
  title: string;
  description: string;
  body: string;
  source: "built-in" | "user" | "project" | "file";
  path: string;
}

/** Project-level custom skills folder, relative to the workspace root. */
export const PROJECT_SKILLS_DIRNAME = ".coccopilot-skills";

export function userSkillsDir(): string {
  return process.env.COCCOPILOT_SKILLS_DIR ?? join(homedir(), ".coccopilot", "skills");
}

const NAME_RE = /^[a-z0-9][a-z0-9_-]*$/;

function slug(text: string): string {
  return text.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
}

/** Parse one skill file. The frontmatter is optional: name defaults to the file name. */
export function parseSkill(text: string, path: string, source: Skill["source"]): Skill {
  const fields: Record<string, string> = {};
  let body = text.replace(/^﻿/, "");
  const fm = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(body);
  if (fm) {
    for (const line of fm[1].split(/\r?\n/)) {
      const m = /^\s*([A-Za-z_]+)\s*:\s*(.*?)\s*$/.exec(line);
      if (m) fields[m[1].toLowerCase()] = m[2].replace(/^["']|["']$/g, "");
    }
    body = body.slice(fm[0].length);
  }
  const name = slug(fields.name ?? basename(path, extname(path)));
  if (!NAME_RE.test(name)) throw new Error(`skill ${path}: invalid name "${fields.name ?? path}"`);
  body = body.trim();
  if (!body) throw new Error(`skill ${path}: no instructions after the frontmatter`);
  const title = fields.title || `The ${name[0].toUpperCase()}${name.slice(1)}`;
  return { name, title, description: fields.description ?? "", body, source, path };
}

async function loadDir(dir: string, source: Skill["source"]): Promise<Skill[]> {
  if (!existsSync(dir)) return [];
  const files = (await readdir(dir)).filter((f) => f.toLowerCase().endsWith(".md")).sort();
  return Promise.all(files.map(async (f) => parseSkill(await readFile(join(dir, f), "utf8"), join(dir, f), source)));
}

export async function loadSkillFile(path: string): Promise<Skill> {
  const abs = resolve(path);
  return parseSkill(await readFile(abs, "utf8"), abs, "file");
}

/** Every skill available to a workspace, keyed by name (later sources win). */
export async function discoverSkills(workspaceRoot: string): Promise<Map<string, Skill>> {
  const sources = [
    await loadDir(join(promptsDir, "skills"), "built-in"),
    await loadDir(userSkillsDir(), "user"),
    await loadDir(join(resolve(workspaceRoot), PROJECT_SKILLS_DIRNAME), "project"),
  ];
  const all = new Map<string, Skill>();
  for (const skill of sources.flat()) all.set(skill.name, skill);
  return all;
}

/** Split a `--skills` value ("developer,reviewer", "all", "none") into names. */
export function parseSkillList(value: string | undefined): string[] {
  if (!value) return [];
  return value.split(/[\s,]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
}

/**
 * Resolve the active skills: the named ones (in the order given; `all` expands to every
 * available skill, `none` clears the list) followed by any loaded from `--skill <file>`.
 */
export async function resolveSkills(
  workspaceRoot: string,
  names: string[],
  files: string[] = [],
): Promise<Skill[]> {
  const available = await discoverSkills(workspaceRoot);
  const picked = new Map<string, Skill>();
  for (const name of names) {
    if (name === "none") picked.clear();
    else if (name === "all") for (const s of available.values()) picked.set(s.name, s);
    else {
      const skill = available.get(name);
      if (!skill) {
        throw new Error(`unknown skill "${name}" (available: ${[...available.keys()].join(", ") || "none"})`);
      }
      picked.set(skill.name, skill);
    }
  }
  for (const file of files) {
    const skill = await loadSkillFile(file);
    picked.set(skill.name, skill);
  }
  return [...picked.values()];
}

/**
 * The "Roles" section appended to the primer (agent mode) or the kick-off message
 * (pack mode). Empty when no skill is active, so the prompts are unchanged by default.
 */
export function renderSkills(skills: Skill[], mode: "agent" | "pack" = "agent"): string {
  if (skills.length === 0) return "";
  const names = skills.map((s) => `\`@${s.name}\``).join(", ");
  const head = [
    "## Roles",
    "",
    skills.length === 1
      ? `For this session, work as ${skills[0].title} described below, on every task.`
      : `For this session you have ${skills.length} roles, described below. On every task, work through them in the order ` +
        "listed, each one building on the previous one's work. When my task starts with a role tag " +
        `(${names}), work only in that role for that task.`,
    "Name the role you are working in when you switch, in one short line. The roles change how you work, " +
      "not the rules above: they still apply in full.",
  ];
  if (mode === "pack") {
    head.push(
      "You can't run anything here: where a role says to run tests or checks, write them in the change set " +
        "and tell me the command to run.",
    );
  }
  const sections = skills.map((s) => `### ${s.title} (\`@${s.name}\`)\n\n${s.body}`);
  return [head.join("\n"), ...sections].join("\n\n");
}

/** Short listing for `coccopilot skills`. */
export function describeSkills(skills: Iterable<Skill>): string {
  const rows = [...skills].map((s) => `  ${s.name.padEnd(12)} ${s.description || s.title}  [${s.source}]`);
  return rows.join("\n");
}
