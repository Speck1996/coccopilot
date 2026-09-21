# Roadmap / TODO

## In progress

- **Manual-mode ergonomics.** Clipboard mode is the fast path; ensure the manual
  paste flow (sentinel-delimited) stays comfortable for large multi-turn tasks.

## Backlog

- **Reply-input escape hatches.** At the Enter prompt, allow `r` (re-read clipboard),
  `e` (open `$EDITOR` on the reply), `s` (skip/standby), and `q` (quit). Suggested by
  the simulation suite; not yet implemented.
- **Always-allow at the approval prompt.** `a` at `[y/N]` to stop re-prompting for the
  same command during a task.
- **Explicit approval timeout.** `askTerminal` currently logs "continuing without
  approval" and then denies; make the outcome explicit and pause instead.

- **Clipboard robustness.** Add a `--clipboard-read-timeout` and a "read again" command
  at the Enter prompt. Consider a `--clipboard-command` override for unusual setups
  (e.g. WSL bridges, remote sessions).
- **Turn log.** Optionally persist each hand-off turn (outgoing + reply) to a JSONL file
  so a session can be audited or resumed.
- **`--no-clipboard` reply editing.** Let the operator open `$EDITOR` to paste and edit a
  long Copilot reply before coccopilot parses it.
- **Drift detection coverage.** `detectDrift` matches narration and markers
  (`/mnt/data`, "code interpreter", `bash -lc`, "Coding and executing"). Add patterns as
  Copilot's progress wording changes.
- **Per-persona vocabulary tuning.** If refusals recur, extend the neutral labels/arg
  names and the `scrub` rules in `src/agent/vocabulary.ts`.
- **`ensure_tool` virtualenv awareness.** The catalog installs to the user site
  (`pip install --user`); detect and use an active virtualenv when present.
- **Terminal status line.** Surface task state / turn counts so long tasks are easier to
  follow.
- **Optional scripted hand-off test.** A dev-only "scripted Copilot over the clipboard"
  driver to exercise the bridge deterministically in CI without a browser.

## Done

- **Oversized-paste splitting.** A batched `TOOL RESULT` frame routinely exceeded the
  Copilot composer's paste limit, which the UI silently rejected. Outgoing messages
  above `--max-message-chars` (`COCCOPILOT_MAX_MESSAGE_CHARS`, default 8000) are now
  split into numbered parts on a line boundary; the operator sends part n and presses
  Enter for part n+1. Splitting is lossless and applies to both clipboard and manual
  modes. `0` disables it.
- **Scripted hand-off test + session simulation.** The bridge is driven against a
  scripted `CopilotChannel` in `test/`, exercising the explain / create-project /
  refactor task shapes and the nudge, malformed-block, refusal, drift, and
  budget-recovery paths deterministically, plus an end-to-end CLI run in
  `--no-clipboard` mode over piped stdin. `npm test` runs the suite (no new deps).
- **UX polish surfaced by the simulation.** The clipboard paste instructions print
  once (then a compact line), the reply prompt carries a `[working · step n/N]`
  status, and a `done` block announces "task complete" before returning to idle.
  Also fixed drift being shadowed by the refusal matcher, and the forced-done path
  leaving the bridge idle so the done block was ignored.
- **Human-operated bridge (TOS-compliant design).** coccopilot renders
  each outgoing message for the operator to paste into the Copilot webapp and reads
  the reply the operator brings back from the clipboard (`pbpaste`/`pbcopy`,
  PowerShell, `wl-clipboard`/`xclip`/`xsel`), with a manual paste fallback. The
  bridge is a synchronous loop; command approvals stay on the terminal. There is no
  Playwright/CDP, no WebSocket reply capture, and no composer driving.
- **Prompt tag renamed to `coccopilot`.** Prompts and parser use the new fenced-block
  tag exclusively.
