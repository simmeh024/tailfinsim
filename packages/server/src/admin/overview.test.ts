import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { alertsFor, readBackupStatus, type OverviewCounts } from './overview';

/**
 * What the console decides to worry about (M1A-07).
 *
 * `alertsFor` is a pure function, so the thresholds that decide whether a real
 * failure becomes visible can be tested without a database or a filesystem —
 * which matters, because those thresholds are the whole mechanism. A backup that
 * silently stops being reported is the failure this page exists to prevent.
 */

const HEALTHY: OverviewCounts = {
  players: 12,
  worlds: 1,
  admins: 2,
  airports: 85_915,
  auditEntries: 40,
};

const NOW = new Date('2026-08-18T18:00:00.000Z');

function codes(counts: OverviewCounts, backup: Parameters<typeof alertsFor>[1]): string[] {
  return alertsFor(counts, backup, NOW).map((alert) => alert.code);
}

const OK_BACKUP = {
  finishedAt: '2026-08-18T03:15:00.000Z',
  result: 'ok' as const,
  uploaded: 2,
  databases: 'tailfin:ok tailfin_dev:ok',
};

describe('alertsFor', () => {
  it('says nothing when nothing is wrong', () => {
    // Silence has to mean silence. A panel that always has something in it is a
    // panel nobody reads, and then the one that mattered is missed.
    expect(codes(HEALTHY, OK_BACKUP)).toEqual([]);
  });

  it('raises an error when the last backup failed', () => {
    expect(codes(HEALTHY, { ...OK_BACKUP, result: 'failed' })).toContain('backup.failed');
  });

  it('raises an error when no backup has happened for over a day', () => {
    // The timer is nightly with up to five minutes of jitter, so past 26 hours a
    // run was missed rather than merely late.
    const stale = { ...OK_BACKUP, finishedAt: '2026-08-17T10:00:00.000Z' };
    expect(codes(HEALTHY, stale)).toContain('backup.stale');
  });

  it('does not cry stale for a backup that is merely last night', () => {
    expect(codes(HEALTHY, OK_BACKUP)).not.toContain('backup.stale');
  });

  it('tolerates a backup exactly at the threshold rather than flapping', () => {
    const at26h = { ...OK_BACKUP, finishedAt: '2026-08-17T16:00:00.000Z' };
    expect(codes(HEALTHY, at26h)).not.toContain('backup.stale');
  });

  it('warns when no backup result has been recorded at all', () => {
    // Distinct from "it failed": this is not knowing, which is its own problem.
    expect(codes(HEALTHY, null)).toContain('backup.unknown');
  });

  it('raises an error when the airport dataset is empty', () => {
    // The specific incident this exists for: dev lost 85,915 airports to a
    // misdirected test run and it went unnoticed for hours.
    expect(codes({ ...HEALTHY, airports: 0 }, OK_BACKUP)).toContain('airports.empty');
  });

  it('mentions a single administrator, because recovery then needs a shell', () => {
    expect(codes({ ...HEALTHY, admins: 1 }, OK_BACKUP)).toContain('admin.single');
    expect(codes({ ...HEALTHY, admins: 2 }, OK_BACKUP)).not.toContain('admin.single');
  });

  it('mentions an instance with no world yet', () => {
    expect(codes({ ...HEALTHY, worlds: 0 }, OK_BACKUP)).toContain('world.none');
  });

  it('reports several problems at once rather than only the first', () => {
    const codesFound = codes({ ...HEALTHY, airports: 0, worlds: 0, admins: 1 }, null);
    expect(codesFound).toContain('backup.unknown');
    expect(codesFound).toContain('airports.empty');
    expect(codesFound).toContain('world.none');
    expect(codesFound).toContain('admin.single');
  });

  it('carries a severity and a detail on everything it raises', () => {
    for (const alert of alertsFor({ ...HEALTHY, airports: 0 }, null, NOW)) {
      expect(['info', 'warning', 'error']).toContain(alert.severity);
      expect(alert.message.length).toBeGreaterThan(0);
      expect(alert.detail).not.toBe('');
    }
  });

  it('does not treat an unparseable timestamp as overdue', () => {
    // A malformed status file must not manufacture an alarm; `backup.unknown`
    // covers not knowing, and a NaN age is not evidence of anything.
    const broken = { ...OK_BACKUP, finishedAt: 'not a date' };
    expect(codes(HEALTHY, broken)).not.toContain('backup.stale');
  });
});

describe('readBackupStatus', () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'tailfin-status-'));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('reads a status file the backup script wrote', async () => {
    const path = join(dir, 'good.json');
    await writeFile(path, JSON.stringify(OK_BACKUP));
    expect(await readBackupStatus(path)).toEqual(OK_BACKUP);
  });

  it('answers null for a file that is not there', async () => {
    // The ordinary local case. Not an error, and not a reason to fail the page.
    expect(await readBackupStatus(join(dir, 'absent.json'))).toBeNull();
  });

  it('answers null for a file that is not JSON', async () => {
    const path = join(dir, 'garbage.json');
    await writeFile(path, 'not json at all');
    expect(await readBackupStatus(path)).toBeNull();
  });

  it('answers null for JSON of the wrong shape', async () => {
    // A console that will not load because the backup file is odd is a console
    // you cannot use to find out why.
    const path = join(dir, 'wrong.json');
    await writeFile(path, JSON.stringify({ finishedAt: 5, result: 'maybe' }));
    expect(await readBackupStatus(path)).toBeNull();
  });
});
