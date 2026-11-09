<p align="center">
  <img src="assets/coccopilot.png" alt="coccopilot logo" width="240">
</p>

# coccopilot

Use the **Microsoft Copilot** web app as a coding copilot — with **you** in the loop.
coccopilot gives Copilot a small tool protocol, lets it read/refactor/test/extend a
local codebase, and executes the tool calls it emits. The difference from a browser
automation tool: **you** operate the webapp and the terminal; coccopilot only automates a
local **cache markdown file** (and, optionally, the clipboard) so the hand-off is fast and
is not bound by the composer's paste limit.

There is no browser automation, no synthetic input into the webapp, and no scraping of
Copilot's internal transport. You stay a real human user of the product.

```
$ coccopilot --cwd /path/to/project
[coccopilot] webapp:    https://copilot.microsoft.com/
[coccopilot] reply input: cache file (/path/to/project/.coccopilot/cache.md), clipboard copy when ≤ 8000 chars, auto-reads Copilot's reply when you copy it
[coccopilot] results written to /path/to/project/.coccopilot/cache.md (4877 chars).
[coccopilot] also copied to your clipboard (fits the paste limit).

  1. Open the Copilot webapp:  https://copilot.microsoft.com/
  2. Paste the copied results into the composer and send.
  3. Click the copy button on Copilot's reply — coccopilot picks it up on its own.
────────────────────────────────────────────────────────────────
[coccopilot] [idle · waiting for a task] Waiting for Copilot's reply — copy it and coccopilot takes it from the clipboard.

# ... you type your task into Copilot, then click "copy" on its reply
[coccopilot] picked up Copilot's reply from the clipboard (412 chars).
[coccopilot] copilot: I'll start by surveying the workspace...
[coccopilot] tool: list_dir {"path":"."}
[coccopilot] result: ok — listed 12 entries in .
# ... the TOOL RESULT is now on your clipboard (bell rings): paste it into Copilot, send,
# ... copy the next reply. Repeat until Copilot emits the done block.
```

Pass an optional first task to seed the session in one shot:

```bash
coccopilot --cwd /path/to/project "run the tests and fix any failures"
```

## How it works

1. coccopilot renders a system prompt that describes a small tool protocol and writes it
   to the **cache markdown file** (`.coccopilot/cache.md` in the workspace) with paste/attach
   instructions. If it fits under `--max-message-chars`, it is also copied to your clipboard.
2. You hand the content to a Copilot chat — paste the copied text, or attach/open the cache
   file — and send. coccopilot goes idle right away; type your task straight into Copilot.
3. Copilot replies with fenced `coccopilot` blocks containing tool calls. It may batch
   **several tool calls in one message**; coccopilot parses all of them (see
   [How replies are read](#how-replies-are-read)).
4. You click Copilot's copy button on the reply. coccopilot is watching the clipboard and
   takes it as soon as it contains a `coccopilot` block — no terminal step. (You can also
   paste it into the terminal with the sentinel line, or press Enter to read the clipboard.)
5. coccopilot parses the blocks, runs the tools locally, and writes the framed `TOOL RESULT`
   frame — one frame for the whole batch — back to the cache file.
6. You hand that frame to Copilot; it acts again. Repeat until it emits `done`.
7. coccopilot goes idle — start the next task whenever you like.

Nothing is sent to the webapp on its own. Every turn is a deliberate hand-off you
perform, and every command that runs locally is shown to you and, when non-routine,
approved by you.

### The cache markdown transport

The cache file is the primary transport. It is **overwritten each turn** (one frame per
file), so you never re-send stale content, and it is not bound by the Copilot composer's
paste limit — a batched `TOOL RESULT` frame carrying whole files arrives intact.

- **File:** `<workspace>/.coccopilot/cache.md` (override with `--cache-path` /
  `COCCOPILOT_CACHE_PATH`). The directory is `gitignore`d automatically.
- **Clipboard fast path:** when the frame fits under `--max-message-chars` and a clipboard
  backend is present, coccopilot also copies it, so a small turn is still a direct paste.
  Over the cap, the clipboard is left alone and the file is the only route.
- **Inbound:** copy Copilot's reply and coccopilot picks it up from the clipboard on its own
  (see *Clipboard watch* below). Or paste it into the terminal and end it with `--sentinel`
  (`<<<END>>>`); a bare Enter reads the clipboard.
- **Oversized frames:** when a frame is over the paste cap, coccopilot puts the cache
  file's **path** on the clipboard instead, ready for the browser's attach dialog
  (Cmd+Shift+G on macOS, the address bar on Windows).

### How replies are read

The parser is tolerant of how GPT-based Copilot actually writes blocks, but strict about
what counts as a call:

- **Only calls are run.** Any fence tag works (`coccopilot`, `coccopilot-json`, `json`,
  three or four backticks, tildes), and a bare `{"tool": …}` object is accepted when the
  Copy button drops the fence. Outside a `coccopilot` fence, an object keyed `name` only
  counts with an `args`/`arguments` object, so a `package.json` snippet is never run.
- **Nested fences survive.** A ``` line inside a JSON string (e.g. `write_file` of a
  README) does not end the block. The prompt also asks for a four-backtick fence then,
  so Copilot's own renderer shows the block intact.
- **Common JSON slips are repaired**: raw newlines/tabs inside strings and trailing
  commas. Anything else that won't parse rejects the **whole reply** (no partial runs),
  and Copilot is asked to resend every block, not just the broken one.
- **Results map back to calls.** Batched results are numbered in call order, and each
  header names its target (path, or the command for `run_command`).
- **`done` must be earned.** A `done` sent with calls that failed is refused and the task
  stays open; the prompt asks for `done` in a reply of its own.
- **Questions are not nudged.** A mid-task question with no block is left for you to
  answer in the chat; other block-less replies get a corrective nudge.

Each task message also states the OS and the shell `run_command` uses (e.g. macOS,
`/bin/sh` with BSD tools), so Copilot picks commands that work.

### Clipboard watch

While waiting for a reply, coccopilot polls the clipboard. When it changes to text that
contains a `coccopilot` block (or a bare `{"tool": …}` object), coccopilot takes it as the
reply. A normal turn is therefore: **copy Copilot's reply → paste the results → send**,
without switching to the terminal. A bell rings each time new results are ready.

- Whatever is on the clipboard when the wait starts is ignored, and coccopilot's own
  hand-offs (`[coccopilot] …`, the cache file) are ignored too.
- **A reply is never run twice.** If the reply that arrives is identical to the last one
  that ran (e.g. Copy was clicked on an older message), coccopilot logs it, runs nothing,
  and keeps waiting for the newest reply.
- **Double clipboard writes are absorbed.** Some Copy buttons (M365 Copilot) write the
  clipboard more than once. coccopilot only takes a reply once it has stayed on the
  clipboard for about a second, and for a few seconds after a hand-off it puts the
  results back if a stale reply lands on top of them — so you always paste the results,
  not Copilot's own reply.
- Replies without a block (e.g. Copilot asking a question) are not auto-taken — press
  Enter to submit them from the clipboard.
- Turn it off with `--no-watch` / `COCCOPILOT_WATCH=false`. It is off when there is no
  clipboard backend or with `--no-clipboard`.

Disable the cache to return to the clipboard/manual hand-off with `--no-cache`.

### Microsoft 365 Copilot (enterprise)

Point the hand-off at the M365 Copilot Chat webapp:

```bash
coccopilot --webapp https://m365.cloud.microsoft/chat --cwd ./myapp "your task"
```

It has been trialled end to end: it follows the prompt without refusing, batches several
calls per reply, and finishes with `done`. Use the **Copy** button under the whole message
(not a code block's), click it once, and start each task in a new chat.

### Pack mode: the whole repo in one file (`pack` / `apply`)

Copilot Enterprise (M365 Copilot) can read files you upload or keep in the workspace it
mounts. Pack mode uses that instead of the tool loop: you hand Copilot the **whole
repository as one `.txt` file**, it answers with a **change set**, and coccopilot applies
it locally. One round trip per change, no tool calls.

```bash
coccopilot pack --cwd ./myapp "add a /health endpoint"   # writes .coccopilot/myapp.pack.txt
# upload the file to Copilot, paste the kick-off message (on your clipboard), send
# copy Copilot's reply, then:
coccopilot apply --cwd ./myapp                            # reads the change set from the clipboard
```

**The pack** is plain text, so Copilot reads the code as code. It starts with the
change-format instructions and the folder structure (an indented tree; single-child
directory chains such as `src/main/java/com/acme/` collapse onto one line), then every
text file between marker lines:

```text
@@@ FILE src/server.ts [42 lines]
...the file, verbatim...
@@@ END src/server.ts
```

The `[42 lines]` count makes decoding exact even when a file itself contains marker
lines, and a file without a trailing newline says so, so a pack unpacks byte for byte.
File selection follows git (tracked + untracked, `.gitignore` honored; a plain walk that
skips `node_modules`, `dist`, … outside a repo). Binaries, files over `--max-file-bytes`,
lockfiles, minified bundles and source maps appear in the tree as `(not included: …)` so
Copilot knows they exist without paying for them.

**The change set** Copilot writes back uses the same markers, in one `~~~~` block:

```text
@@@ EDIT src/server.ts
<<<<<<< SEARCH
app.listen(3000);
=======
app.get("/health", (_req, res) => res.json({ ok: true }));
app.listen(3000);
>>>>>>> REPLACE
@@@ END src/server.ts
@@@ FILE src/health.ts
...full content of a new or rewritten file...
@@@ END src/health.ts
@@@ DELETE src/legacy.ts
@@@ RENAME src/util.ts -> src/lib/util.ts
```

SEARCH/REPLACE edits are used instead of unified diffs because models copy text far
more reliably than they count line numbers. `apply`:

- matches each SEARCH exactly, then ignoring trailing whitespace, then ignoring
  indentation (re-indenting the replacement), then ignoring blank lines; a SEARCH that
  matches more than one place is refused, never guessed;
- plans everything in memory first and writes **nothing unless every change applies**
  (`--partial` to apply what works). On a failure it prints a report for Copilot, quoting
  the real text near where the SEARCH should have landed, and puts it on the clipboard;
- keeps CRLF files CRLF, stays inside the workspace and never writes into `.git`;
- ignores prose and fences around the change set, and tolerates a missing `@@@ END` or a
  code fence inside a FILE block;
- asks `[y/N]` before writing (`-y` to skip, `--dry-run` to only show the summary).

| `pack` option | Description |
| --- | --- |
| `-o, --output <path>` | Pack file. Default: `<workspace>/.coccopilot/<name>.pack.<txt\|docx>` (gitignored). |
| `--format txt\|docx` | Plain text or a Word document (`--docx` for short). Default: from `-o`'s extension, else `txt`. |
| `--exclude <glob>` | Leave matching files out (repeatable; `dir/` excludes a directory). |
| `--no-default-excludes` | Also inline lockfiles, minified bundles and source maps. |
| `--max-file-bytes <n>` | List larger files without content. Default: `200000`. |
| `--max-chars <n>` | Split into parts of about `n` characters (files are never split). |
| `--no-clipboard` | Print the kick-off message instead of copying it. |

| `apply` option | Description |
| --- | --- |
| `<file>` / `-` | Read the change set from a file or stdin. Default: the clipboard (waits for one if it holds none). |
| `--dry-run` | Show what would change; write nothing. |
| `-y, --yes` | Apply without asking. |
| `--partial` | Apply the changes that work even if some fail. |
| `--watch` | Keep watching the clipboard and apply each new change set. |

**Trialled on M365 Copilot.** A small task (edit two files, add a module with tests,
document it) came back as a clean change set and applied in one round trip with the
tests passing; the one SEARCH that missed had dropped a blank line, which `apply` now
tolerates. A ~280k-character pack of this repository was read and described correctly.
Copilot's Copy button may drop the `~~~~` fence; that is fine, the parser does not need it.

**`.txt` or `.docx`.** Copilot sometimes works from a summary of an uploaded `.txt`
rather than its full text. `--format docx` writes the same pack as a Word document,
which Copilot reads through its document pipeline: one paragraph per pack line (so the
markers and line counts survive a copy out of Word), `@@@ FILE` lines as headings for an
outline, code in a monospace style. It is generated without dependencies (a minimal
OOXML package zipped in-process); `--max-chars` splitting works the same way. `apply`
does not read `.docx` packs back; it never needs to, Copilot's replies are plain text.

The kick-off message repeats the change-format instructions, because Copilot may only
retrieve parts of a large uploaded file. Applying a pack itself works too: it recreates
the snapshot, which makes `apply` double as an unpacker.

### Skills: give Copilot roles (`--skills`)

A skill is a role Copilot takes on for the session. The selected skills are added to the
primer (and to the pack kick-off message) as a **Roles** section. Four are built in:

| Skill | Role |
| --- | --- |
| `developer` | Machine-learning / Python engineer, responsible for the change working. Applies *Clean Code*, *Refactoring Guru* (smells, small refactorings, patterns only when they pay) and *Designing Data-Intensive Applications* (idempotent, reproducible data steps, explicit schemas), plus ML hygiene (no data leakage, seeds, config over constants). Paired with the reviewer as QA: when both are active it hands each change to the reviewer before `done`. |
| `simplifier` | Seasoned developer who flattens and trims code structure, behavior unchanged, so new developers can approach it. |
| `reviewer` | QA tester and reviewer: hunts for bugs, adds tests (a failing test per bug, edge cases), and ends with a ranked list of concerns. |
| `documenter` | Keeps README, docstrings and CLI help in step with the code and maintains a minimal getting-started guide. |

```bash
coccopilot --skills developer,reviewer --cwd ./ml-project "add early stopping to the trainer"
coccopilot --skills all --cwd ./myapp
coccopilot pack --skills simplifier,documenter --cwd ./myapp "make the CLI module approachable"
coccopilot skills              # list available skills (built-in and custom)
coccopilot skills reviewer     # print one skill's instructions
```

With several skills, Copilot works through them in the order given on every task. Start a
task with a role tag to use just one role for it, e.g. `@reviewer look for bugs in the
parser`. Skills are off by default, so the primer is unchanged unless you ask for them.

**Custom skills** are markdown files with an optional frontmatter header:

```markdown
---
name: data-engineer
title: The Data Engineer
description: Owns the ingestion pipelines.
---
You are the Data Engineer. Keep every pipeline step idempotent…
```

coccopilot picks them up from `.coccopilot-skills/` in the project (commit it to share
skills with your team) and from `~/.coccopilot/skills/` (override with
`COCCOPILOT_SKILLS_DIR`); select them by name with `--skills`. A custom skill with a
built-in's name replaces it. `--skill <file.md>` loads and activates a file directly.

Skills make the primer longer than the default clipboard cap (8000 chars), so the primer
goes through the cache file: attach `.coccopilot/cache.md` (its path is on your clipboard).
Later turns are unaffected. With `--no-primer` the skills are not sent.

### Why human-in-the-loop

Automating the Copilot web app — driving the composer, injecting messages, and reading
the chat over its private WebSocket — sits in tension with Microsoft's terms of service.
coccopilot avoids all of it:

- **No browser automation.** coccopilot never launches, attaches to, or controls a browser.
- **No synthetic webapp input.** You type/paste and send every message yourself.
- **No transport scraping.** Replies are read from the clipboard you control.
- **No autoparsing or autoinserting prompts.** That is the whole point: the human moves
  text between Copilot and coccopilot; coccopilot automates only the clipboard and the
  local execution.

coccopilot is a self-contained project: the local tool-execution core, command
policy, and CLI plumbing all live in this repository, and there is no browser
layer; the human clipboard bridge is the only transport.

## Requirements

- **Node.js >= 20**
- **A Copilot account** you can sign into in a browser.
- **A system clipboard** (optional fast path): macOS ships `pbcopy`/`pbpaste`; Windows
  uses PowerShell; on Linux install `wl-clipboard`, `xclip`, or `xsel`. Without one,
  coccopilot writes frames to the cache file only — you attach/open it by hand.
- Linux/macOS/Windows.

## Installation

### As a command (`coccopilot`)

```bash
git clone <this-repo> coccopilot
cd coccopilot
npm install            # installs deps + builds via the prepare script
npm link               # makes `coccopilot` available on your PATH globally
```

Then, from anywhere:

```bash
coccopilot --cwd /path/to/project
coccopilot --cwd /path/to/project "run the tests and fix any failures"
```

### From the repo (development)

```bash
git clone <this-repo> coccopilot
cd coccopilot
npm install
npm start -- --cwd /path/to/project
```

## Usage

```
coccopilot [options] ["<optional first task>"]
```

coccopilot stays running until you stop it (Ctrl-C), alternating copy/paste turns with
you.

| Option | Description |
| --- | --- |
| `--cwd <dir>` | Workspace root. All file tools and commands are confined here. Default: current directory. |
| `--webapp <url>` | Copilot webapp URL shown in the hand-off instructions. Default: `https://copilot.microsoft.com/`. |
| `--no-cache` | Do not use the cache markdown file; hand off via the clipboard or manual paste. |
| `--cache-path <path>` | Cache markdown path. Default: `<workspace>/.coccopilot/cache.md`. |
| `--no-clipboard` | Never touch the system clipboard (cache file only). |
| `--no-watch` | Don't auto-take Copilot's reply from the clipboard; press Enter or paste instead. |
| `--sentinel <text>` | Line that ends a manual paste. Default: `<<<END>>>`. |
| `--max-turns <n>` | Steps per continuation. Default: `25`. |
| `--continuations <n>` | Times the step budget may be extended before sealing. Default: `5`. |
| `--max-message-chars <n>` | Clipboard cap: in cached mode, frames above `n` chars skip the clipboard copy; in `--no-cache` clipboard mode they are split into numbered parts. Default: `8000`; `0` disables. |
| `--skills <list>` | Roles for Copilot, comma-separated: `developer`, `simplifier`, `reviewer`, `documenter`, a custom skill's name, or `all`. See [Skills](#skills-give-copilot-roles---skills). |
| `--skill <file.md>` | Load a custom skill file and use it (repeatable). |
| `--no-primer` | Skip priming. Use when the thread already contains the protocol (pair with `-c`). |
| `--dry-run` | Detect the clipboard backend and print the hand-off mode; send nothing. |
| `-y`, `--yes` | Auto-approve non-routine shell commands (no approval prompt at all). |
| `-c`, `--continue` | Continue the previous conversation instead of priming fresh. |
| `-h`, `--help` | Show usage. |

### Examples

```bash
# Start an interactive session (primes the chat, then hands it to you)
coccopilot --cwd ./myapp

# Seed the first task in one shot
coccopilot --cwd ./myapp "run the test suite, find the failure, fix it, and re-run"

# Refactor
coccopilot --cwd ./myapp "rename the function fetchData to loadData everywhere and update callers"

# Add a feature (auto-approve shell commands)
coccopilot -y --cwd ./myapp "add a capitalize(str) function to src/strings.js with a test, and run the tests"

# Read-only exploration
coccopilot --cwd ./myapp "explain the architecture and list the main entry points"

# Resume the previous conversation
coccopilot -c --cwd ./myapp

# Cache file only (never touch the clipboard)
coccopilot --no-clipboard --cwd ./myapp

# Legacy clipboard/manual hand-off (no cache file)
coccopilot --no-cache --cwd ./myapp
```

### The cache hand-off (default)

- **Outgoing:** coccopilot writes the frame to `.coccopilot/cache.md` (overwritten each
  turn) and prints the hand-off steps once; later turns show a compact one-line header.
  If the frame fits under `--max-message-chars` and a clipboard is available, it is also
  copied. Hand it to Copilot by pasting the copy or by attaching/opening the file.
- **Incoming:** paste Copilot's reply into the terminal and end it with a line containing
  only `--sentinel` (`<<<END>>>`). The prompt carries a status line (e.g.
  `[working · step 3/25]`) so you can see where the task is. Press Enter with nothing
  pasted to read the clipboard instead.
- **Multiple tool calls:** if Copilot batches several `coccopilot` blocks in one message,
  coccopilot runs them all and merges the results into a **single** `TOOL RESULT` frame —
  in the file and, when it fits, on the clipboard.
- **Guards:** reading the clipboard never accepts an empty clipboard or the exact text
  coccopilot just handed you.

### The clipboard hand-off (`--no-cache`)

With `--no-cache`, coccopilot uses the clipboard (when a backend is detected):

- **Outgoing:** it copies the message and prints the paste/send/copy steps once. You
  paste it into Copilot and send.
- **Oversized messages are split.** The composer rejects an oversized paste (a batched
  `TOOL RESULT` frame carrying a whole file, for example). coccopilot splits any message
  above `--max-message-chars` into numbered parts: it copies part 1
  (`[coccopilot part 1/3]` … `[coccopilot end part 1/3]`), you paste and send it, then
  press Enter to copy the next part. Nothing is dropped — the parts rejoin exactly.
- **Incoming & guards:** as in cache mode above.

In manual mode (`--no-cache --no-clipboard`, or no clipboard backend): coccopilot prints
each outgoing message, and you paste Copilot's reply into the terminal and terminate it
with a line containing only `<<<END>>>`.

### Interactive tips

- **You own the chat while idle.** Ordinary conversation with Copilot is left alone —
  only a reply that contains a `coccopilot` tool block starts a task.
- **Autonomy within a task.** Copilot emits blocks back-to-back after each `TOOL RESULT`
  until the task is done; each `--max-turns` budget is extended by a "continue or
  finish" nudge, up to `--continuations` times.
- **Command approvals stay on the terminal.** Non-routine commands prompt `[y/N]` in
  coccopilot's terminal; `-y` skips approvals.
- **Missing-tool reply.** If Copilot drifts into the product's built-in Code Interpreter
  instead of emitting a block, coccopilot replies with a corrective nudge (and re-primes
  if it persists).
- **Questions are yours to answer.** If Copilot asks a question mid-task instead of
  writing a block, coccopilot sends nothing: answer it in the chat, and its next blocks
  run as usual.
- **Task completion is announced.** When the model emits `done`, coccopilot prints a
  clear "task complete" banner and returns to idle, ready for the next task. A `done`
  sent in the same reply as a call that failed is refused, and the task stays open.

## Tools the agent can use

| Tool | Signature |
| --- | --- |
| `read_file` | `read_file(path)` |
| `write_file` | `write_file(path, content)` — create or overwrite |
| `edit_file` | `edit_file(path, old_string, new_string, replace_all?)` — surgical edit |
| `list_dir` | `list_dir(path?)` |
| `glob` | `glob(pattern)` — e.g. `"**/*.ts"` |
| `grep` | `grep(pattern, glob?)` |
| `run_command` | `run_command(command, timeout_ms?)` — tests, builds, git, installs; default 60 s, max 120 s, last 200 lines of output |
| `ensure_tool` | `ensure_tool(name, install?)` — check/install a dev tool (pytest, pyspark, …) |

`read_file`, `write_file`, `edit_file`, `list_dir`, `glob`, and `grep` are confined to
the workspace root; attempts to escape it (e.g. `../etc/passwd`) are rejected.

### Missing tools (`ensure_tool` and `coccopilot doctor`)

coccopilot knows how to detect and install a small catalog of developer tools
(`node`, `npm`, `git`, `python`, `pip`, `pytest`, `pyspark`, `uv`, `docker`):

- `coccopilot doctor` — prints what is present/missing, with versions and install hints.
- `coccopilot install <tool>` (or `install --all`) — installs a missing tool.
- `ensure_tool` — the agent-callable equivalent. When a command fails with exit 127
  ("command not found") or a Python `ModuleNotFoundError`, Copilot calls `ensure_tool`
  to install the missing tool and retries.

Installs run through the same command policy as `run_command`: routine package managers
(`pip`, `npm`) run directly; system installs (e.g. `brew`, `sudo apt-get`) require
approval (or are auto-approved with `-y`). The deny-list still applies.

## The prompt (avoiding "tools not available" refusals)

coccopilot sends one prompt, `prompts/agent.md`, written in your own voice. It does not
tell Copilot that it *has* tools — that claim is what triggers refusals. It says the true
thing instead: a local program reads the `coccopilot` blocks Copilot writes, runs them in
your project, and you paste the results back. Writing a block is like suggesting a
terminal command, so there is no capability to refuse. The prompt also asks Copilot not to
use its built-in Code Interpreter, and to batch every independent call into one reply.
It is ~5k characters, so it fits a single clipboard paste.

## Shell command safety

`run_command` executes a real shell in the workspace root. Because a shell can leave the
path sandbox by design, commands are gated:

- **Deny-list** — destructive/system commands are always blocked: `sudo`, root/home/system
  deletes (`rm -rf /`, `rm -rf ~`, `rm -rf /etc`), fork bombs, `mkfs`, raw disk writes,
  `curl | sh`, host power control.
- **Routine commands** (`npm`, `git`, `node`, `python`, `ls`, …) run without asking.
- **Anything else** is approved with a terminal `[y/N]` prompt, unless you pass `-y`.

With `-y`, a destructive but un-listed command inside the workspace can still run — use
it deliberately. The strongest protection is running against a git checkout you can
revert.

### Interactive prompts from commands

A command that asks a question (e.g. `npx … proceed? (y)`, an `apt` confirmation, a
"file exists, overwrite?") no longer hangs until the timeout. coccopilot notices the
process has gone idle on a prompt and asks you on the terminal; your answer is typed
into the command. With `-y`, installer/confirmation prompts are answered `y`
automatically.

**Credential prompts are never routed** (password, passphrase, token, username).
coccopilot aborts the command and tells you to configure credentials out-of-band, so
secrets cannot end up in the clipboard or the chat log. All prompts are answered with a
bounded timeout; if no answer arrives the command is aborted rather than left hanging.

## Configuration

Environment variables (flags take precedence):

| Variable | Default | Purpose |
| --- | --- | --- |
| `COCCOPILOT_WORKSPACE` | cwd | Workspace root |
| `COCCOPILOT_WEBAPP` | `https://copilot.microsoft.com/` | Webapp URL shown in the hand-off |
| `COCCOPILOT_CACHE` | `true` | Use the cache markdown file as the primary transport |
| `COCCOPILOT_CACHE_PATH` | `<workspace>/.coccopilot/cache.md` | Cache markdown path |
| `COCCOPILOT_CLIPBOARD` | `true` | Also copy small frames to the system clipboard |
| `COCCOPILOT_WATCH` | `true` | Auto-take Copilot's reply when it is copied to the clipboard |
| `COCCOPILOT_SENTINEL` | `<<<END>>>` | Manual-paste terminator |
| `COCCOPILOT_MAX_TURNS` | `25` | Steps per continuation |
| `COCCOPILOT_MAX_CONTINUATIONS` | `5` | Times the step budget may be extended before sealing |
| `COCCOPILOT_MAX_MESSAGE_CHARS` | `8000` | Clipboard cap: skip the copy (cache mode) or split into parts (`--no-cache`) above this (`0` disables) |
| `COCCOPILOT_YES` | `false` | Auto-approve shell commands |
| `COCCOPILOT_CONTINUE` | `false` | Continue the previous conversation |
| `COCCOPILOT_SKILLS` | (none) | Default `--skills` list, e.g. `developer,reviewer` |
| `COCCOPILOT_SKILLS_DIR` | `~/.coccopilot/skills` | Folder of personal custom skills |

`coccopilot doctor` and `coccopilot install <tool>` are also available as subcommands;
they honor `-y` for installs that require approval.

## Project layout

```
src/
  cli.ts                 entrypoint: flags, wiring, terminal approver, bridge lifecycle
  config.ts              env + flag configuration
  human/
    cache.ts             cache markdown resolution/atomic write (.coccopilot/cache.md)
    clipboard.ts         cross-platform clipboard detection/read/write
    terminal.ts          shared stdin reader (Enter-to-continue, manual paste, approvals)
    transcript.ts        transcript-recording channel base (status line + audit trail)
    channel.ts           CopilotChannel: cache/clipboard/manual hand-off to the webapp
  agent/
    bridge.ts            human-operated bridge: render -> receive -> execute -> render
    executor.ts          shared tool-call execution/framing
    protocol.ts          tool-call parsing (single, batched, tolerant)
    prompt.ts            system prompt assembly + result framing
    drift.ts             detects built-in sandbox/interpreter drift in a reply
    skills.ts            skill discovery (built-in, user, project, file) and the Roles section
  pack/
    format.ts            pack / change-set text format: encoder and tolerant parser
    pack.ts              file selection, tree rendering, pack assembly and splitting
    docx.ts              a pack as a Word document: OOXML parts and a minimal zip writer
    apply.ts             in-memory change planning, SEARCH matching, writing
    commands.ts          the `pack` and `apply` subcommands
  tools/
    fs.ts                read/write/edit/list/glob/grep
    shell.ts             run_command (routes interactive prompts to the approver)
    ensure.ts            ensure_tool (detect/install missing dev tools)
    toolchain.ts         tool catalog + detection (used by doctor/install/ensure_tool)
    registry.ts          tool registry
    types.ts             tool types
  sandbox/
    workspace.ts         path confinement
    policy.ts            command deny-list + approval
prompts/agent.md         the single prompt sent to Copilot
prompts/pack.md          the change-format instructions embedded in a pack
prompts/skills/          built-in skills: developer, simplifier, reviewer, documenter
test/
  scenarios.test.ts      explain / create-project / refactor task simulations
  ux.test.ts             nudge, malformed-block, refusal, drift, budget-recovery simulations
  misread.test.ts        replies a model can get subtly wrong: nested fences, JSON slips, stray snippets
  cache.test.ts          cache file write/overwrite, clipboard cap, sentinel + bare-Enter inbound
  skills.test.ts         skill discovery, overrides, selection and rendering into prompts
  pack.test.ts           pack round-trip, tree, splitting, change-set parsing and apply
  clipboard.test.ts      clipboard guards, manual sentinel, one-time instructions, status line
  e2e.test.ts            spawns the real CLI (manual and cache modes) over piped stdin
  support/               ScriptedChannel + runSession harness, fixture project
```

## Troubleshooting

- **Clipboard never changes** — another app may own the clipboard, or you are on a
  headless/WSL session. In cache mode this is fine: the results are in
  `.coccopilot/cache.md`. Run `--dry-run` to see the detected backend.
- **"the clipboard still holds the message we gave you"** — you pressed Enter before
  copying Copilot's reply. Select Copilot's reply, copy it, press Enter again.
- **Pasting the copy is blocked by the composer** — the frame is over your paste limit.
  Just attach/open `.coccopilot/cache.md` instead; coccopilot already skipped the
  clipboard copy for it. To raise the copy cap, increase `--max-message-chars`.
- **"tools are not available" refusal** — the bridge auto-recovers with a plain-language
  nudge and, if needed, a re-prime. If it persists, start a fresh Copilot chat.
- **Copilot runs the task but no files appear** — it used its built-in Code Interpreter
  instead of coccopilot blocks. The bridge nudges it back; you can also name a tool
  explicitly (`Use the write_file tool to ...`).
- **A copied reply is not picked up** — it has no `coccopilot` block, or it is identical
  to what was already on the clipboard. Press Enter to submit the clipboard anyway.
- **Commands keep getting denied** — you answered `n` at the `[y/N]` prompt. Approve, or
  pass `-y`.
- **A command is waiting at a prompt** — coccopilot detects the idle prompt and asks you;
  answer `y`/`n` or the value. Credential prompts are intentionally never routed —
  configure those credentials in the environment instead.
- **A required tool is missing** — run `coccopilot doctor` to see what is present, then
  `coccopilot install <tool>` (or let the agent call `ensure_tool` during a task).
- **The model edits more than asked** — review diffs before committing.

## Development

```bash
npm run typecheck   # tsc --noEmit for src/ and test/
npm test            # node:test simulation + end-to-end suite
npm run build       # emit to dist/
```

The test suite drives `runBridge` against a scripted `CopilotChannel`, so the whole
hand-off loop — including the explain/create/refactor task shapes and the nudge,
re-prime, drift, and budget-recovery paths — can be exercised deterministically
without a browser or the webapp. The tests live in `test/`; the fixture project they
work against is `test/fixtures/sample-project/`.

## Limitations & notes

- Automating the Copilot web app may conflict with Microsoft's terms of service.
  coccopilot deliberately does not automate it — you drive the webapp by hand — but
  review Microsoft's terms for your own use.
- Copilot's behavior and refusals can change without notice; the prompt and drift
  handling live in `prompts/` and `src/agent/`.
- The model sometimes edits more than asked (e.g. "fixing" an unrelated script). Review
  diffs before committing.
- Not a security boundary: `run_command` is gated by a deny-list and confirmation, not a
  sandbox. Run coccopilot on code you can afford to have modified.

## License

MIT. See `LICENSE` for details.
