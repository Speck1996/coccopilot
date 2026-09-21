# Roadmap / TODO

## In progress

- **Manual-mode ergonomics.** Clipboard mode is the fast path; ensure the manual
  paste flow (sentinel-delimited) stays comfortable for large multi-turn tasks.

## Backlog

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

- **Human-operated bridge (TOS-compliant design).** coccopilot renders
  each outgoing message for the operator to paste into the Copilot webapp and reads
  the reply the operator brings back from the clipboard (`pbpaste`/`pbcopy`,
  PowerShell, `wl-clipboard`/`xclip`/`xsel`), with a manual paste fallback. The
  bridge is a synchronous loop; command approvals stay on the terminal. There is no
  Playwright/CDP, no WebSocket reply capture, and no composer driving.
- **Prompt tag renamed to `coccopilot`.** Prompts and parser use the new fenced-block
  tag exclusively.
