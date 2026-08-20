import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const repoRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..');
const script = resolve(repoRoot, 'deploy', 'restore-rehearsal.sh');
const backupScript = resolve(repoRoot, 'deploy', 'backup.sh');

function bashExecutable(): string {
  if (process.platform !== 'win32') return 'bash';
  const candidates = [
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files\\Git\\usr\\bin\\bash.exe',
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? 'bash';
}

function run(
  args: string[] = [],
  env: Record<string, string | undefined> = {},
): ReturnType<typeof spawnSync> {
  return spawnSync(bashExecutable(), [script.replaceAll('\\', '/'), ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

describe('the restore rehearsal command', () => {
  it('is valid Bash', () => {
    const result = spawnSync(bashExecutable(), ['-n', script.replaceAll('\\', '/')], {
      encoding: 'utf8',
    });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });

  it('documents its safe inputs without requiring server access', () => {
    const result = run(['--help']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('must end in _test');
    expect(result.stdout).toContain('never connects to a live Tailfin database');
  });

  it.each(['tailfin', 'tailfin_dev', 'restore', 'restore_ci', 'restore_test;dropdb tailfin'])(
    'refuses the unsafe target %s before checking privileges or tools',
    (target) => {
      const result = run([], { RESTORE_DATABASE: target });
      expect(result.status).toBe(2);
      expect(result.stderr).toContain('RESTORE_DATABASE must end in _test');
    },
  );

  it('refuses shell syntax in the remote backup prefix', () => {
    const result = run([], {
      RESTORE_DATABASE: 'restore_test',
      RESTORE_SOURCE_DATABASE: 'tailfin; touch /tmp/not-allowed',
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('not a safe backup prefix');
  });

  it('rechecks the _test suffix immediately beside dropdb', () => {
    const source = readFileSync(script, 'utf8');
    const cleanupGuard = source.indexOf(
      `[[ ! "\${TARGET_DB}" =~ ^[A-Za-z0-9_]+_test$ ]]`,
      source.indexOf('drop_scratch_database()'),
    );
    const destructiveBoundary = source.indexOf('runuser -u postgres -- dropdb', cleanupGuard);
    expect(cleanupGuard).toBeGreaterThan(0);
    expect(destructiveBoundary).toBeGreaterThan(cleanupGuard);
  });

  it('requires remote checksum sidecars instead of ignoring their upload failure', () => {
    const source = readFileSync(backupScript, 'utf8');
    expect(source).toContain('${db}:checksum-upload-failed');
    expect(source).toContain('${db}:monthly-checksum-upload-failed');
    expect(source).not.toMatch(/s3 put "\$\{out\}\.sha256"[^\n]*\|\| true/);
  });
});
