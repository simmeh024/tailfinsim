/**
 * An error and everything that caused it, as one line-separated string.
 *
 * ## Why this is not `error.message`
 *
 * Drizzle wraps driver errors. What it throws says
 * `Failed query: select … params: …` — the statement it was running, which is
 * almost never the interesting part — and the reason Postgres actually refused
 * is one level down in `cause`. An operator reading only the outer message gets
 * the SQL and no diagnosis: `connect ECONNREFUSED`, `password authentication
 * failed` and `relation does not exist` all present identically.
 *
 * CLAUDE.md records the same trap from the other side, where it cost more:
 * asserting on the outer `Failed query: …` message makes a test pass for *any*
 * failure, including one it was written to catch.
 *
 * Lifted out of `migrate.ts` when the worker's handler preflight (SCALE-06)
 * needed the same thing. Two copies of this would have been two chances to fix
 * the wrong one — and the whole value is that every operator-facing failure
 * message in the deploy reads the same way.
 *
 * `seen` guards a cycle: a `cause` chain is not required to be acyclic, and this
 * runs in the failure path, which is the worst place to hang.
 */
export function errorChain(error: unknown): string {
  const messages: string[] = [];
  const seen = new Set<unknown>();
  let current = error;

  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    messages.push(current.message);
    current = current.cause;
  }

  // Not an Error at all — a thrown string, or an object from a library that
  // rejects with a plain value. Still has to produce something legible.
  if (messages.length === 0) return String(error);

  return messages.join('\ncaused by: ');
}
