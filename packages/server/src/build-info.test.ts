import { describe, expect, it } from 'vitest';

import { FALLBACK_BUILD_INFO, parseBuildInfo, readBuildInfo } from './build-info';

/**
 * `build.mjs` writes `dist/build-info.json`; this reads it.
 *
 * The parsing is tested through `parseBuildInfo` rather than by writing files,
 * so the result does not depend on whether the package happens to have been
 * built on this machine — which is exactly the assumption that made the first
 * version of this test pass locally and then fail after a build.
 */

describe('parseBuildInfo', () => {
  it('reads a well-formed stamp', () => {
    expect(parseBuildInfo('{"build": 137, "commit": "abc1234"}')).toEqual({
      build: 137,
      commit: 'abc1234',
    });
  });

  it('falls back when the file is absent', () => {
    // The normal case when running from source: not an error.
    expect(parseBuildInfo(null)).toEqual(FALLBACK_BUILD_INFO);
  });

  it('falls back on malformed JSON rather than throwing', () => {
    // A truncated write during a deploy must not stop the server booting.
    expect(parseBuildInfo('{"build": 137,')).toEqual(FALLBACK_BUILD_INFO);
  });

  it.each([
    ['a string build number', '{"build": "137", "commit": "abc"}'],
    ['a fractional build number', '{"build": 1.5, "commit": "abc"}'],
    ['a negative build number', '{"build": -1, "commit": "abc"}'],
    ['an empty commit', '{"build": 1, "commit": ""}'],
    ['a missing commit', '{"build": 1}'],
    ['an array', '[1, 2]'],
    ['null', 'null'],
  ])('falls back on %s', (_label, raw) => {
    expect(parseBuildInfo(raw)).toEqual(FALLBACK_BUILD_INFO);
  });

  it('reports build 0 in the fallback, not a plausible number', () => {
    // 0 reads as "this is not a real build". Any other default would look like a
    // genuine version and send someone looking for a commit that does not exist.
    expect(FALLBACK_BUILD_INFO.build).toBe(0);
  });
});

describe('readBuildInfo', () => {
  it('returns a usable stamp whether or not the package has been built', () => {
    const info = readBuildInfo();
    expect(Number.isInteger(info.build)).toBe(true);
    expect(info.build).toBeGreaterThanOrEqual(0);
    expect(info.commit.length).toBeGreaterThan(0);
  });

  it('caches, so the file is not re-read on every request', () => {
    expect(readBuildInfo()).toBe(readBuildInfo());
  });
});
