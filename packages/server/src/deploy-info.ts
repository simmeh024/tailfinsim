import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * When this code was put here, and what was asked for (OPS-02).
 *
 * The sibling of `build-info.ts`, and the division between them is the point:
 *
 *   `build-info.json`   written by `build.mjs`   — *what* this is
 *   `deploy-info.json`  written by `deploy.sh`   — *how it got here*
 *
 * A build knows its commit; only the deploy knows that somebody asked for
 * `origin/main` at 14:05 and that this is the code that answered. Those are
 * different facts with different lifetimes — a box can be rebuilt without being
 * redeployed — so they are different files rather than one file written twice.
 *
 * ## Why a file rather than asking git
 *
 * The server must not shell out to git at runtime. The running process is a
 * bundle that may sit somewhere git knows nothing about, `git` need not be
 * installed beside it, and a version endpoint is not worth a subprocess. The
 * deploy writes what it knows at the moment it knows it.
 *
 * ## Why the ref is recorded rather than derived
 *
 * `deploy.sh` checks out with `--detach`, deliberately, so there is no branch on
 * disk to read back. Reconstructing one afterwards is guesswork: `git describe
 * --all --contains` will answer confidently and wrongly once a branch is
 * deleted. A wrong ref is worse than no ref, because the entire value of the
 * field is saying what somebody *meant* to put there.
 *
 * Absent is the normal case, not an error: a local `pnpm dev`, a test run, or a
 * build made by hand has never been deployed anywhere. That reports null, which
 * reads as "not from a deploy" rather than as a plausible wrong answer — the
 * same choice `build-info.ts` makes when it reports build 0.
 */

export interface DeployInfo {
  /** The ref as requested — `origin/main`, a branch, a tag, a sha. */
  ref: string;
  /** ISO 8601, UTC. When the deploy ran, not when the process last started. */
  deployedAt: string;
}

/** Resolves the same from `src` (dev) and `dist` (built) — each sits one level under packages/server. */
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function isDeployInfo(value: unknown): value is DeployInfo {
  if (typeof value !== 'object' || value === null) return false;
  const info = value as Record<string, unknown>;
  return (
    typeof info.ref === 'string' &&
    info.ref.length > 0 &&
    typeof info.deployedAt === 'string' &&
    // Must be a real instant. A deploy script writing a malformed date would
    // otherwise put a string the response schema rejects into every reply, and
    // turn a cosmetic field into a 500 on an endpoint used to diagnose outages.
    !Number.isNaN(Date.parse(info.deployedAt))
  );
}

/**
 * The part worth testing, separated from the file read.
 *
 * `null` in means "no such file", which is the normal case outside a deploy.
 * Anything malformed is treated the same way as absent, for the reason above:
 * this field exists to help diagnose a bad deploy, so it must not be the thing
 * that breaks during one.
 */
export function parseDeployInfo(raw: string | null): DeployInfo | null {
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return isDeployInfo(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

let cached: DeployInfo | null | undefined;

export function readDeployInfo(): DeployInfo | null {
  if (cached !== undefined) return cached;

  let raw: string | null;
  try {
    raw = readFileSync(resolve(packageRoot, 'dist', 'deploy-info.json'), 'utf8');
  } catch {
    raw = null;
  }

  cached = parseDeployInfo(raw);
  return cached;
}
