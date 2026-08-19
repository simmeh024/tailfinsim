import { describe, expect, it } from 'vitest';

import { parseDeployInfo } from './deploy-info';

/**
 * The deploy stamp (OPS-02).
 *
 * The parsing half, which is the half worth testing: reading a file is the
 * filesystem's job. Every case here is "the deploy script wrote something odd",
 * and the rule throughout is the same as `build-info.ts` — a bad stamp reports
 * *absent*, never a plausible wrong answer, and never an exception. This field
 * exists to help diagnose a bad deploy, so it must not be what breaks during one.
 */

describe('parseDeployInfo', () => {
  it('reads a stamp the deploy script wrote', () => {
    expect(parseDeployInfo('{"ref":"origin/main","deployedAt":"2026-08-19T01:42:00Z"}')).toEqual({
      ref: 'origin/main',
      deployedAt: '2026-08-19T01:42:00Z',
    });
  });

  it('reports absent when there is no file', () => {
    // The normal case outside a deploy: a local `pnpm dev`, a test, a hand build.
    expect(parseDeployInfo(null)).toBeNull();
  });

  it('reports absent rather than throwing on malformed JSON', () => {
    expect(parseDeployInfo('{ not json')).toBeNull();
    expect(parseDeployInfo('')).toBeNull();
  });

  it('rejects a stamp missing either half', () => {
    expect(parseDeployInfo('{"ref":"origin/main"}')).toBeNull();
    expect(parseDeployInfo('{"deployedAt":"2026-08-19T01:42:00Z"}')).toBeNull();
  });

  it('rejects an empty ref, which is what an unset variable writes', () => {
    // `printf '"%s"' "$TARGET"` with TARGET unset produces exactly this, and it
    // would otherwise render as a ref of nothing at all.
    expect(parseDeployInfo('{"ref":"","deployedAt":"2026-08-19T01:42:00Z"}')).toBeNull();
  });

  it('rejects a deploy time that is not a real instant', () => {
    // Guards the response schema: `deployedAt` is `z.iso.datetime().nullable()`,
    // so a malformed date would turn a cosmetic field into a 500 on the endpoint
    // used to diagnose the outage.
    expect(parseDeployInfo('{"ref":"origin/main","deployedAt":"whenever"}')).toBeNull();
    expect(parseDeployInfo('{"ref":"origin/main","deployedAt":""}')).toBeNull();
  });

  it('rejects the wrong types rather than coercing them', () => {
    expect(parseDeployInfo('{"ref":123,"deployedAt":"2026-08-19T01:42:00Z"}')).toBeNull();
    expect(parseDeployInfo('null')).toBeNull();
    expect(parseDeployInfo('"a string"')).toBeNull();
    expect(parseDeployInfo('[]')).toBeNull();
  });
});
