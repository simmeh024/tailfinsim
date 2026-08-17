import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Which build this process is (M0-12).
 *
 * `build.mjs` writes `dist/build-info.json` at build time; this reads it once at
 * boot. The file is deliberately **not** committed — it is derived from git, and
 * a committed copy would be stale the moment anyone pushed.
 *
 * Running from source (tests, `pnpm dev`) there is no such file, and that is not
 * an error: the fallback reports build 0, which reads as "not a real build"
 * rather than as a plausible wrong number.
 */

export interface BuildInfo {
  build: number;
  commit: string;
}

/** Resolves the same from `src` (dev) and `dist` (built) — each sits one level under packages/server. */
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const FALLBACK_BUILD_INFO: BuildInfo = { build: 0, commit: 'source' };

function isBuildInfo(value: unknown): value is BuildInfo {
  if (typeof value !== 'object' || value === null) return false;
  const info = value as Record<string, unknown>;
  return (
    typeof info.build === 'number' &&
    Number.isInteger(info.build) &&
    info.build >= 0 &&
    typeof info.commit === 'string' &&
    info.commit.length > 0
  );
}

/**
 * The part worth testing, separated from the file read.
 *
 * `null` means "no such file", which is the normal case when running from
 * source. Anything malformed is treated the same way as absent — a build stamp
 * is not worth crashing a server over, and reporting build 0 is honest.
 */
export function parseBuildInfo(raw: string | null): BuildInfo {
  if (raw === null) return FALLBACK_BUILD_INFO;
  try {
    const parsed: unknown = JSON.parse(raw);
    return isBuildInfo(parsed) ? parsed : FALLBACK_BUILD_INFO;
  } catch {
    return FALLBACK_BUILD_INFO;
  }
}

let cached: BuildInfo | undefined;

export function readBuildInfo(): BuildInfo {
  if (cached) return cached;

  let raw: string | null;
  try {
    raw = readFileSync(resolve(packageRoot, 'dist', 'build-info.json'), 'utf8');
  } catch {
    raw = null;
  }

  cached = parseBuildInfo(raw);
  return cached;
}
