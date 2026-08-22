import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  assertDisposableDatabaseUrl,
  databaseNameOf,
} from '../packages/server/src/test-support/database-safety.ts';

/**
 * The local counterpart of `.github/workflows/ci.yml`, not a replacement for it.
 * Keep the composed package scripts aligned with CI while leaving CI's explicit
 * steps, PostgreSQL service, Caddy integration, and artefact assertions intact.
 */
const STAGES = [
  { key: 'types', label: 'Types', script: 'typecheck' },
  { key: 'lint', label: 'Lint', script: 'lint' },
  { key: 'formatting', label: 'Formatting', script: 'format:check' },
  { key: 'build', label: 'Production build', script: 'build' },
  { key: 'tests', label: 'Tests', script: 'test:coverage' },
  { key: 'performance', label: 'Performance', script: 'test:perf' },
];

const SUMMARY_ORDER = [
  ...STAGES.slice(0, 5).map(({ key, label }) => ({ key, label })),
  { key: 'database', label: 'Database tests' },
  STAGES[5],
];

const serverRequire = createRequire(new URL('../packages/server/package.json', import.meta.url));
const { Client } = serverRequire('pg');

function outcome(status, detail = '') {
  return { status, detail };
}

function databaseEndpoint(url, name) {
  const parsed = new URL(url);
  return `${parsed.hostname || '<unknown host>'}:${parsed.port || '5432'}/${name}`;
}

function databaseFailure(error, endpoint) {
  const code =
    typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : null;

  switch (code) {
    case 'ECONNREFUSED':
      return `connection refused by ${endpoint}`;
    case 'ENOTFOUND':
      return `database host for ${endpoint} was not found`;
    case 'ETIMEDOUT':
    case 'CONNECT_TIMEOUT':
      return `connection to ${endpoint} timed out`;
    case '28P01':
      return `authentication failed for ${endpoint}`;
    case '3D000':
      return `database ${endpoint} does not exist`;
    default:
      return `connection probe for ${endpoint} failed${code === null ? '' : ` (${code})`}`;
  }
}

/**
 * Classifies the exact DATABASE_URL Vitest will see, then proves a safe URL is
 * usable with a read-only query. No credential or complete connection string is
 * ever printed.
 */
export async function inspectDatabase(
  url,
  { createClient = (options) => new Client(options) } = {},
) {
  if (url === undefined || url === '') {
    return {
      kind: 'absent',
      summary: outcome('SKIPPED', 'no DATABASE_URL; database-backed tests will not run'),
    };
  }

  const name = databaseNameOf(url);
  try {
    assertDisposableDatabaseUrl(url);
  } catch {
    return {
      kind: 'refused',
      summary:
        name === null
          ? outcome('FAIL', 'DATABASE_URL names no database; test-setup.ts would refuse it')
          : outcome(
              'FAIL',
              `DATABASE_URL selects non-disposable database "${name}"; test-setup.ts would refuse it`,
            ),
    };
  }

  const endpoint = databaseEndpoint(url, name);
  const client = createClient({
    connectionString: url,
    connectionTimeoutMillis: 3_000,
    query_timeout: 3_000,
    application_name: 'tailfin-local-verify',
  });
  let failure = null;
  let connected = false;

  try {
    await client.connect();
    connected = true;
    await client.query('select 1');
  } catch (error) {
    failure = databaseFailure(error, endpoint);
  }

  if (connected) {
    try {
      await client.end();
    } catch (error) {
      failure ??= `clean shutdown of the database probe failed: ${databaseFailure(error, endpoint)}`;
    }
  }

  if (failure !== null) {
    return { kind: 'unusable', summary: outcome('FAIL', failure) };
  }

  return {
    kind: 'ready',
    name,
    summary: outcome('PASS', `reachable disposable database "${name}" was exercised`),
  };
}

function packageManagerInvocation(script) {
  if (process.env.npm_execpath) {
    return { command: process.execPath, arguments: [process.env.npm_execpath, 'run', script] };
  }
  return {
    command: process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
    arguments: ['run', script],
  };
}

export function runPackageScript(script) {
  const invocation = packageManagerInvocation(script);
  return new Promise((resolveRun) => {
    const child = spawn(invocation.command, invocation.arguments, {
      cwd: resolve(fileURLToPath(new URL('..', import.meta.url))),
      env: process.env,
      stdio: 'inherit',
    });

    child.once('error', (error) => {
      resolveRun(outcome('FAIL', `could not start pnpm ${script}: ${error.message}`));
    });
    child.once('exit', (code, signal) => {
      if (code === 0) resolveRun(outcome('PASS'));
      else if (signal !== null) resolveRun(outcome('FAIL', `pnpm ${script} stopped by ${signal}`));
      else resolveRun(outcome('FAIL', `pnpm ${script} exited ${code}`));
    });
  });
}

function skippedAfter(label) {
  return outcome('SKIPPED', `stopped after ${label} failed`);
}

export function formatSummary(results, passed) {
  const lines = ['Local verification summary', ''];
  for (const { key, label } of SUMMARY_ORDER) {
    const result = results.get(key);
    const detail = result.detail === '' ? '' : ` — ${result.detail}`;
    lines.push(`${label.padEnd(20)} ${result.status}${detail}`);
  }
  lines.push('', passed ? 'Local preflight passed.' : 'Local preflight failed.');
  lines.push('CI remains authoritative for the protected merge checks.');
  lines.push('Full PostgreSQL verification remains CI-owned.');
  return `${lines.join('\n')}\n`;
}

export async function runVerification({
  runScript = runPackageScript,
  inspect = inspectDatabase,
  write = (text) => process.stdout.write(text),
  databaseUrl = process.env.DATABASE_URL,
} = {}) {
  const results = new Map(
    SUMMARY_ORDER.map(({ key }) => [key, outcome('SKIPPED', 'stage was not reached')]),
  );
  let failedLabel = null;
  let database = null;

  for (const stage of STAGES) {
    if (failedLabel !== null) {
      results.set(stage.key, skippedAfter(failedLabel));
      continue;
    }

    if (stage.key === 'tests') {
      try {
        database = await inspect(databaseUrl);
      } catch (error) {
        database = {
          kind: 'unusable',
          summary: outcome(
            'FAIL',
            `database preflight crashed: ${error instanceof Error ? error.message : String(error)}`,
          ),
        };
      }
      results.set('database', database.summary);
      if (database.summary.status === 'FAIL') {
        results.set('tests', outcome('SKIPPED', 'database preflight failed'));
        failedLabel = 'Database tests';
        continue;
      }
    }

    write(`\n==> ${stage.label} (pnpm ${stage.script})\n`);
    let result;
    try {
      result = await runScript(stage.script);
    } catch (error) {
      result = outcome(
        'FAIL',
        `stage runner crashed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (stage.key === 'performance' && result.status === 'PASS') {
      result.detail =
        'indicative local run only; the server budget must be measured on its 2-core Xeon';
    }
    results.set(stage.key, result);

    if (stage.key === 'tests' && database?.kind === 'ready' && result.status !== 'PASS') {
      results.set(
        'database',
        outcome(
          'FAIL',
          `database-backed verification ran against "${database.name}" but did not pass`,
        ),
      );
    }
    if (result.status === 'FAIL') failedLabel = stage.label;
  }

  const passed = ![...results.values()].some(({ status }) => status === 'FAIL');
  write(`\n${formatSummary(results, passed)}`);
  return passed ? 0 : 1;
}

const invokedPath = process.argv[1] === undefined ? null : resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  process.exitCode = await runVerification();
}
