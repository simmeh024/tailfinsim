import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * The dev worker's deployment and units (OPS-09).
 *
 * These are files that only ever run on a machine, which is exactly why they are
 * worth asserting here: every property below was decided for a reason, and the
 * place each one gets broken is a box nobody is watching at the time. The cost of
 * finding out there is one line, and on the box it is an outage or — for the two
 * about migrations and about binding — something worse and quieter.
 */

const repoRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..');
const deployScript = resolve(repoRoot, 'deploy', 'deploy.sh');
const workerScript = resolve(repoRoot, 'deploy', 'deploy-dev-worker.sh');
const workerUnit = resolve(repoRoot, 'deploy', 'tailfin-dev-worker.service');
const tunnelUnit = resolve(repoRoot, 'deploy', 'tailfin-db-tunnel.service');

/**
 * The script with its comment lines removed.
 *
 * Every assertion below is about what a script *does*, and these scripts explain
 * themselves at length — so a `toContain` against the raw source can be satisfied
 * by the paragraph describing the setting rather than by the setting. Mutation
 * testing caught exactly that: deleting `export SERVES_PUBLIC_SURFACE=0` left the
 * test green, because the comment above it names the variable too.
 */
function withoutComments(path: string): string {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n');
}

function bashExecutable(): string {
  if (process.platform !== 'win32') return 'bash';
  const candidates = [
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files\\Git\\usr\\bin\\bash.exe',
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? 'bash';
}

describe('deploying the dev worker', () => {
  it('is valid Bash', () => {
    const result = spawnSync(bashExecutable(), ['-n', workerScript.replaceAll('\\', '/')], {
      encoding: 'utf8',
    });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });

  it('targets its own checkout, service, port and database', () => {
    const source = readFileSync(workerScript, 'utf8');
    expect(source).toContain('REPO_DIR="${REPO_DIR:-/srv/tailfin-dev-worker}"');
    expect(source).toContain('SERVICE="${SERVICE:-tailfin-dev-worker}"');
    expect(source).toContain('HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:3100/healthz}"');
    expect(source).toContain('MIGRATION_DATABASE="${MIGRATION_DATABASE:-tailfin_dev}"');
  });

  it('is executable, like every other deploy script', () => {
    // Git's mode, not the filesystem's: the working tree on Windows does not
    // carry the bit, so `statSync` would pass here and fail on the box. This one
    // did — the first deploy attempt died with "Permission denied" after the
    // node was otherwise ready.
    const modes = spawnSync(
      'git',
      ['ls-files', '-s', 'deploy/deploy.sh', 'deploy/deploy-dev.sh', 'deploy/deploy-dev-worker.sh'],
      { cwd: repoRoot, encoding: 'utf8' },
    ).stdout.trim();

    for (const line of modes.split('\n')) {
      expect(line.startsWith('100755'), `not executable in git: ${line}`).toBe(true);
    }
  });

  it('does not own migrations', () => {
    // The property that matters most here. Two nodes deploying against one
    // database can both reach the migrator, and the second one's pre-migration
    // backup would describe a schema the first had already started changing.
    expect(readFileSync(workerScript, 'utf8')).toContain('RUNS_MIGRATIONS=0');
  });

  it('serves no public surface, so it runs no browser smoke', () => {
    expect(withoutComments(workerScript)).toContain('export SERVES_PUBLIC_SURFACE=0');
  });

  it('names no post-deploy origin, because aiming the smoke is the bug', () => {
    // This is the regression. The wrapper never set these, so the smoke fell
    // through to deploy.sh's production defaults and a dev worker deploy asserted
    // that the front door served the worker's ref — reaching out to the public
    // site during a dev deploy, and false by construction.
    //
    // The obvious repair is to copy dev web's two lines across, which is why this
    // test asserts their *absence* rather than the fix. The two dev nodes deploy
    // separately and sit at different commits routinely, and the expected commit
    // is always this node's, so a dev-web origin fails whenever web has not been
    // deployed to the same ref yet.
    const source = withoutComments(workerScript);
    expect(source).not.toContain('POST_DEPLOY_BASE_URL');
    expect(source).not.toContain('POST_DEPLOY_EXPECTED_ENVIRONMENT');
  });
});

describe('the post-deploy browser smoke', () => {
  const source = readFileSync(deployScript, 'utf8');

  it('runs by default, so every web deploy is the deploy it was', () => {
    expect(source).toContain('SERVES_PUBLIC_SURFACE="${SERVES_PUBLIC_SURFACE:-1}"');
  });

  it('is skipped rather than aimed elsewhere on a node without one', () => {
    // Structural, because ordering alone is not the property. A guard that opens
    // and closes above an untouched smoke call satisfies "guard comes first" and
    // changes nothing on the box — mutation testing walked straight through the
    // first version of this test. So: the smoke must fall inside the conditional,
    // with nothing closing it in between, and the skip must be its else branch.
    const lines = source.split('\n');
    const guard = lines.findIndex((line) =>
      line.startsWith('if [ "${SERVES_PUBLIC_SURFACE}" = \'1\' ]; then'),
    );
    const smoke = lines.findIndex((line) => line.includes('pnpm test:post-deploy'));
    const skip = lines.findIndex((line) => line.includes('skipping the post-deploy browser smoke'));

    expect(guard).toBeGreaterThan(-1);
    expect(smoke).toBeGreaterThan(guard);
    expect(skip).toBeGreaterThan(smoke);
    // Nothing at the guard's own indentation closes it before the smoke runs.
    expect(
      lines.slice(guard + 1, smoke).filter((line) => line === 'fi' || line === 'else'),
    ).toEqual([]);
    // And the skip really is this guard's alternative, not a later block.
    expect(lines.slice(smoke, skip).filter((line) => line === 'else')).toEqual(['else']);
  });

  it('still proves the health endpoint answered when it skips', () => {
    // A step that disappears silently reads as a step somebody forgot. The skip
    // says which endpoint was actually proved instead.
    expect(source).toContain('${HEALTH_URL} answered for ${NEXT}');
  });

  it('keeps production as the default origin it was', () => {
    // The defaults are correct *for deploy.sh*, which is the production deploy.
    // The bug was a wrapper inheriting them, not the defaults themselves.
    expect(source).toContain(
      'POST_DEPLOY_BASE_URL="${POST_DEPLOY_BASE_URL:-https://tailfinsim.com}"',
    );
    expect(source).toContain(
      'POST_DEPLOY_EXPECTED_ENVIRONMENT="${POST_DEPLOY_EXPECTED_ENVIRONMENT:-production}"',
    );
  });
});

describe('migration ownership', () => {
  const source = readFileSync(deployScript, 'utf8');

  it('defaults to owning them, so every existing caller is unchanged', () => {
    expect(source).toContain('RUNS_MIGRATIONS="${RUNS_MIGRATIONS:-1}"');
  });

  it('still proves which database a non-owning node is pointed at', () => {
    // Skipping the apply must not skip the preflight: a worker whose `.env`
    // pointed at production would otherwise deploy quietly and start draining
    // the wrong world.
    const preflight = source.indexOf('configured database is ${ACTUAL_DATABASE}');
    const ownership = source.indexOf('if [ "${RUNS_MIGRATIONS}" != \'1\' ]');
    expect(preflight).toBeGreaterThan(0);
    expect(ownership).toBeGreaterThan(preflight);
  });

  it('refuses to deploy a non-owning node ahead of a pending schema change', () => {
    // The ordering rule, enforced rather than documented: worker code that
    // expects a column the database does not have yet must not start.
    expect(source).toContain('does not own them — deploy the web node first');
  });
});

describe('the worker unit', () => {
  const source = readFileSync(workerUnit, 'utf8');

  it('runs the worker entry point, not the web one', () => {
    expect(source).toContain('ExecStart=/usr/bin/node dist/worker.js');
    expect(source).toContain('WorkingDirectory=/srv/tailfin-dev-worker/packages/server');
  });

  it('cannot outlive the tunnel it depends on', () => {
    // `Requires=`, not `Wants=`. Without the tunnel this process can reach no
    // database at all, and a worker logging connection failures at 1 Hz is worse
    // than one systemd has stopped.
    expect(source).toContain('Requires=tailfin-db-tunnel.service');
    expect(source).toContain('After=network-online.target tailfin-db-tunnel.service');
  });

  it('gives shutdown longer than the worker gives itself', () => {
    // `worker.ts` waits for a tick already inside a transaction, then gives up at
    // 15s. systemd reaching for SIGKILL first would abort the event mid-flight,
    // which is the one thing the ordered shutdown exists to prevent.
    expect(source).toContain('KillSignal=SIGTERM');
    expect(source).toContain('TimeoutStopSec=30s');
  });

  it('is bounded before the first incident rather than after it', () => {
    expect(source).toContain('CPUQuota=');
    expect(source).toContain('MemoryMax=');
  });

  it('can reach nothing but loopback', () => {
    // Belt and braces over `worker.ts` refusing to read HOST. The worker's only
    // correspondent is the tunnel on 127.0.0.1, so denying everything else means
    // a mistake in the environment file cannot publish the health endpoint or
    // let the engine talk to anything unexpected.
    expect(source).toContain('IPAddressAllow=localhost');
    expect(source).toContain('IPAddressDeny=any');
  });
});

describe('the database tunnel', () => {
  const source = readFileSync(tunnelUnit, 'utf8');

  it('binds its forward to loopback only', () => {
    // `-L 5433:...` without the address binds every interface, which would
    // republish the database onto the public segment through the very door this
    // unit exists to avoid.
    expect(source).toContain('-L 127.0.0.1:5433:127.0.0.1:5432');
  });

  it('fails rather than pretending to be up when the bind fails', () => {
    // Without this, ssh exits zero, systemd calls the unit started, and the
    // worker connects to nothing. A tunnel that is "up" and forwards nowhere is
    // worse than one that is down, because only the second is visible.
    expect(source).toContain('ExitOnForwardFailure=yes');
  });

  it('notices a dead session instead of believing it is still connected', () => {
    expect(source).toContain('ServerAliveInterval=15');
    expect(source).toContain('ServerAliveCountMax=3');
    expect(source).toContain('Restart=always');
  });

  it('verifies the host it connects to, and offers only its own key', () => {
    // A tunnel carrying database credentials must not accept a new host key on
    // trust; the known_hosts file is provisioned with the real one.
    expect(source).toContain('StrictHostKeyChecking=yes');
    expect(source).toContain('UserKnownHostsFile=/etc/tailfin/tunnel_known_hosts');
    expect(source).toContain('IdentitiesOnly=yes');
    expect(source).toContain('BatchMode=yes');
  });

  it('runs no remote command and asks for no terminal', () => {
    expect(source).toContain('/usr/bin/ssh -NT');
  });

  it('connects as the dedicated tunnel account, not as a deploy user', () => {
    // `tailfin-tunnel` on the database host exists only for this, and its
    // authorized_keys entry restricts it to forwarding 127.0.0.1:5432. Connecting
    // as `tailfin` or `ubuntu` would hand the worker node a shell on the box
    // that serves production.
    expect(source).toContain('tailfin-tunnel@');
    expect(source).not.toContain('ubuntu@');
  });
});
