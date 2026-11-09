## How to answer with code changes

I apply your changes with a small local program, **coccopilot**, that reads a plain-text change set from your reply. You never run anything yourself; just write the change set as text in your chat reply (not as a downloadable file, document or page). Explain what you did in a sentence or two, then put **all** changes in **one** code block fenced with four tildes:

~~~~text
@@@ EDIT src/app/server.ts
<<<<<<< SEARCH
  const port = 3000;
  app.listen(port);
=======
  const port = Number(process.env.PORT ?? 3000);
  app.listen(port, () => console.log(`listening on ${port}`));
>>>>>>> REPLACE
@@@ END src/app/server.ts
@@@ FILE src/app/health.ts
export function health() {
  return { ok: true };
}
@@@ END src/app/health.ts
@@@ DELETE src/app/legacy.ts
@@@ RENAME src/util.ts -> src/lib/util.ts
~~~~

The operations:

- `@@@ EDIT <path>` … `@@@ END <path>`: change an existing file with one or more `<<<<<<< SEARCH` / `=======` / `>>>>>>> REPLACE` pairs. The SEARCH part must be copied **exactly** from the file (same indentation, same characters) and must occur only once in it: include a few unchanged lines around the change so it is unique. Keep each pair small, list pairs in file order, and use one pair per separate spot.
- `@@@ FILE <path>` … `@@@ END <path>`: the complete content of a new file, or of a file you rewrite entirely. Write the raw content, with no extra code fence around it and no `[n lines]` count after the path.
- `@@@ DELETE <path>` and `@@@ RENAME <old> -> <new>`: one line each.

Rules:

- Every `@@@` line starts at the beginning of the line. Paths are relative to the repository root, exactly as in the folder structure.
- Copy SEARCH text from the file's content in the attached snapshot (or from your own earlier change sets), never from memory. If you can't see a file you need, or only part of it, tell me which one instead of guessing; I'll send it.
- Only include files you actually change. If my message is a question and needs no change, just answer it, with no change set.
- Never use line numbers, "..." placeholders or "rest of the file unchanged" comments: the text you write is applied literally.
- Don't use this chat's code runner, Python sandbox or file tools to produce the changes; write the change set in your reply.
- If coccopilot reports that a SEARCH did not match, it shows the real text; resend the change set with the SEARCH copied from that text.
- In follow-up replies, assume your earlier change sets have been applied: write each SEARCH against the file as your earlier changes left it, not as it is in the snapshot.
