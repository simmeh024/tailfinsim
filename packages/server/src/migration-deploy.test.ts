import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const repoRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..');
const deployScript = resolve(repoRoot, 'deploy', 'deploy.sh');
const devScript = resolve(repoRoot, 'deploy', 'deploy-dev.sh');
const backupScript = resolve(repoRoot, 'deploy', 'backup.sh');
const migrationBackup = resolve(repoRoot, 'deploy', 'migration-backup.sh');
const migrationBackupUnit = resolve(repoRoot, 'deploy', 'tailfin-migration-backup@.service');

function bashExecutable(): string {
  if (process.platform !== 'win32') return 'bash';
  const candidates = [
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files\\Git\\usr\\bin\\bash.exe',
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? 'bash';
}

describe('migration-safe deployment', () => {
  it.each([deployScript, devScript, backupScript, migrationBackup])(
    '%s is valid Bash',
    (script) => {
      const result = spawnSync(bashExecutable(), ['-n', script.replaceAll('\\', '/')], {
        encoding: 'utf8',
      });
      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
    },
  );

  it('takes a verified backup only when migrations are pending', () => {
    const source = readFileSync(deployScript, 'utf8');
    const pending = source.indexOf('PENDING_MIGRATIONS=');
    const backup = source.indexOf('systemctl start "${BACKUP_UNIT}"');
    const migrate = source.indexOf('node dist/migrate.js --apply');
    expect(pending).toBeGreaterThan(0);
    expect(backup).toBeGreaterThan(pending);
    expect(migrate).toBeGreaterThan(backup);
    expect(source).toContain('configured database is ${ACTUAL_DATABASE}');
  });

  it('maps every migration state to an explicit deploy failure', () => {
    const source = readFileSync(deployScript, 'utf8');
    expect(source).toContain('DATABASE ROLLED BACK');
    expect(source).toContain('DATABASE REPORTS ALL PENDING MIGRATIONS APPLIED');
    expect(source).toContain('DATABASE STATE UNKNOWN/PARTIAL');
    expect(source).toContain('DATABASE NOT TOUCHED');
  });

  it('binds dev to its own backup target', () => {
    expect(readFileSync(devScript, 'utf8')).toContain(
      'MIGRATION_DATABASE="${MIGRATION_DATABASE:-tailfin_dev}"',
    );
  });

  it.each(['production', 'tailfin_test', 'tailfin;dropdb tailfin'])(
    'refuses the unsafe migration backup target %s before invoking backup tooling',
    (database) => {
      const result = spawnSync(
        bashExecutable(),
        [migrationBackup.replaceAll('\\', '/'), database],
        { encoding: 'utf8', env: process.env },
      );
      expect(result.status).toBe(2);
      expect(result.stderr).toContain('must be tailfin or tailfin_dev');
    },
  );

  it('records the exact local backup artifact in status', () => {
    const source = readFileSync(backupScript, 'utf8');
    expect(source).toContain('${db}:local-only:$(basename "${out}")');
    expect(source).toContain('KEEP_LOCAL');
    expect(source).toContain("awk '/^[0-9]/{count++} END{print count+0}'");
    expect(source).not.toContain("grep -c '^[0-9]'");
    expect(readFileSync(migrationBackup, 'utf8')).toContain('REQUIRE_DATABASES=1');
  });

  it('runs the fixed backup helper as postgres with only its two write paths', () => {
    const source = readFileSync(migrationBackupUnit, 'utf8');
    expect(source).toContain('User=postgres');
    expect(source).toContain('ExecStart=/usr/local/sbin/tailfin-migration-backup %i');
    expect(source).toContain('ProtectSystem=strict');
    expect(source).toContain('ReadWritePaths=/var/backups/tailfin /var/lib/tailfin');
  });
});
