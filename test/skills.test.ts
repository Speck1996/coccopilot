import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  discoverSkills,
  parseSkill,
  parseSkillList,
  PROJECT_SKILLS_DIRNAME,
  renderSkills,
  resolveSkills,
} from "../src/agent/skills.js";
import { loadSystemPrompt } from "../src/agent/prompt.js";
import { kickoffMessage, parsePackArgs } from "../src/pack/commands.js";
import { emptyWorkspace, removeWorkspace } from "./support/harness.js";

// Keep the operator's real ~/.coccopilot/skills out of the tests.
process.env.COCCOPILOT_SKILLS_DIR = join(process.cwd(), "test", "fixtures", "no-such-dir");

test("skills: the four built-ins are available with titles and descriptions", async () => {
  const dir = await emptyWorkspace();
  try {
    const skills = await discoverSkills(dir);
    for (const name of ["developer", "simplifier", "reviewer", "documenter"]) {
      const s = skills.get(name);
      assert.ok(s, `${name} missing`);
      assert.equal(s.source, "built-in");
      assert.ok(s.description.length > 0);
      assert.match(s.title, /^The /);
      assert.doesNotMatch(s.body, /^---/);
    }
    assert.match(skills.get("developer")!.body, /Reviewer/, "developer is coupled with the reviewer");
  } finally {
    await removeWorkspace(dir);
  }
});

test("skills: frontmatter is optional and the name falls back to the file name", () => {
  const s = parseSkill("Be terse.\n", "/x/Data Engineer.md", "file");
  assert.equal(s.name, "data-engineer");
  assert.equal(s.title, "The Data-engineer");
  assert.equal(s.body, "Be terse.");
  assert.throws(() => parseSkill("---\nname: x\n---\n\n", "/x/x.md", "file"), /no instructions/);
});

test("skills: project skills are discovered and override built-ins by name", async () => {
  const dir = await emptyWorkspace();
  try {
    await mkdir(join(dir, PROJECT_SKILLS_DIRNAME));
    await writeFile(
      join(dir, PROJECT_SKILLS_DIRNAME, "sre.md"),
      "---\nname: sre\ntitle: The SRE\ndescription: keeps it running\n---\nWatch the error budget.\n",
    );
    await writeFile(join(dir, PROJECT_SKILLS_DIRNAME, "reviewer.md"), "---\nname: reviewer\n---\nOur own review rules.\n");
    const picked = await resolveSkills(dir, ["sre", "reviewer"]);
    assert.deepEqual(picked.map((s) => [s.name, s.source]), [["sre", "project"], ["reviewer", "project"]]);
    assert.equal(picked[1].body, "Our own review rules.");
  } finally {
    await removeWorkspace(dir);
  }
});

test("skills: resolve keeps order, expands all, and loads --skill files", async () => {
  const dir = await emptyWorkspace();
  try {
    const custom = join(dir, "mine.md");
    await writeFile(custom, "---\nname: mine\n---\nDo it my way.\n");
    assert.deepEqual((await resolveSkills(dir, ["reviewer", "developer"])).map((s) => s.name), ["reviewer", "developer"]);
    assert.equal((await resolveSkills(dir, ["all"])).length, 4);
    assert.deepEqual((await resolveSkills(dir, ["all", "none"], [custom])).map((s) => s.name), ["mine"]);
    await assert.rejects(resolveSkills(dir, ["wizard"]), /unknown skill "wizard".*developer/);
  } finally {
    await removeWorkspace(dir);
  }
});

test("skills: rendered into the primer and the pack kick-off, absent by default", async () => {
  const dir = await emptyWorkspace();
  try {
    const skills = await resolveSkills(dir, parseSkillList("developer, reviewer"));
    const block = renderSkills(skills);
    assert.match(block, /^## Roles/);
    assert.match(block, /`@developer`, `@reviewer`/);
    assert.match(block, /### The Developer \(`@developer`\)/);
    assert.doesNotMatch(block, /can't run anything/);

    const plain = await loadSystemPrompt("TOOLS");
    assert.doesNotMatch(plain, /## Roles/);
    const primed = await loadSystemPrompt("TOOLS", block);
    assert.ok(primed.startsWith(plain.trimEnd()));
    assert.ok(primed.trimEnd().endsWith(skills[1].body));

    const kickoff = kickoffMessage(["p.txt"], "INSTR", "fix it", "txt", skills);
    assert.match(kickoff, /## Roles[\s\S]*can't run anything[\s\S]*My task: fix it$/);
    assert.doesNotMatch(kickoffMessage(["p.txt"], "INSTR", "fix it"), /## Roles/);
    assert.equal(renderSkills([]), "");
  } finally {
    await removeWorkspace(dir);
  }
});

test("skills: pack accepts --skills and --skill", () => {
  const args = parsePackArgs(["--skills", "developer,reviewer", "--skills", "documenter", "--skill", "a.md", "task"]);
  assert.deepEqual(args.skills, ["developer", "reviewer", "documenter"]);
  assert.deepEqual(args.skillFiles, ["a.md"]);
  assert.equal(args.task, "task");
  assert.equal(parsePackArgs([]).skills, undefined);
});
