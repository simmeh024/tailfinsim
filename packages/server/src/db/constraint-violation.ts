/**
 * Reading a Postgres constraint violation out of Drizzle's wrapper.
 *
 * Drizzle throws an error whose message is `Failed query: …` — the statement,
 * not the diagnosis — and Postgres' own `code` and `constraint` are one or more
 * levels down in `cause`. `error-chain.ts` records the same trap from the
 * operator-message side; this is the programmatic side, for the places that
 * need to *decide* something from a refusal rather than print it.
 *
 * **Why the constraint name and not just a boolean.** A write can violate more
 * than one unique index, and converting *any* 23505 into one domain-specific
 * refusal is how a genuinely unrelated conflict gets reported as the wrong
 * thing. A caller that names the constraint it is prepared to handle cannot
 * make that mistake, and one it did not expect keeps propagating as an error,
 * which is the correct outcome for a bug.
 */

/** Postgres class 23 codes this module knows how to name. */
const UNIQUE_VIOLATION = '23505';
const FOREIGN_KEY_VIOLATION = '23503';

/** How deep to walk before giving up; a `cause` chain is not required to be short. */
const MAX_DEPTH = 5;

interface PostgresErrorFields {
  code?: string;
  constraint?: string;
  table?: string;
}

/**
 * Walks the cause chain for a Postgres error carrying `code`.
 *
 * `seen` guards a cycle for the same reason `errorChain` does: nothing requires
 * a `cause` chain to be acyclic, and this runs in a failure path.
 */
function postgresError(error: unknown): PostgresErrorFields | null {
  let current: unknown = error;
  const seen = new Set<unknown>();

  for (let depth = 0; depth < MAX_DEPTH; depth += 1) {
    if (typeof current !== 'object' || current === null || seen.has(current)) return null;
    seen.add(current);

    const candidate = current as PostgresErrorFields & { cause?: unknown };
    if (typeof candidate.code === 'string') return candidate;

    current = candidate.cause;
  }
  return null;
}

/**
 * The unique constraint a failed write violated, or null if it did not violate one.
 *
 * `constraint` is whatever Postgres named, so a caller compares it against the
 * index name declared in `schema.ts`. It can be undefined for a violation
 * Postgres reports without one, which is why the return is an object rather
 * than the name itself — "not a unique violation" and "a unique violation whose
 * constraint is unnamed" are different answers and the second must not read as
 * the first.
 */
export function uniqueViolation(error: unknown): { constraint: string | undefined } | null {
  const pg = postgresError(error);
  if (pg?.code !== UNIQUE_VIOLATION) return null;
  return { constraint: pg.constraint };
}

/** As `uniqueViolation`, for a foreign key that had nothing to point at. */
export function foreignKeyViolation(error: unknown): { constraint: string | undefined } | null {
  const pg = postgresError(error);
  if (pg?.code !== FOREIGN_KEY_VIOLATION) return null;
  return { constraint: pg.constraint };
}
