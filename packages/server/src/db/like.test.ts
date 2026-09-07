import { describe, expect, it } from 'vitest';

import { containsPattern, escapeLike } from './like';

/**
 * The `LIKE` pattern builder.
 *
 * No database. These are string assertions, so they run on every pull request
 * rather than only where `DATABASE_URL` is set — which matters, because the
 * mistake this module exists to prevent was introduced by a caller that never
 * ran the database suites.
 */
describe('escapeLike', () => {
  it('neutralises both wildcards', () => {
    expect(escapeLike('%')).toBe('\\%');
    expect(escapeLike('_')).toBe('\\_');
    expect(escapeLike('a%b_c')).toBe('a\\%b\\_c');
  });

  it('escapes the escape character, so a typed backslash stays literal', () => {
    // Without this, `\%` typed by a user would arrive at Postgres as an escape
    // sequence and `%` would be a wildcard again — the bug the escape prevents,
    // reachable through the escape itself.
    expect(escapeLike('\\')).toBe('\\\\');
    expect(escapeLike('\\%')).toBe('\\\\\\%');
  });

  it('leaves ordinary text alone', () => {
    expect(escapeLike('Amsterdam')).toBe('Amsterdam');
    expect(escapeLike('EHAM')).toBe('EHAM');
    // Regex metacharacters are not LIKE metacharacters and must survive.
    expect(escapeLike('a.b*c[d]')).toBe('a.b*c[d]');
  });
});

describe('containsPattern', () => {
  it('wraps the escaped text, so one call yields a usable pattern', () => {
    expect(containsPattern('EHAM')).toBe('%EHAM%');
  });

  it('is the whole point: a typed wildcard cannot widen the match', () => {
    expect(containsPattern('%')).toBe('%\\%%');
    expect(containsPattern('_')).toBe('%\\_%');
  });

  it('matches everything for an empty query, which is what callers guard', () => {
    // Documented rather than prevented — both callers short-circuit on an empty
    // query before they build a pattern, and a substring search for nothing
    // genuinely does mean everything.
    expect(containsPattern('')).toBe('%%');
  });
});
