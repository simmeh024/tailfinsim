import { describe, expect, it } from 'vitest';

import {
  authorizationFailureLine,
  classifyAuthorizationMismatch,
} from '../test-fixtures/authorization';

/**
 * An authorization failure has to be readable as an incident (SEC-12).
 *
 * These tests are about the *message*, which is unusual and deliberate. In a run
 * of well over a thousand tests, an authorization failure appears as one line
 * among hundreds; `expected 403, received 200` in a stack trace is a puzzle
 * somebody has to open the test file to decode. The format is therefore a
 * contract, and this is what holds it.
 *
 * No new CI job: these tests, and the suites whose messages they shape, already
 * run in the existing `Tests` job, which has the Postgres service and the
 * Fastify instance they need.
 */

describe('classifyAuthorizationMismatch', () => {
  it('calls a door that stopped being locked a breach', () => {
    // The direction that matters: refusal expected, access given.
    expect(classifyAuthorizationMismatch(403, 200)).toEqual({
      severity: 'breach',
      meaning: 'access GRANTED where it must be refused',
    });
    expect(classifyAuthorizationMismatch(401, 204).severity).toBe('breach');
    // A 404 that conceals is a refusal too (ADR-0020), so answering it with a
    // 200 is a breach rather than a curiosity.
    expect(classifyAuthorizationMismatch(404, 200).severity).toBe('breach');
  });

  it('calls a feature that stopped working a regression', () => {
    expect(classifyAuthorizationMismatch(200, 403)).toEqual({
      severity: 'regression',
      meaning: 'access refused where it must be allowed',
    });
    expect(classifyAuthorizationMismatch(200, 401).severity).toBe('regression');
  });

  it('does not overstate a mismatch between two refusals', () => {
    // 403 where 404 was required is a concealment bug, not an access breach —
    // naming it a breach would make the word stop meaning anything.
    expect(classifyAuthorizationMismatch(404, 403).severity).toBe('mismatch');
    expect(classifyAuthorizationMismatch(400, 422).severity).toBe('mismatch');
  });
});

describe('authorizationFailureLine', () => {
  it('reads as an incident report: who, what, expected, received, and the meaning', () => {
    const line = authorizationFailureLine(
      'playerA',
      'PATCH /api/airlines/airlineB',
      403,
      200,
      '{"id":"airlineB"}',
    );
    expect(line).toContain('AUTHORIZATION BREACH');
    expect(line).toContain('playerA');
    expect(line).toContain('PATCH /api/airlines/airlineB');
    expect(line).toContain('expected 403');
    expect(line).toContain('received 200');
    expect(line).toContain('access GRANTED where it must be refused');
    // The body is evidence, kept but subordinate.
    expect(line).toContain('response: {"id":"airlineB"}');
  });

  it('does not shout about a regression', () => {
    const line = authorizationFailureLine('admin', 'GET /api/admin/worlds', 200, 403, '');
    expect(line).not.toContain('BREACH');
    expect(line).toContain('authorization regression');
    expect(line).toContain('access refused where it must be allowed');
  });

  it('truncates a large body rather than burying the verdict in it', () => {
    const line = authorizationFailureLine('guest', 'GET /api/x', 401, 200, 'x'.repeat(5_000));
    expect(line).toContain('AUTHORIZATION BREACH');
    expect(line).toContain('...');
    expect(line.length).toBeLessThan(600);
  });

  it('omits the response line entirely when there is no body', () => {
    const line = authorizationFailureLine('guest', 'GET /api/x', 401, 200, '   ');
    expect(line).not.toContain('response:');
  });
});
