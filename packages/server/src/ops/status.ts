import { VersionResponse } from '@tailfin/shared';

/**
 * What is deployed where (OPS-02).
 *
 * There was no way to answer *"what is running on production?"* without an SSH
 * session. That is not hypothetical: an inspection in August 2026 found
 * production 27 commits behind `main`, and nothing anywhere reported it. It had
 * been that way for a day.
 *
 * `/api/version` already answered the per-instance question. The gap was that
 * **nothing compared instances**, and comparison needs a third input neither
 * instance has: `main`'s tip.
 *
 * ## Deliberately a script, not a dashboard
 *
 * The issue's own scoping note, and it is right. A panel in the admin console is
 * nicer and can follow once there is somewhere natural to hang it; a command
 * that answers the question completely is worth more today, and cannot rot into
 * a page nobody opens.
 *
 * ## Everything here takes its inputs
 *
 * `fetch` and the clock arrive as parameters. That is not ceremony — it is what
 * lets the whole readout be tested against a fixed set of environments with no
 * network, which for a tool whose entire job is reporting on remote state is the
 * difference between tested and hoped-for.
 */

/** A place code runs. */
export interface Environment {
  name: string;
  /** Base URL, no trailing slash — `/api/version` is appended. */
  url: string;
}

/** The two Tailfin runs, from `docs/deploy.md`. */
export const ENVIRONMENTS: readonly Environment[] = [
  { name: 'production', url: 'https://tailfinsim.com' },
  { name: 'dev', url: 'https://dev.tailfinsim.com' },
];

/**
 * How an environment compares to `main`.
 *
 * `behindBy` is how many commits `main` has that this environment does not.
 * `notOnMain` is the other direction and matters more: an environment running a
 * commit that is not an ancestor of `main` at all is running something unmerged.
 * For dev that is normal and is the whole point of dev. For production it should
 * be impossible — OPS-01 refuses it — so seeing it means something is wrong in a
 * way worth shouting about.
 */
export interface Distance {
  behindBy: number;
  notOnMain: boolean;
}

export type EnvironmentStatus =
  | { name: string; reachable: true; version: VersionResponse; distance: Distance | null }
  /**
   * Unreachable, or answering something that is not a version.
   *
   * A first-class outcome rather than an omission: "production did not answer"
   * is the single most important thing this tool can say, and a readout that
   * silently drops a row would say it by leaving a gap.
   */
  | { name: string; reachable: false; error: string };

export interface DeploymentStatus {
  /** `main`'s tip on GitHub, or null when GitHub could not be reached. */
  mainSha: string | null;
  environments: EnvironmentStatus[];
  /** Set when something is wrong enough that a human should look. */
  problems: string[];
}

export interface StatusDeps {
  fetch: typeof globalThis.fetch;
  /** `owner/repo`, so a fork can point this at itself. */
  repo?: string;
  /** Optional; a public repository needs none, but the rate limit is kinder with one. */
  githubToken?: string;
  environments?: readonly Environment[];
  /** Per-request timeout. An unreachable box must fail fast, not hang the report. */
  timeoutMs?: number;
}

const DEFAULT_REPO = 'simmeh024/tailfinsim';
const DEFAULT_TIMEOUT_MS = 10_000;

function errorText(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  return String(cause);
}

async function getJson(
  deps: StatusDeps,
  url: string,
  headers: Record<string, string> = {},
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, deps.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const response = await deps.fetch(url, { headers, signal: controller.signal });
    if (!response.ok) {
      throw new Error(`HTTP ${String(response.status)}`);
    }
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

/** `main`'s tip, or null if GitHub could not be asked. */
export async function fetchMainSha(deps: StatusDeps): Promise<string | null> {
  const repo = deps.repo ?? DEFAULT_REPO;
  const headers: Record<string, string> = { accept: 'application/vnd.github+json' };
  if (deps.githubToken) headers.authorization = `Bearer ${deps.githubToken}`;

  try {
    const body = await getJson(deps, `https://api.github.com/repos/${repo}/commits/main`, headers);
    const sha = (body as { sha?: unknown }).sha;
    return typeof sha === 'string' ? sha : null;
  } catch {
    return null;
  }
}

/**
 * How far a deployed commit is from `main`, via GitHub's compare endpoint.
 *
 * `compare/BASE...HEAD` reports `ahead_by` as the commits HEAD has that BASE
 * lacks. Comparing `<deployed>...main` therefore reads the two directions this
 * needs at once: `ahead_by` is how far behind the environment is, and
 * `behind_by` — commits the *environment* has that `main` does not — is what
 * says it is running something unmerged.
 *
 * Null when GitHub could not answer, which is different from zero and must not
 * be rendered as "up to date".
 */
export async function fetchDistance(deps: StatusDeps, commit: string): Promise<Distance | null> {
  const repo = deps.repo ?? DEFAULT_REPO;
  const headers: Record<string, string> = { accept: 'application/vnd.github+json' };
  if (deps.githubToken) headers.authorization = `Bearer ${deps.githubToken}`;

  try {
    const body = (await getJson(
      deps,
      `https://api.github.com/repos/${repo}/compare/${commit}...main`,
      headers,
    )) as { ahead_by?: unknown; behind_by?: unknown };

    if (typeof body.ahead_by !== 'number' || typeof body.behind_by !== 'number') return null;
    return { behindBy: body.ahead_by, notOnMain: body.behind_by > 0 };
  } catch {
    return null;
  }
}

/** Ask one environment what it is running. */
export async function fetchEnvironment(
  deps: StatusDeps,
  environment: Environment,
): Promise<EnvironmentStatus> {
  let version: VersionResponse;
  try {
    const body = await getJson(deps, `${environment.url}/api/version`);
    /**
     * Defaults first, then the body over the top.
     *
     * `ref` and `deployedAt` arrive with OPS-02 itself, so every environment
     * deployed before it lacks them — which is every environment the day this
     * ships. Parsing them strictly rejected both boxes and reported them
     * *unreachable*, when the truth was "reachable, and older than this tool".
     *
     * That failure mode is the one that matters, because this is a tool for
     * running *around* a deploy: it has to read the version still there as well
     * as the one replacing it. A monitor that only works once everything is
     * upgraded is blind exactly when it is wanted.
     *
     * Spreading over defaults rather than loosening the schema keeps every other
     * field strict — a box answering without a `build` is still a broken box.
     */
    const parsed = VersionResponse.safeParse({
      ref: null,
      deployedAt: null,
      ...(body as Record<string, unknown>),
    });
    if (!parsed.success) {
      return {
        name: environment.name,
        reachable: false,
        error: 'answered, but not with a version',
      };
    }
    version = parsed.data;
  } catch (cause) {
    return { name: environment.name, reachable: false, error: errorText(cause) };
  }

  const distance = await fetchDistance(deps, version.commit.replace('+dirty', ''));
  return { name: environment.name, reachable: true, version, distance };
}

/**
 * The problems worth a human's attention, derived rather than printed inline.
 *
 * Separated so the rules are testable without a network and without a renderer.
 * Order matters: the most alarming first, because whoever runs this reads the
 * top of the output.
 */
export function findProblems(environments: EnvironmentStatus[]): string[] {
  const problems: string[] = [];
  const byName = new Map(environments.map((e) => [e.name, e]));

  for (const environment of environments) {
    if (!environment.reachable) {
      problems.push(`${environment.name} did not answer: ${environment.error}`);
    }
  }

  const production = byName.get('production');
  if (production?.reachable && production.distance?.notOnMain) {
    // OPS-01 refuses a ref that is not an ancestor of main, so this should be
    // unreachable. If it happens, the guard has been bypassed or the history
    // has been rewritten, and both are worse than being behind.
    problems.push('production is running a commit that is not on main');
  }

  const dev = byName.get('dev');
  if (
    dev?.reachable &&
    production?.reachable &&
    dev.distance &&
    production.distance &&
    // Only when dev is on an ancestor of `main`. A dev running a branch is
    // *diverged*, not old, and "behind main" then counts commits the branch
    // simply forked before — which says nothing about whether it is newer than
    // what is released. Comparing them would flag every branch preview.
    !dev.distance.notOnMain
  ) {
    if (dev.distance.behindBy > production.distance.behindBy) {
      // The invariant OPS-06 turns on: dev is the staging ground, so it should
      // never be older than what is already released.
      problems.push(
        `dev is behind production — build ${String(dev.version.build)} against ${String(production.version.build)}`,
      );
    }
  }

  if (production?.reachable && production.distance && production.distance.behindBy > 0) {
    problems.push(
      `production is ${String(production.distance.behindBy)} commit${production.distance.behindBy === 1 ? '' : 's'} behind main`,
    );
  }

  return problems;
}

/** Ask everything, in parallel — one slow box must not serialise the report. */
export async function collectStatus(deps: StatusDeps): Promise<DeploymentStatus> {
  const environments = deps.environments ?? ENVIRONMENTS;
  const [mainSha, ...results] = await Promise.all([
    fetchMainSha(deps),
    ...environments.map((environment) => fetchEnvironment(deps, environment)),
  ]);

  return { mainSha, environments: results, problems: findProblems(results) };
}

function age(from: string | null, now: Date): string {
  if (from === null) return '—';
  const ms = now.getTime() - Date.parse(from);
  if (!Number.isFinite(ms)) return '—';
  const hours = Math.floor(ms / 3_600_000);
  if (hours < 1) return `${String(Math.max(0, Math.floor(ms / 60_000)))}m ago`;
  if (hours < 48) return `${String(hours)}h ago`;
  return `${String(Math.floor(hours / 24))}d ago`;
}

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + ' '.repeat(width - text.length);
}

/**
 * The readout.
 *
 * Plain text and fixed width rather than a table library: this is read in a
 * terminal over SSH-less curiosity, and one dependency for column alignment is
 * one dependency too many for a tool this small.
 */
export function renderStatus(status: DeploymentStatus, now: Date): string {
  const lines: string[] = [];

  lines.push(`main   ${status.mainSha ? status.mainSha.slice(0, 7) : '(GitHub unreachable)'}`);
  lines.push('');
  lines.push(
    `${pad('environment', 12)}${pad('build', 8)}${pad('commit', 10)}${pad('behind', 8)}${pad('ref', 16)}deployed`,
  );

  for (const environment of status.environments) {
    if (!environment.reachable) {
      lines.push(`${pad(environment.name, 12)}unreachable — ${environment.error}`);
      continue;
    }

    const { version, distance } = environment;
    const behind =
      distance === null
        ? '?'
        : distance.notOnMain
          ? `${String(distance.behindBy)}*`
          : String(distance.behindBy);

    lines.push(
      pad(environment.name, 12) +
        pad(String(version.build), 8) +
        pad(version.commit, 10) +
        pad(behind, 8) +
        pad(version.ref ?? '—', 16) +
        age(version.deployedAt, now),
    );
  }

  // The legend only appears when the marker does, so a clean report stays clean.
  if (status.environments.some((e) => e.reachable && e.distance?.notOnMain)) {
    lines.push('');
    lines.push('* running commits that are not on main');
  }

  if (status.problems.length > 0) {
    lines.push('');
    for (const problem of status.problems) lines.push(`!  ${problem}`);
  }

  return lines.join('\n');
}
