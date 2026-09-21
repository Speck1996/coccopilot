/**
 * Detects when the model drifts away from the coccopilot protocol and toward the
 * product's own facilities: its built-in Code Interpreter, a Python sandbox, a
 * throwaway store like `/mnt/data`, or internal shell execution it narrates itself.
 *
 * Copilot will sometimes "help" by running a task in its own cloud sandbox instead of
 * emitting `coccopilot` blocks. Those turns produce no tool call and
 * are easy to mistake for ordinary conversation; classifying them lets the bridge
 * answer with a targeted corrective nudge rather than a generic one.
 */

const DRIFT_PATTERNS: RegExp[] = [
  /\/mnt\/data/,
  /code interpreter/,
  /\b(python|jupyter) (sandbox|notebook)\b/,
  /\b(in|using|use) the (sandbox|interpreter|environment)\b/,
  /\bi'?ll (run|execute|use|try)\b[^.\n]{0,30}\b(sandbox|interpreter|notebook|environment)\b/,
  /\b(coding and executing|running the code|executing the code)\b/,
  /\bbash -l[ce]\b/,
  /\bi ran (it|the code|this) (in|using)\b/,
  /\b(ran|executed) (it|the code|this) (in|using) (a|the) (sandbox|interpreter|environment)\b/,
  /\banaly[sz]e[d]? the (data|file|code) (in|using)\b/,
];

/** True when a reply reads like the model used its own sandbox/interpreter instead of coccopilot. */
export function detectDrift(reply: string): boolean {
  const text = (reply ?? "").toLowerCase();
  if (!text) return false;
  return DRIFT_PATTERNS.some((re) => re.test(text));
}
