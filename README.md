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
[coccopilot] reply input: cache file (/path/to/project/.coccopilot/cache.md), clipboard copy when ≤ 8000 chars
[coccopilot] results written to /path/to/project/.coccopilot/cache.md (7754 chars).
[coccopilot] too large for the composer — attach or open the cache file instead.

  1. Open the Copilot webapp:  https://copilot.microsoft.com/
  2. Attach the cache file (or copy its contents) and send it.
  3. Copy/select Copilot's full reply.
────────────────────────────────────────────────────────────────
[coccopilot] [working · step 1/25] Paste Copilot's reply below; finish with a line containing only <<<END>>>.

# ... you paste Copilot's reply into the terminal, then press Enter
[coccopilot] copilot: I'll start by surveying the workspace...
[coccopilot] tool: list_dir {"path":"."}
[coccopilot] result: ok — listed 12 entries in .
# ... cache.md now holds the TOOL RESULT; hand it to Copilot, paste the next reply
# ... repeat until Copilot emits the done block; then the session goes idle
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
   file — and send.
3. Copilot replies with fenced `coccopilot` blocks containing tool calls. It may batch
   **several tool calls in one message**; coccopilot parses all of them.
4. You paste Copilot's reply into coccopilot's terminal, terminated by the sentinel line.
   (Or, if you copied it, press Enter to read the clipboard.)
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
- **Inbound:** paste Copilot's reply into the terminal and end it with `--sentinel`
  (`<<<END>>>`). A bare Enter reads the clipboard instead, when one is available.

Disable the cache to return to the clipboard/manual hand-off with `--no-cache`.

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
| `--sentinel <text>` | Line that ends a manual paste. Default: `<<<END>>>`. |
| `--max-turns <n>` | Steps per continuation. Default: `25`. |
| `--continuations <n>` | Times the step budget may be extended before sealing. Default: `5`. |
| `--max-message-chars <n>` | Clipboard cap: in cached mode, frames above `n` chars skip the clipboard copy; in `--no-cache` clipboard mode they are split into numbered parts. Default: `8000`; `0` disables. |
| `--persona <name>` | `agent` (default) or `notation` (refusal-resistant work-order framing). |
| `--no-primer` | Skip priming. Use when the thread already contains the protocol (pair with `-c`). |
| `--dry-run` | Detect the clipboard backend and print the hand-off mode; send nothing. |
| `--no-code-interpreter` | Add prompt framing that explicitly forbids the product's built-in Code Interpreter. |
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
- **Task completion is announced.** When the model emits `done`, coccopilot prints a
  clear "task complete" banner and returns to idle, ready for the next task.

## Tools the agent can use

| Tool | Signature |
| --- | --- |
| `read_file` | `read_file(path)` |
| `write_file` | `write_file(path, content)` — create or overwrite |
| `edit_file` | `edit_file(path, old_string, new_string, replace_all?)` — surgical edit |
| `list_dir` | `list_dir(path?)` |
| `glob` | `glob(pattern)` — e.g. `"**/*.ts"` |
| `grep` | `grep(pattern, glob?)` |
| `run_command` | `run_command(command, timeout_ms?)` — tests, builds, git, installs |
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

## Prompt personas (avoiding "tools not available" refusals)

Copilot will sometimes refuse the protocol outright — *"those tools are not available in
this chat"* — when the prompt claims you **are** an agent that runs commands and reads
files. coccopilot ships two framings:

| Persona | Framing | When to use |
| --- | --- | --- |
| `agent` (default) | Copilot is told it is a coding agent with real, orchestrator-backed tools. | Usually fine. |
| `notation` | Copilot is told it is a **duty clerk at the Engineering Registry** completing an **engineering work order** (a fill-in-the-blank form); a **Registrar** carries out each named routine against the real codebase and returns a **report**. The clerk only fills in the form, so it never claims a capability and has nothing to refuse. | When refusals appear. |

Enable it with `--persona notation` or `COCCOPILOT_PERSONA=notation`. It is opt-in;
`agent` remains the default. The notation persona also scrubs coccopilot's internal
vocabulary from what the model reads (call key `step`, routines `survey`/`locate`/
`seek`/`inspect`/`record`/`amend`/`perform`/`procure`/`close`, result header
`DESK REPORT`). Result **details are never rewritten** — real file contents and command
output reach the model verbatim.

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
| `COCCOPILOT_SENTINEL` | `<<<END>>>` | Manual-paste terminator |
| `COCCOPILOT_MAX_TURNS` | `25` | Steps per continuation |
| `COCCOPILOT_MAX_CONTINUATIONS` | `5` | Times the step budget may be extended before sealing |
| `COCCOPILOT_MAX_MESSAGE_CHARS` | `8000` | Clipboard cap: skip the copy (cache mode) or split into parts (`--no-cache`) above this (`0` disables) |
| `COCCOPILOT_YES` | `false` | Auto-approve shell commands |
| `COCCOPILOT_CONTINUE` | `false` | Continue the previous conversation |
| `COCCOPILOT_PERSONA` | `agent` | `agent` or `notation` framing |
| `COCCOPILOT_NO_CODE_INTERPRETER` | `false` | Add Code Interpreter-forbidding framing |

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
    vocabulary.ts        persona-aware call key / routine labels / arg names / scrub
    drift.ts             detects built-in sandbox/interpreter drift in a reply
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
prompts/agent.md         the system prompt sent to Copilot (agent persona)
prompts/agent-notation.md the refusal-resistant Engineering-Registry work-order persona
test/
  scenarios.test.ts      explain / create-project / refactor task simulations
  ux.test.ts             nudge, malformed-block, refusal, drift, budget-recovery simulations
  cache.test.ts          cache file write/overwrite, clipboard cap, sentinel + bare-Enter inbound
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
- **"tools are not available" refusal** — Copilot is rejecting the framing. Run with
  `--persona notation`; the form-filling framing claims no capability, so there is
  nothing to refuse. The bridge also auto-recovers with a nudge and a re-prime.
- **Copilot runs the task but no files appear** — it used its built-in Code Interpreter
  instead of coccopilot routines. Use `--persona notation`; if it still goes off-script,
  name a routine explicitly (`Use the write_file tool to ...`).
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
- Copilot's behavior and refusals can change without notice; the persona and drift
  handling live in `prompts/` and `src/agent/`.
- The model sometimes edits more than asked (e.g. "fixing" an unrelated script). Review
  diffs before committing.
- Not a security boundary: `run_command` is gated by a deny-list and confirmation, not a
  sandbox. Run coccopilot on code you can afford to have modified.

## License

MIT. See `LICENSE` for details.
