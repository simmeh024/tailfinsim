import { execFileSync } from 'node:child_process';
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { z } from 'zod';

import { canonicalJson, sha256 } from './canonical';
import {
  MESHY_ARCHIVE_RECOVERY_TOTAL_CREDIT_LIMIT,
  MESHY_ARCHIVE_RETEXTURE_CREDITS,
} from './meshy-archive-recovery';
import { MeshySha256 } from './meshy-run';

const APPLICATION_ID = 0x54464152;
const MAX_SNAPSHOTS = 16;
const MAX_PAYLOAD_BYTES = 16_384;
const STORE_ERROR = 'Archive recovery ledger refused; inspect the local ledger before continuing.';
const Timestamp = z.iso.datetime();
const Credits = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

export const MeshyArchiveRecoveryApproval = z
  .object({
    format: z.literal('tailfin-meshy-archive-recovery-approval'),
    formatVersion: z.literal(1),
    runId: z.literal('a320neo-archive-retexture-recovery-v1'),
    authority: z.literal('explicit-user-confirmation'),
    recordedAt: Timestamp,
    confirmationSha256: MeshySha256,
    originalRunApprovalSha256: MeshySha256,
    originalRetainedExposure: Credits,
    totalCreditCeiling: z.literal(MESHY_ARCHIVE_RECOVERY_TOTAL_CREDIT_LIMIT),
    recoveryReservation: z.literal(MESHY_ARCHIVE_RETEXTURE_CREDITS),
    source: z
      .object({
        taskId: z.uuid(),
        exportSha256: MeshySha256,
        exportBytes: z
          .number()
          .int()
          .positive()
          .max(256 * 1024 * 1024),
      })
      .strict(),
    scope: z.literal('one-archive-backed-4k-pbr-retexture-only'),
    productionPublicationApproved: z.literal(false),
  })
  .strict()
  .refine(
    (approval) =>
      approval.originalRetainedExposure + approval.recoveryReservation <=
      approval.totalCreditCeiling,
    'Aggregate Meshy test ceiling would be exceeded.',
  );
export type MeshyArchiveRecoveryApproval = z.infer<typeof MeshyArchiveRecoveryApproval>;

export const MeshyArchiveRecoveryTask = z
  .object({
    taskId: z.uuid(),
    status: z.enum(['PENDING', 'IN_PROGRESS', 'SUCCEEDED', 'FAILED', 'CANCELED']),
    consumedCredits: Credits.nullable(),
    observedAt: Timestamp,
  })
  .strict()
  .refine(
    (task) =>
      ['SUCCEEDED', 'FAILED', 'CANCELED'].includes(task.status) || task.consumedCredits === null,
    'only terminal tasks have confirmed charges',
  );
export type MeshyArchiveRecoveryTask = z.infer<typeof MeshyArchiveRecoveryTask>;

export const MeshyArchiveRecoveryState = z
  .object({
    format: z.literal('tailfin-meshy-archive-recovery-state'),
    formatVersion: z.literal(1),
    approval: MeshyArchiveRecoveryApproval,
    reservation: z
      .object({
        requestBodySha256: MeshySha256,
        sourceSha256: MeshySha256,
        proofSha256: MeshySha256,
        reservedCredits: z.literal(MESHY_ARCHIVE_RETEXTURE_CREDITS),
        reservedAt: Timestamp,
      })
      .strict()
      .nullable(),
    task: MeshyArchiveRecoveryTask.nullable(),
  })
  .strict()
  .superRefine((state, context) => {
    if (state.task !== null && state.reservation === null)
      context.addIssue({ code: 'custom', message: 'task has no durable reservation' });
    if (state.reservation && state.reservation.sourceSha256 !== state.approval.source.exportSha256)
      context.addIssue({ code: 'custom', message: 'reservation source changed' });
  });
export type MeshyArchiveRecoveryState = z.infer<typeof MeshyArchiveRecoveryState>;

function createState(approvalInput: unknown): MeshyArchiveRecoveryState {
  const approval = MeshyArchiveRecoveryApproval.parse(approvalInput);
  return MeshyArchiveRecoveryState.parse({
    format: 'tailfin-meshy-archive-recovery-state',
    formatVersion: 1,
    approval,
    reservation: null,
    task: null,
  });
}

/** The recovery ledger shares the repository's private git common directory, never a CLI path. */
export function meshyArchiveRecoveryDatabasePath(repository: string): string {
  try {
    const common = execFileSync(
      'git',
      ['rev-parse', '--path-format=absolute', '--git-common-dir'],
      { cwd: repository, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim();
    return join(
      realpathSync(common),
      'tailfin-aircraft-factory',
      'a320neo-archive-retexture-recovery-v1.sqlite',
    );
  } catch {
    throw new Error('Cannot resolve the shared archive recovery store.');
  }
}

function checkDatabaseFile(path: string): void {
  const file = lstatSync(path);
  if (!file.isFile() || file.isSymbolicLink() || file.nlink !== 1 || file.size > 8 * 1024 * 1024)
    throw new Error(STORE_ERROR);
  if (realpathSync(dirname(path)) !== resolve(dirname(path))) throw new Error(STORE_ERROR);
}

function assertTaskProgress(
  before: MeshyArchiveRecoveryTask,
  after: MeshyArchiveRecoveryTask,
): void {
  if (
    before.taskId !== after.taskId ||
    Date.parse(before.observedAt) > Date.parse(after.observedAt) ||
    (before.consumedCredits !== null && before.consumedCredits !== after.consumedCredits) ||
    (['SUCCEEDED', 'FAILED', 'CANCELED'].includes(before.status) &&
      before.status !== after.status) ||
    (before.status === 'IN_PROGRESS' && after.status === 'PENDING')
  )
    throw new Error('Task observation regressed or changed identity.');
}

export function assertMeshyArchiveRecoveryTransition(
  before: MeshyArchiveRecoveryState,
  after: MeshyArchiveRecoveryState,
): void {
  if (canonicalJson(before.approval) !== canonicalJson(after.approval))
    throw new Error('Recovery approval changed.');
  if (before.reservation && canonicalJson(before.reservation) !== canonicalJson(after.reservation))
    throw new Error('Recovery reservation changed.');
  if (before.task) {
    if (!after.task) throw new Error('Recovery task changed.');
    assertTaskProgress(before.task, after.task);
  }
}

function readHistory(db: DatabaseSync): {
  sequence: number;
  digest: string;
  state: MeshyArchiveRecoveryState;
} {
  if (
    db.prepare('PRAGMA application_id').get()?.application_id !== APPLICATION_ID ||
    db.prepare('PRAGMA user_version').get()?.user_version !== 1
  )
    throw new Error(STORE_ERROR);
  const sizes = db
    .prepare('SELECT sequence, length(payload) AS size FROM snapshots ORDER BY sequence LIMIT ?')
    .all(MAX_SNAPSHOTS + 1);
  if (
    sizes.length === 0 ||
    sizes.length > MAX_SNAPSHOTS ||
    sizes.some((row) => typeof row.size !== 'number' || row.size > MAX_PAYLOAD_BYTES)
  )
    throw new Error(STORE_ERROR);
  const rows = db
    .prepare('SELECT sequence, previous, digest, payload FROM snapshots ORDER BY sequence LIMIT ?')
    .all(MAX_SNAPSHOTS);
  let current: { sequence: number; digest: string; state: MeshyArchiveRecoveryState } | undefined;
  for (const row of rows) {
    if (
      typeof row.payload !== 'string' ||
      typeof row.digest !== 'string' ||
      row.sequence !== (current?.sequence ?? 0) + 1 ||
      row.previous !== (current?.digest ?? null)
    )
      throw new Error(STORE_ERROR);
    const state = MeshyArchiveRecoveryState.parse(JSON.parse(row.payload) as unknown);
    const digest = sha256(canonicalJson({ sequence: row.sequence, previous: row.previous, state }));
    if (row.payload !== canonicalJson(state) || row.digest !== digest) throw new Error(STORE_ERROR);
    if (current) assertMeshyArchiveRecoveryTransition(current.state, state);
    else if (state.reservation || state.task) throw new Error(STORE_ERROR);
    current = { sequence: row.sequence, digest: row.digest, state };
  }
  if (!current) throw new Error(STORE_ERROR);
  return current;
}

function insertSnapshot(
  db: DatabaseSync,
  sequence: number,
  previous: string | null,
  state: MeshyArchiveRecoveryState,
): void {
  const parsed = MeshyArchiveRecoveryState.parse(state);
  const payload = canonicalJson(parsed);
  if (sequence > MAX_SNAPSHOTS || Buffer.byteLength(payload) > MAX_PAYLOAD_BYTES)
    throw new Error(STORE_ERROR);
  const digest = sha256(canonicalJson({ sequence, previous, state: parsed }));
  db.prepare('INSERT INTO snapshots (sequence, previous, digest, payload) VALUES (?, ?, ?, ?)').run(
    sequence,
    previous,
    digest,
    payload,
  );
}

/** Single-operation write-ahead ledger for archive-backed retexture recovery. */
export class MeshyArchiveRecoveryStore {
  constructor(private readonly path: string) {}

  initialize(approval: unknown): MeshyArchiveRecoveryState {
    const state = createState(approval);
    try {
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
      if (realpathSync(dirname(this.path)) !== resolve(dirname(this.path)))
        throw new Error(STORE_ERROR);
      closeSync(openSync(this.path, 'wx', 0o600));
      this.transaction((db) => {
        db.exec(`
          PRAGMA application_id = ${String(APPLICATION_ID)};
          PRAGMA user_version = 1;
          CREATE TABLE snapshots (
            sequence INTEGER PRIMARY KEY CHECK(sequence > 0),
            previous TEXT,
            digest TEXT NOT NULL CHECK(length(digest) = 64),
            payload TEXT NOT NULL
          ) STRICT;
          CREATE TRIGGER snapshots_no_update BEFORE UPDATE ON snapshots
            BEGIN SELECT RAISE(ABORT, 'immutable snapshot'); END;
          CREATE TRIGGER snapshots_no_delete BEFORE DELETE ON snapshots
            BEGIN SELECT RAISE(ABORT, 'immutable snapshot'); END;
        `);
        insertSnapshot(db, 1, null, state);
      });
      return state;
    } catch {
      throw new Error(STORE_ERROR);
    }
  }

  read(): MeshyArchiveRecoveryState {
    let db: DatabaseSync | undefined;
    try {
      checkDatabaseFile(this.path);
      db = new DatabaseSync(this.path, { readOnly: true, timeout: 1_000 });
      db.exec('PRAGMA trusted_schema = OFF; BEGIN');
      const { state } = readHistory(db);
      db.exec('COMMIT');
      return state;
    } catch {
      throw new Error(STORE_ERROR);
    } finally {
      db?.close();
    }
  }

  reserve(
    requestBodySha256: string,
    sourceSha256: string,
    proofSha256: string,
    reservedAt: string,
  ): MeshyArchiveRecoveryState {
    return this.update((state) => {
      if (state.reservation)
        throw new Error('Recovery operation already reserved; reconcile it instead.');
      return MeshyArchiveRecoveryState.parse({
        ...state,
        reservation: {
          requestBodySha256: MeshySha256.parse(requestBodySha256),
          sourceSha256: MeshySha256.parse(sourceSha256),
          proofSha256: MeshySha256.parse(proofSha256),
          reservedCredits: MESHY_ARCHIVE_RETEXTURE_CREDITS,
          reservedAt: Timestamp.parse(reservedAt),
        },
      });
    });
  }

  observe(taskInput: unknown): MeshyArchiveRecoveryState {
    const task = MeshyArchiveRecoveryTask.parse(taskInput);
    return this.update((state) => {
      if (!state.reservation) throw new Error('Task has no durable reservation.');
      if (state.task) assertTaskProgress(state.task, task);
      return MeshyArchiveRecoveryState.parse({ ...state, task });
    });
  }

  private update(
    reducer: (state: MeshyArchiveRecoveryState) => MeshyArchiveRecoveryState,
  ): MeshyArchiveRecoveryState {
    let result: MeshyArchiveRecoveryState | undefined;
    this.transaction((db) => {
      const previous = readHistory(db);
      result = reducer(previous.state);
      assertMeshyArchiveRecoveryTransition(previous.state, result);
      if (canonicalJson(result) === canonicalJson(previous.state)) return;
      insertSnapshot(db, previous.sequence + 1, previous.digest, result);
    });
    if (!result) throw new Error(STORE_ERROR);
    return result;
  }

  private transaction(work: (db: DatabaseSync) => void): void {
    let db: DatabaseSync | undefined;
    try {
      if (!existsSync(this.path)) throw new Error(STORE_ERROR);
      checkDatabaseFile(this.path);
      db = new DatabaseSync(this.path, { timeout: 1_000 });
      db.exec(
        'PRAGMA trusted_schema = OFF; PRAGMA journal_mode = DELETE; PRAGMA synchronous = EXTRA',
      );
      if (
        db.prepare('PRAGMA synchronous').get()?.synchronous !== 3 ||
        db.prepare('PRAGMA journal_mode').get()?.journal_mode !== 'delete' ||
        db.prepare('PRAGMA trusted_schema').get()?.trusted_schema !== 0
      )
        throw new Error(STORE_ERROR);
      db.exec('BEGIN IMMEDIATE');
      work(db);
      db.exec('COMMIT');
    } catch {
      if (db?.isTransaction) db.exec('ROLLBACK');
      throw new Error(STORE_ERROR);
    } finally {
      db?.close();
    }
  }
}
