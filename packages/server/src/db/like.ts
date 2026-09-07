/**
 * Building a `LIKE`/`ILIKE` pattern out of text a player typed.
 *
 * ## Why this is not `` `%${query}%` ``
 *
 * `%` and `_` are wildcards. A search box that passes them through answers `_`
 * with every row and `%` with the whole table, which reads as a broken search
 * rather than a working one — and on a leading-wildcard `ILIKE` across several
 * columns it is a full scan the index cannot help with, ordered before it is
 * limited.
 *
 * Drizzle parameterises the pattern, so this is not an injection boundary. It is
 * a correctness one with a cost tail.
 *
 * ## Why the helper returns the whole pattern
 *
 * {@link escapeLike} alone is the shape that already went wrong: it lived in
 * `admin/players.ts`, was exported for that module's tests, and the second
 * search to need it — `searchAirlineFoundingAirports` — built its pattern by
 * hand and did not call it. An escape function is something a caller can
 * forget; a pattern builder is not, because there is nothing left to assemble.
 *
 * So {@link containsPattern} is what callers use, and `escapeLike` stays
 * exported only for a pattern this module does not cover (a prefix or suffix
 * match) and for the tests that pin its behaviour.
 */

/**
 * Escapes `%`, `_` and the escape character itself so each is a literal.
 *
 * The backslash is doubled because it is also `LIKE`'s escape character, which
 * Postgres applies by default without an `ESCAPE` clause.
 */
export function escapeLike(input: string): string {
  return input.replace(/[\\%_]/g, (char) => `\\${char}`);
}

/**
 * A `%…%` substring pattern for `ILIKE`, with the user's wildcards neutralised.
 *
 * An empty input yields `%%`, which matches everything — deliberately, because
 * that is what a substring search for nothing means. Callers that want a
 * different answer for an empty query decide that before they get here; both
 * current callers short-circuit on it.
 */
export function containsPattern(query: string): string {
  return `%${escapeLike(query)}%`;
}
