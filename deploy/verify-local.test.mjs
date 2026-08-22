import { describe, expect, it, vi } from 'vitest';

import { inspectDatabase, runVerification } from './verify-local.mjs';

const pass = () => ({ status: 'PASS', detail: '' });

describe('the local verification summary', () => {
  it('names every composed script and an absent database without calling it a pass', async () => {
    const scripts = [];
    let output = '';

    const exitCode = await runVerification({
      runScript: async (script) => {
        scripts.push(script);
        return pass();
      },
      inspect: inspectDatabase,
      // CI supplies DATABASE_URL globally. An explicit empty string models the
      // ordinary local environment without inheriting CI's disposable database.
      databaseUrl: '',
      write: (text) => {
        output += text;
      },
    });

    expect(exitCode).toBe(0);
    expect(scripts).toEqual([
      'typecheck',
      'lint',
      'format:check',
      'build',
      'test:coverage',
      'test:perf',
    ]);
    expect(output).toContain('Database tests       SKIPPED — no DATABASE_URL');
    expect(output).toContain('Performance          PASS — indicative local run only');
    expect(output).toContain('CI remains authoritative for the protected merge checks.');
  });

  it('prints the complete summary and stops expensive stages after a failure', async () => {
    const scripts = [];
    let output = '';

    const exitCode = await runVerification({
      runScript: async (script) => {
        scripts.push(script);
        return script === 'lint' ? { status: 'FAIL', detail: 'simulated lint failure' } : pass();
      },
      write: (text) => {
        output += text;
      },
    });

    expect(exitCode).toBe(1);
    expect(scripts).toEqual(['typecheck', 'lint']);
    for (const label of [
      'Types',
      'Lint',
      'Formatting',
      'Production build',
      'Tests',
      'Database tests',
      'Performance',
    ]) {
      expect(output).toContain(label);
    }
    expect(output).toContain('Formatting           SKIPPED — stopped after Lint failed');
    expect(output).toContain('Local preflight failed.');
  });

  it('refuses an unsafe database before starting tests', async () => {
    const scripts = [];
    let output = '';

    const exitCode = await runVerification({
      runScript: async (script) => {
        scripts.push(script);
        return pass();
      },
      databaseUrl: 'postgres://localhost/tailfin_dev',
      write: (text) => {
        output += text;
      },
    });

    expect(exitCode).toBe(1);
    expect(scripts).toEqual(['typecheck', 'lint', 'format:check', 'build']);
    expect(output).toContain('Tests                SKIPPED — database preflight failed');
    expect(output).toContain(
      'Database tests       FAIL — DATABASE_URL selects non-disposable database "tailfin_dev"',
    );
  });
});

describe('the local test-database probe', () => {
  it('distinguishes missing, malformed, refused and unreachable databases', async () => {
    await expect(inspectDatabase(undefined)).resolves.toMatchObject({
      kind: 'absent',
      summary: { status: 'SKIPPED' },
    });
    await expect(inspectDatabase('not a URL')).resolves.toMatchObject({
      kind: 'refused',
      summary: { status: 'FAIL', detail: expect.stringContaining('names no database') },
    });
    await expect(inspectDatabase('postgres://localhost/tailfin_dev')).resolves.toMatchObject({
      kind: 'refused',
      summary: { status: 'FAIL', detail: expect.stringContaining('non-disposable') },
    });

    const refusal = Object.assign(new Error('secret-bearing driver text'), {
      code: 'ECONNREFUSED',
    });
    await expect(
      inspectDatabase('postgres://user:secret@127.0.0.1:5432/tailfin_test', {
        createClient: () => ({
          connect: async () => Promise.reject(refusal),
          query: vi.fn(),
          end: vi.fn(),
        }),
      }),
    ).resolves.toEqual({
      kind: 'unusable',
      summary: {
        status: 'FAIL',
        detail: 'connection refused by 127.0.0.1:5432/tailfin_test',
      },
    });
  });

  it('reports a disposable database only after a query and clean disconnect', async () => {
    const connect = vi.fn(async () => undefined);
    const query = vi.fn(async () => ({ rows: [{ '?column?': 1 }] }));
    const end = vi.fn(async () => undefined);

    await expect(
      inspectDatabase('postgres://localhost/tailfin_test', {
        createClient: () => ({ connect, query, end }),
      }),
    ).resolves.toEqual({
      kind: 'ready',
      name: 'tailfin_test',
      summary: {
        status: 'PASS',
        detail: 'reachable disposable database "tailfin_test" was exercised',
      },
    });
    expect(query).toHaveBeenCalledWith('select 1');
    expect(end).toHaveBeenCalledOnce();
  });
});
