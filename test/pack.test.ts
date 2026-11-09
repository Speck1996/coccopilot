import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { encodeFile, INSTRUCTIONS_CLOSE, INSTRUCTIONS_OPEN, parseChanges } from "../src/pack/format.js";
import { buildPack, excludeMatcher, renderTree } from "../src/pack/pack.js";
import { crc32, packToDocx } from "../src/pack/docx.js";
import { parsePackArgs, partPath, resolveFormat } from "../src/pack/commands.js";
import { inflateRawSync } from "node:zlib";
import { describePlan, planChanges, writePlan } from "../src/pack/apply.js";
import { Workspace } from "../src/sandbox/workspace.js";
import { emptyWorkspace, removeWorkspace, workspaceFromFixture } from "./support/harness.js";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function applyText(dir: string, text: string) {
  const parsed = parseChanges(text);
  const workspace = new Workspace(dir);
  const plan = await planChanges(workspace, parsed.ops);
  return { parsed, plan, workspace };
}

test("pack format: tricky contents round-trip exactly", () => {
  const files: Record<string, string> = {
    "a.txt": "one\ntwo\n",
    "no-eol.txt": "last line has no newline",
    "empty.txt": "",
    "blank.txt": "\n",
    "markers.md": "@@@ END markers.md\n@@@ FILE fake.ts\n<<<<<<< SEARCH\n",
  };
  const text = Object.entries(files).map(([p, c]) => encodeFile(p, c)).join("\n");
  const parsed = parseChanges(text);
  assert.deepEqual(parsed.errors, []);
  assert.deepEqual(
    Object.fromEntries(parsed.ops.map((op) => [op.kind === "file" ? op.path : "?", op.kind === "file" ? op.content : ""])),
    files,
  );
});

test("pack: the fixture packs with a tree and unpacks into an identical copy", async () => {
  const src = await workspaceFromFixture();
  const dst = await emptyWorkspace();
  try {
    await writeFile(join(src, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 1]));
    await writeFile(join(src, "package-lock.json"), "{}\n");
    const pack = await buildPack({ root: src, instructions: "INSTRUCTIONS GO HERE" });
    assert.equal(pack.parts.length, 1);
    const text = pack.parts[0];
    assert.match(text, /^@@@ COCCOPILOT PACK v1/);
    assert.match(text, /INSTRUCTIONS GO HERE/);
    assert.match(text, /logo\.png {2}\(not included: binary/);
    assert.match(text, /package-lock\.json {2}\(not included: generated\)/);

    const { plan, workspace } = await applyText(dst, text);
    assert.deepEqual(plan.failures, []);
    await writePlan(workspace, plan);
    for (const rel of ["README.md", "package.json", "src/greet.js", "src/greet.test.js"]) {
      assert.equal(await readFile(join(dst, rel), "utf8"), await readFile(join(src, rel), "utf8"), rel);
    }
    assert.ok(!existsSync(join(dst, "logo.png")), "binaries are listed, not inlined");

    // Applying the pack to its own source changes nothing.
    const again = await applyText(src, text);
    assert.equal(again.plan.changes.length, 0);
  } finally {
    await removeWorkspace(src);
    await removeWorkspace(dst);
  }
});

test("pack: --max-chars splits into parts without splitting a file", async () => {
  const src = await workspaceFromFixture();
  try {
    const pack = await buildPack({ root: src, instructions: "x", maxChars: 200 });
    assert.ok(pack.parts.length > 1);
    assert.match(pack.parts[0], /@@@ TREE/);
    assert.match(pack.parts[1], /part 2\/\d+/);
    assert.doesNotMatch(pack.parts[1], /@@@ TREE/);
    const ops = pack.parts.flatMap((p) => parseChanges(p).ops);
    assert.equal(ops.length, 4);
  } finally {
    await removeWorkspace(src);
  }
});

test("pack: the tree collapses single-child directory chains", () => {
  const tree = renderTree("app", [
    { path: "src/main/java/com/acme/App.java", bytes: 1 },
    { path: "src/main/java/com/acme/util/Strings.java", bytes: 1 },
    { path: "README.md", bytes: 1 },
  ]);
  assert.equal(tree, ["app/", "  src/main/java/com/acme/", "    util/", "      Strings.java", "    App.java", "  README.md"].join("\n"));
});

test("pack: exclude globs match paths, segments and directories", () => {
  const isExcluded = excludeMatcher(["*.min.js", "vendor/", "docs/*.md"]);
  assert.ok(isExcluded("web/app.min.js"));
  assert.ok(isExcluded("lib/vendor/x/y.js"));
  assert.ok(isExcluded("docs/a.md"));
  assert.ok(!isExcluded("docs/sub/a.md"));
  assert.ok(!isExcluded("src/app.js"));
});

const reply = (body: string) =>
  "Here are the changes: I added a farewell function and a test.\n\n~~~~text\n" + body + "\n~~~~\n\nLet me know how it goes.";

test("apply: a Copilot reply with EDIT, FILE, RENAME and DELETE applies", async () => {
  const dir = await workspaceFromFixture();
  try {
    const original = await readFile(join(dir, "src/greet.js"), "utf8");
    const firstLine = original.split("\n")[0];
    const text = reply(
      [
        "@@@ EDIT src/greet.js",
        "<<<<<<< SEARCH",
        firstLine,
        "=======",
        "// greeting helpers",
        firstLine,
        ">>>>>>> REPLACE",
        "@@@ END src/greet.js",
        "@@@ FILE src/farewell.js",
        "export const bye = (n) => `bye ${n}`;",
        "@@@ END src/farewell.js",
        "@@@ RENAME README.md -> docs/README.md",
        "@@@ DELETE src/greet.test.js",
      ].join("\n"),
    );
    const { parsed, plan, workspace } = await applyText(dir, text);
    assert.deepEqual(parsed.errors, []);
    assert.deepEqual(plan.failures, []);
    assert.deepEqual(describePlan(plan), [
      "R  README.md -> docs/README.md",
      "A  src/farewell.js (+1)",
      "M  src/greet.js (+1 -0)",
      "D  src/greet.test.js (-" + (await readFile(join(dir, "src/greet.test.js"), "utf8")).trimEnd().split("\n").length + ")",
    ]);
    await writePlan(workspace, plan);
    assert.equal(await readFile(join(dir, "src/greet.js"), "utf8"), "// greeting helpers\n" + original);
    assert.equal(await readFile(join(dir, "src/farewell.js"), "utf8"), "export const bye = (n) => `bye ${n}`;\n");
    assert.ok(existsSync(join(dir, "docs/README.md")) && !existsSync(join(dir, "README.md")));
    assert.ok(!existsSync(join(dir, "src/greet.test.js")));
  } finally {
    await removeWorkspace(dir);
  }
});

test("apply: SEARCH tolerates trailing whitespace and re-indents an indentation-only mismatch", async () => {
  const dir = await emptyWorkspace();
  try {
    await writeFile(join(dir, "f.py"), "def f():\n    if x:\n        return 1   \n    return 0\n");
    const text = [
      "@@@ EDIT f.py",
      "<<<<<<< SEARCH",
      "if x:",
      "    return 1",
      "=======",
      "if x:",
      "    log()",
      "    return 1",
      ">>>>>>> REPLACE",
      "@@@ END f.py",
    ].join("\n");
    const { plan, workspace } = await applyText(dir, text);
    assert.deepEqual(plan.failures, []);
    await writePlan(workspace, plan);
    assert.equal(await readFile(join(dir, "f.py"), "utf8"), "def f():\n    if x:\n        log()\n        return 1\n    return 0\n");
  } finally {
    await removeWorkspace(dir);
  }
});

test("apply: a SEARCH that drops blank lines still lands (seen on M365 Copilot)", async () => {
  const dir = await emptyWorkspace();
  try {
    await writeFile(join(dir, "README.md"), "# title\n\nIntro text.\n\nMore.\n");
    const text = "@@@ EDIT README.md\n<<<<<<< SEARCH\n# title\nIntro text.\n=======\n# title\n\nIntro text.\n\n## Usage\n>>>>>>> REPLACE\n@@@ END README.md";
    const { plan, workspace } = await applyText(dir, text);
    assert.deepEqual(plan.failures, []);
    await writePlan(workspace, plan);
    assert.equal(await readFile(join(dir, "README.md"), "utf8"), "# title\n\nIntro text.\n\n## Usage\n\nMore.\n");
  } finally {
    await removeWorkspace(dir);
  }
});

test("apply: a failing block writes nothing and shows Copilot the real text", async () => {
  const dir = await emptyWorkspace();
  try {
    await writeFile(join(dir, "a.js"), "const a = 1;\nconst b = 2;\n");
    await writeFile(join(dir, "dup.js"), "x();\nx();\n");
    const text = [
      "@@@ FILE new.js",
      "ok",
      "@@@ END new.js",
      "@@@ EDIT a.js",
      "<<<<<<< SEARCH",
      "const b = 3;",
      "=======",
      "const b = 4;",
      ">>>>>>> REPLACE",
      "@@@ END a.js",
      "@@@ EDIT dup.js",
      "<<<<<<< SEARCH",
      "x();",
      "=======",
      "y();",
      ">>>>>>> REPLACE",
      "@@@ END dup.js",
    ].join("\n");
    const { plan } = await applyText(dir, text);
    assert.equal(plan.failures.length, 2);
    assert.match(plan.failures[0], /EDIT a\.js: the SEARCH text was not found/);
    assert.match(plan.failures[0], /const b = 2;/, "the nearby real text is quoted");
    assert.match(plan.failures[1], /matches 2 places/);
    assert.ok(!existsSync(join(dir, "new.js")), "planning never writes");
  } finally {
    await removeWorkspace(dir);
  }
});

test("apply: CRLF files keep their line endings", async () => {
  const dir = await emptyWorkspace();
  try {
    await writeFile(join(dir, "w.txt"), "alpha\r\nbeta\r\n");
    const text = "@@@ EDIT w.txt\n<<<<<<< SEARCH\nbeta\n=======\ngamma\n>>>>>>> REPLACE\n@@@ END w.txt";
    const { plan, workspace } = await applyText(dir, text);
    await writePlan(workspace, plan);
    assert.equal(await readFile(join(dir, "w.txt"), "utf8"), "alpha\r\ngamma\r\n");
  } finally {
    await removeWorkspace(dir);
  }
});

test("apply: paths outside the workspace or into .git are refused", async () => {
  const dir = await emptyWorkspace();
  try {
    const text = "@@@ FILE ../escape.txt\nx\n@@@ END\n@@@ FILE .git/config\nx\n@@@ END";
    const { plan } = await applyText(dir, text);
    assert.equal(plan.changes.length, 0);
    assert.equal(plan.failures.length, 2);
  } finally {
    await removeWorkspace(dir);
  }
});

test("apply: tolerates a missing END, a fenced FILE body, and skips the format's own examples", () => {
  const text = [
    INSTRUCTIONS_OPEN,
    "@@@ DELETE example.ts",
    INSTRUCTIONS_CLOSE,
    "@@@ FILE src/a.ts",
    "```ts",
    "export const a = 1;",
    "```",
    "@@@ FILE `src/b.ts`",
    "export const b = 2;",
    "~~~~",
  ].join("\n");
  const parsed = parseChanges(text);
  assert.deepEqual(
    parsed.ops.map((op) => (op.kind === "file" ? [op.path, op.content] : op.kind)),
    [
      ["src/a.ts", "export const a = 1;\n"],
      ["src/b.ts", "export const b = 2;\n"],
    ],
  );
  assert.equal(parsed.warnings.length, 2);
});

function runCli(args: string[], stdin = ""): Promise<{ code: number | null; stdout: string }> {
  return new Promise((done) => {
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const child = spawn(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], { cwd: REPO, env });
    let stdout = "";
    child.stdout.on("data", (b: Buffer) => (stdout += b.toString("utf8")));
    child.stderr.on("data", (b: Buffer) => (stdout += b.toString("utf8")));
    child.on("close", (code) => done({ code, stdout }));
    child.stdin.end(stdin);
  });
}

test("e2e: coccopilot pack, then coccopilot apply from a file and from stdin", { timeout: 30_000 }, async () => {
  const dir = await workspaceFromFixture();
  try {
    const packed = await runCli(["pack", "--no-clipboard", "--cwd", dir, "add a farewell module"]);
    assert.equal(packed.code, 0, packed.stdout);
    const packPath = join(dir, ".coccopilot", `${dir.split("/").pop()}.pack.txt`);
    assert.ok(existsSync(packPath), packed.stdout);
    assert.match(packed.stdout, /My task: add a farewell module/);
    assert.match(await readFile(join(dir, ".coccopilot", ".gitignore"), "utf8"), /\*/);

    const changes = join(dir, "changes.txt");
    await mkdir(dirname(changes), { recursive: true });
    await writeFile(changes, reply("@@@ FILE src/farewell.js\nexport const bye = 1;\n@@@ END src/farewell.js"));
    const dry = await runCli(["apply", changes, "--dry-run", "--no-clipboard", "--cwd", dir]);
    assert.match(dry.stdout, /A {2}src\/farewell\.js/);
    assert.ok(!existsSync(join(dir, "src/farewell.js")));

    const unconfirmed = await runCli(["apply", changes, "--no-clipboard", "--cwd", dir]);
    assert.equal(unconfirmed.code, 1);
    assert.match(unconfirmed.stdout, /pass -y/);

    const applied = await runCli(["apply", "-", "-y", "--no-clipboard", "--cwd", dir], await readFile(changes, "utf8"));
    assert.equal(applied.code, 0, applied.stdout);
    assert.equal(await readFile(join(dir, "src/farewell.js"), "utf8"), "export const bye = 1;\n");
  } finally {
    await removeWorkspace(dir);
  }
});

/** Read the entries of a zip written by our writer (sizes are in the local headers). */
function unzip(buf: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  let at = 0;
  while (buf.readUInt32LE(at) === 0x04034b50) {
    const crc = buf.readUInt32LE(at + 14);
    const size = buf.readUInt32LE(at + 18);
    const nameLen = buf.readUInt16LE(at + 26);
    const extraLen = buf.readUInt16LE(at + 28);
    const name = buf.subarray(at + 30, at + 30 + nameLen).toString("utf8");
    const start = at + 30 + nameLen + extraLen;
    const data = inflateRawSync(buf.subarray(start, start + size));
    assert.equal(crc32(data), crc, `crc of ${name}`);
    out.set(name, data);
    at = start + size;
  }
  assert.equal(buf.readUInt32LE(buf.length - 22), 0x06054b50, "end of central directory");
  return out;
}

/** The text Word shows: one line per paragraph, tabs restored, entities decoded. */
function docxText(xml: string): string {
  const unescape = (t: string) =>
    t.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
  return [...xml.matchAll(/<w:p>(.*?)<\/w:p>/g)]
    .map(([, p]) => [...p.matchAll(/<w:tab\/>|<w:t xml:space="preserve">(.*?)<\/w:t>/g)].map((m) => (m[1] === undefined ? "\t" : unescape(m[1]))).join(""))
    .join("\n");
}

test("docx: a pack becomes a valid Word package with the pack text verbatim", async () => {
  const dir = await emptyWorkspace();
  try {
    await writeFile(join(dir, "a.ts"), "if (a < b && c > d) {\n\treturn \"x\";\n}\n");
    await writeFile(join(dir, "Makefile"), "all:\n\techo hi\n\n\n");
    const pack = await buildPack({ root: dir, instructions: "@@@ FILE example.ts\nx\n@@@ END example.ts", documentKind: "Word document" });
    assert.match(pack.parts[0], /This Word document is a snapshot/);

    const files = unzip(packToDocx(pack.parts[0], "t", new Date(2026, 0, 2, 3, 4, 6)));
    assert.deepEqual([...files.keys()].sort(), [
      "[Content_Types].xml", "_rels/.rels", "docProps/core.xml", "word/_rels/document.xml.rels", "word/document.xml", "word/styles.xml",
    ]);
    const xml = files.get("word/document.xml")!.toString("utf8");
    assert.equal(docxText(xml), pack.parts[0].replace(/\n$/, ""));
    // FILE lines in the files section are headings; the format's own example is not.
    assert.match(xml, /<w:pStyle w:val="Heading2"\/><\/w:pPr><w:r><w:t xml:space="preserve">@@@ FILE a\.ts/);
    assert.doesNotMatch(xml, /Heading2"\/><\/w:pPr><w:r><w:t xml:space="preserve">@@@ FILE example/);
    assert.match(xml, /<w:pStyle w:val="Code"\/>/);
  } finally {
    await removeWorkspace(dir);
  }
});

test("docx: characters XML forbids are replaced, not emitted", () => {
  const xml = unzip(packToDocx("@@@ FILES\nbell\u0007 nul\u0000 ok\n", "t")).get("word/document.xml")!.toString("utf8");
  assert.doesNotMatch(xml, /[\u0000\u0007]/);
  assert.match(xml, /bell\uFFFD nul\uFFFD ok/);
});

test("pack args: --format, --docx, and inference from the output extension", () => {
  assert.equal(resolveFormat(parsePackArgs([])), "txt");
  assert.equal(resolveFormat(parsePackArgs(["--format", "docx"])), "docx");
  assert.equal(resolveFormat(parsePackArgs(["--docx", "task"])), "docx");
  assert.equal(resolveFormat(parsePackArgs(["-o", "out/repo.DOCX"])), "docx");
  assert.equal(resolveFormat(parsePackArgs(["-o", "repo.docx", "--format", "txt"])), "txt");
  assert.throws(() => parsePackArgs(["--format", "pdf"]), /--format must be one of txt, docx/);
  assert.equal(partPath("x/r.pack.docx", 2, 3, ".docx"), "x/r.pack.part2of3.docx");
  assert.equal(partPath("x/r.pack.txt", 1, 2), "x/r.pack.part1of2.txt");
  assert.equal(partPath("x/r.pack", 1, 2, ".docx"), "x/r.pack.part1of2.docx");
});

test("e2e: coccopilot pack --format docx writes a Word document", { timeout: 30_000 }, async () => {
  const dir = await workspaceFromFixture();
  try {
    const packed = await runCli(["pack", "--format", "docx", "--no-clipboard", "--cwd", dir]);
    assert.equal(packed.code, 0, packed.stdout);
    const docx = join(dir, ".coccopilot", `${dir.split("/").pop()}.pack.docx`);
    assert.ok(existsSync(docx), packed.stdout);
    assert.match(packed.stdout, /a Word document holding a snapshot/);
    const text = docxText(unzip(await readFile(docx)).get("word/document.xml")!.toString("utf8"));
    assert.match(text, /@@@ FILE src\/greet\.js \[\d+ lines?\]/);
  } finally {
    await removeWorkspace(dir);
  }
});
