import { describe, expect, it } from 'vitest';

import type { VersionResponse } from '@tailfin/shared';

import {
  collectStatus,
  type EnvironmentStatus,
  findProblems,
  renderStatus,
  type StatusDeps,
} from './status';

/**
 * The deployment readout (OPS-02).
 *
 * Every input is injected, so the whole thing is exercised against a fixed set
 * of environments with no network. For a tool whose entire job is reporting on
 * remote state, that is the difference between tested and hoped-for — the cases
 * worth proving are the ones you cannot arrange on demand:
 *
 *   - production unreachable
 *   - GitHub unreachable
 *   - dev running something unmerged, which is normal
 *   - **dev behind production**, which is not
 */

const NOW = new Date('2026-08-19T18:00:00.000Z');

function version(overrides: Partial<VersionResponse> = {}): VersionResponse {
  return {
    build: 129,
    commit: 'abeee40',
    environment: 'production',
    startedAt: '2026-08-19T01:42:13.194Z',
    ref: 'origin/main',
    deployedAt: '2026-08-19T01:42:00.000Z',
    serverTime: '2026-08-19T18:00:00.000Z',
    ...overrides,
  };
}

/**
 * A fetch that answers from a table, and throws for anything not in it.
 *
 * Throwing rather than 404ing on purpose: an unexpected request should fail the
 * test loudly rather than quietly become an "unreachable" row.
 */
function fakeFetch(routes: Record<string, unknown>): StatusDeps['fetch'] {
  return ((url: string) => {
    for (const [pattern, body] of Object.entries(routes)) {
      if (url.includes(pattern)) {
        if (body instanceof Error) return Promise.reject(body);
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve(body),
        } as Response);
      }
    }
    return Promise.reject(new Error(`unexpected request: ${url}`));
  }) as StatusDeps['fetch'];
}

const TWO_ENVS = [
  { name: 'production', url: 'https://prod.example' },
  { name: 'dev', url: 'https://dev.example' },
];

/** `compare/<sha>...main`: ahead_by is how far behind the environment is. */
function compare(aheadBy: number, behindBy = 0) {
  return { ahead_by: aheadBy, behind_by: behindBy };
}

describe('collectStatus', () => {
  it('reports both environments and main together', async () => {
    const status = await collectStatus({
      environments: TWO_ENVS,
      fetch: fakeFetch({
        'repos/simmeh024/tailfinsim/commits/main': { sha: 'abeee40aaaaaaaa' },
        'prod.example/api/version': version({ build: 101, commit: 'ecf90e7' }),
        'dev.example/api/version': version({ build: 129, commit: 'abeee40', environment: 'dev' }),
        'compare/ecf90e7...main': compare(28),
        'compare/abeee40...main': compare(0),
      }),
    });

    expect(status.mainSha).toBe('abeee40aaaaaaaa');
    expect(status.environments).toHaveLength(2);
    const [prod, dev] = status.environments;
    expect(prod?.reachable && prod.distance?.behindBy).toBe(28);
    expect(dev?.reachable && dev.distance?.behindBy).toBe(0);
  });

  it('says an environment did not answer, rather than omitting it', async () => {
    // The single most important thing this tool can report. A readout that
    // dropped the row would say it by leaving a gap.
    const status = await collectStatus({
      environments: TWO_ENVS,
      fetch: fakeFetch({
        'repos/simmeh024/tailfinsim/commits/main': { sha: 'abeee40' },
        'prod.example/api/version': new Error('connect ETIMEDOUT'),
        'dev.example/api/version': version({ environment: 'dev' }),
        'compare/abeee40...main': compare(0),
      }),
    });

    expect(status.environments).toHaveLength(2);
    const prod = status.environments[0];
    expect(prod?.reachable).toBe(false);
    expect(prod?.reachable === false && prod.error).toMatch(/ETIMEDOUT/);
    expect(status.problems.join(' ')).toMatch(/production did not answer/);
  });

  it('treats an answer that is not a version as unreachable', async () => {
    // A proxy error page returns 200 with HTML. Parsing it as a version would
    // report a build number of `undefined` rather than a problem.
    const status = await collectStatus({
      environments: [TWO_ENVS[0]!],
      fetch: fakeFetch({
        'repos/simmeh024/tailfinsim/commits/main': { sha: 'abeee40' },
        'prod.example/api/version': { hello: 'not a version' },
      }),
    });

    const prod = status.environments[0];
    expect(prod?.reachable).toBe(false);
    expect(prod?.reachable === false && prod.error).toMatch(/not with a version/);
  });

  it('reads an environment older than itself, which is every box on the day this ships', async () => {
    // `ref` and `deployedAt` arrive with OPS-02. Parsing them strictly reported
    // both live boxes as unreachable when they were merely older — the failure
    // mode that matters most, since this is a tool for running around a deploy.
    const { ref: _ref, deployedAt: _deployedAt, ...older } = version({ build: 101 });

    const status = await collectStatus({
      environments: [TWO_ENVS[0]!],
      fetch: fakeFetch({
        'repos/simmeh024/tailfinsim/commits/main': { sha: 'abeee40' },
        'prod.example/api/version': older,
        'compare/abeee40...main': compare(28),
      }),
    });

    const prod = status.environments[0];
    expect(prod?.reachable).toBe(true);
    expect(prod?.reachable === true && prod.version.build).toBe(101);
    expect(prod?.reachable === true && prod.version.ref).toBeNull();
    expect(prod?.reachable === true && prod.version.deployedAt).toBeNull();
  });

  it('survives GitHub being unreachable, and does not claim things are up to date', async () => {
    const status = await collectStatus({
      environments: [TWO_ENVS[0]!],
      fetch: fakeFetch({
        'api.github.com': new Error('403 rate limited'),
        'prod.example/api/version': version(),
      }),
    });

    expect(status.mainSha).toBeNull();
    // Null, not zero. "Unknown" and "level with main" must not render the same.
    expect(status.environments[0]?.reachable && status.environments[0].distance).toBeNull();
  });

  it('strips the +dirty suffix before asking GitHub about a commit', async () => {
    // `build.mjs` marks a build made from a modified tree. GitHub does not know
    // that sha, so the comparison would silently return nothing.
    const seen: string[] = [];
    await collectStatus({
      environments: [TWO_ENVS[0]!],
      fetch: ((url: string) => {
        seen.push(url);
        const body = url.includes('/api/version')
          ? version({ commit: 'ecf90e7+dirty' })
          : url.includes('commits/main')
            ? { sha: 'abeee40' }
            : compare(3);
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve(body),
        } as Response);
      }) as StatusDeps['fetch'],
    });

    expect(seen.some((u) => u.includes('compare/ecf90e7...main'))).toBe(true);
    expect(seen.some((u) => u.includes('+dirty'))).toBe(false);
  });
});

describe('findProblems', () => {
  function env(
    name: string,
    build: number,
    distance: { behindBy: number; notOnMain: boolean } | null,
  ): EnvironmentStatus {
    return { name, reachable: true, version: version({ build }), distance };
  }

  it('is quiet when everything is level with main', () => {
    expect(
      findProblems([
        env('production', 129, { behindBy: 0, notOnMain: false }),
        env('dev', 129, { behindBy: 0, notOnMain: false }),
      ]),
    ).toEqual([]);
  });

  it('reports how far production is behind', () => {
    const problems = findProblems([env('production', 101, { behindBy: 28, notOnMain: false })]);

    expect(problems.join(' ')).toMatch(/production is 28 commits behind main/);
  });

  it('gets the singular right, because 1 commits reads as a bug', () => {
    const problems = findProblems([env('production', 128, { behindBy: 1, notOnMain: false })]);

    expect(problems.join(' ')).toMatch(/1 commit behind/);
  });

  it('shouts when production is running something not on main', () => {
    // OPS-01 refuses this, so it should be unreachable. If it happens the guard
    // has been bypassed or history rewritten, and both beat being merely behind.
    const problems = findProblems([env('production', 101, { behindBy: 5, notOnMain: true })]);

    expect(problems[0]).toMatch(/not on main/);
  });

  it('does not complain about dev running something unmerged — that is what dev is for', () => {
    const problems = findProblems([
      env('production', 129, { behindBy: 0, notOnMain: false }),
      env('dev', 130, { behindBy: 2, notOnMain: true }),
    ]);

    expect(problems.join(' ')).not.toMatch(/dev/);
  });

  it('flags dev being behind production, which inverts the staging invariant', () => {
    // The state found on 2026-08-19: dev on build 94, production on 101. Dev is
    // supposed to be where things are seen *before* release (OPS-06).
    const problems = findProblems([
      env('production', 101, { behindBy: 28, notOnMain: false }),
      env('dev', 94, { behindBy: 35, notOnMain: false }),
    ]);

    expect(problems.join(' ')).toMatch(/dev is behind production/);
  });

  it('says nothing about the invariant when it cannot know', () => {
    const problems = findProblems([env('production', 101, null), env('dev', 94, null)]);

    expect(problems.join(' ')).not.toMatch(/dev is behind/);
  });
});

describe('renderStatus', () => {
  const status = {
    mainSha: 'abeee40aaaaaaaaaaaa',
    environments: [
      {
        name: 'production',
        reachable: true as const,
        version: version({ build: 101, commit: 'ecf90e7', deployedAt: '2026-08-19T01:42:00.000Z' }),
        distance: { behindBy: 28, notOnMain: false },
      },
      {
        name: 'dev',
        reachable: false as const,
        error: 'connect ETIMEDOUT',
      },
    ],
    problems: ['production is 28 commits behind main'],
  };

  it('shows main, each environment, and the problems', () => {
    const out = renderStatus(status, NOW);

    expect(out).toMatch(/main\s+abeee40/);
    expect(out).toMatch(/production\s+101\s+ecf90e7\s+28/);
    expect(out).toMatch(/dev\s+unreachable — connect ETIMEDOUT/);
    expect(out).toMatch(/!\s+production is 28 commits behind main/);
  });

  it('shows the ref that was asked for, and how long ago', () => {
    const out = renderStatus(status, NOW);

    expect(out).toContain('origin/main');
    // Deployed 01:42, rendered at 18:00 — sixteen hours.
    expect(out).toMatch(/16h ago/);
  });

  it('renders an em dash for a process that was never deployed', () => {
    // A local `pnpm dev` has no ref and no deploy time. It must not render as
    // blank columns that look like a parsing failure.
    const out = renderStatus(
      {
        mainSha: 'abeee40',
        environments: [
          {
            name: 'local',
            reachable: true,
            version: version({ ref: null, deployedAt: null }),
            distance: { behindBy: 0, notOnMain: false },
          },
        ],
        problems: [],
      },
      NOW,
    );

    expect(out).toMatch(/local\s+129\s+abeee40\s+0\s+—\s+—/);
  });

  it('marks and explains a commit that is not on main, only when there is one', () => {
    const clean = renderStatus(status, NOW);
    expect(clean).not.toContain('not on main');

    const unmerged = renderStatus(
      {
        ...status,
        environments: [
          {
            name: 'dev',
            reachable: true,
            version: version({ environment: 'dev' }),
            distance: { behindBy: 2, notOnMain: true },
          },
        ],
      },
      NOW,
    );
    expect(unmerged).toMatch(/2\*/);
    expect(unmerged).toContain('not on main');
  });

  it('says so when GitHub could not be reached, rather than printing a blank', () => {
    const out = renderStatus({ ...status, mainSha: null }, NOW);

    expect(out).toMatch(/GitHub unreachable/);
  });
});
