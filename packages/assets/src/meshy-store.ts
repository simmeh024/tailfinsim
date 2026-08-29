import { execFileSync } from 'node:child_process';
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { canonicalJson, sha256 } from './canonical';
import { type MeshyGenerationSpec, type MeshyOperationId } from './meshy';
import {
  MeshyRunState,
  assertMeshyRunTransition,
  createMeshyRun,
  observeMeshyRunTask,
  reserveMeshyRunOperation,
  selectMeshyRunCandidate,
  type MeshyTaskReceipt,
} from './meshy-run';

const APPLICATION_ID = 0x54464d59;
const MAX_SNAPSHOTS = 256;
const MAX_PAYLOAD_BYTES = 65_536;
const STORE_ERROR = 'Meshy run store refused; inspect the local ledger before continuing.';

/** Git worktrees share this one first-run slot. There is deliberately no CLI root/run override. */
export function meshyRunDatabasePath(repository: string): string {
  try {
    const common = execFileSync(
      'git',
      ['rev-parse', '--path-format=absolute', '--git-common-dir'],
      {
        cwd: repository,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    ).trim();
    return join(realpathSync(common), 'tailfin-aircraft-factory', 'a320neo-first-run.sqlite');
  } catch {
    throw new Error('Cannot resolve the shared repository run store.');
  }
}

function checkDatabaseFile(path: string): void {
  const file = lstatSync(path);
  if (!file.isFile() || file.isSymbolicLink() || file.nlink !== 1 || file.size > 32 * 1024 * 1024)
    throw new Error(STORE_ERROR);
  // Refuse redirection through an immediate state-directory symlink/junction as well.
  if (realpathSync(dirname(path)) !== resolve(dirname(path))) throw new Error(STORE_ERROR);
}

function readHistory(db: DatabaseSync): { sequence: number; digest: string; state: MeshyRunState } {
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
  let current: { sequence: number; digest: string; state: MeshyRunState } | undefined;
  for (const row of rows) {
    if (
      typeof row.payload !== 'string' ||
      typeof row.digest !== 'string' ||
      row.sequence !== (current?.sequence ?? 0) + 1 ||
      row.previous !== (current?.digest ?? null)
    )
      throw new Error(STORE_ERROR);
    const state = MeshyRunState.parse(JSON.parse(row.payload) as unknown);
    const expected = sha256(
      canonicalJson({ sequence: row.sequence, previous: row.previous, state }),
    );
    if (row.payload !== canonicalJson(state) || row.digest !== expected)
      throw new Error(STORE_ERROR);
    if (current) assertMeshyRunTransition(current.state, state);
    else if (
      state.budget.entries.length ||
      state.requests.length ||
      state.tasks.length ||
      state.selection
    )
      throw new Error(STORE_ERROR);
    current = { sequence: row.sequence, digest: row.digest, state };
  }
  if (!current) throw new Error(STORE_ERROR);
  return current;
}

function insertSnapshot(
  db: DatabaseSync,
  sequence: number,
  previous: string | null,
  state: MeshyRunState,
): void {
  const parsed = MeshyRunState.parse(state);
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

/**
 * Transactions contain only local validation and INSERTs, never a network call.
 * A future POST may run only after reserve() returns from COMMIT. A crash between
 * that COMMIT and a task receipt leaves an uncertain reservation, never a retry slot.
 */
export class MeshyRunStore {
  constructor(private readonly path: string) {}

  initialize(approval: unknown, spec: MeshyGenerationSpec): MeshyRunState {
    const state = createMeshyRun(approval, spec);
    try {
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
      if (realpathSync(dirname(this.path)) !== resolve(dirname(this.path)))
        throw new Error(STORE_ERROR);
      // Exclusive creation: never replace/reinitialize a previous run, even with identical approval.
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
      // Failed initialization can leave an empty file. Do not silently retry over it.
      throw new Error(STORE_ERROR);
    }
  }

  read(): MeshyRunState {
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
    spec: MeshyGenerationSpec,
    maxCredits: number,
    operationId: MeshyOperationId,
    requestSha256: string,
  ): MeshyRunState {
    return this.update((state) =>
      reserveMeshyRunOperation(state, spec, maxCredits, operationId, requestSha256),
    );
  }

  /** Paid candidates are sequential, including terminal charge reconciliation. No state format change. */
  reserveCandidate(
    spec: MeshyGenerationSpec,
    maxCredits: number,
    operationId: MeshyOperationId,
    requestSha256: string,
  ): MeshyRunState {
    return this.update((state) => {
      assertMeshyCandidateSequence(state, operationId);
      return reserveMeshyRunOperation(state, spec, maxCredits, operationId, requestSha256);
    });
  }

  observe(task: MeshyTaskReceipt): MeshyRunState {
    return this.update((state) => observeMeshyRunTask(state, task));
  }

  /** Polls may race; repeated status/charge observations retain the first durable timestamp. */
  observeProgress(task: MeshyTaskReceipt): MeshyRunState {
    return this.update((state) => {
      const before = state.tasks.find((entry) => entry.operationId === task.operationId);
      if (
        before?.taskId === task.taskId &&
        before.status === task.status &&
        before.consumedCredits === task.consumedCredits
      )
        return state;
      return observeMeshyRunTask(state, task);
    });
  }

  select(taskId: string, evidenceSha256: string): MeshyRunState {
    return this.update((state) => selectMeshyRunCandidate(state, taskId, evidenceSha256));
  }

  private update(reducer: (state: MeshyRunState) => MeshyRunState): MeshyRunState {
    let result: MeshyRunState | undefined;
    this.transaction((db) => {
      const previous = readHistory(db);
      result = reducer(previous.state);
      assertMeshyRunTransition(previous.state, result);
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
      // EXTRA also syncs DELETE-journal directory changes; FULL alone can lose
      // the last commit after power loss on some filesystems (SQLite's contract).
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

export function assertMeshyCandidateSequence(state: MeshyRunState, operationId: string): void {
  if (
    state.requests.length >= 4 ||
    operationId !== `candidate-${String(state.requests.length + 1)}` ||
    state.requests.some(
      (request) =>
        !state.tasks.some(
          (task) =>
            task.operationId === request.operationId &&
            ['SUCCEEDED', 'FAILED', 'CANCELED'].includes(task.status) &&
            task.consumedCredits !== null,
        ),
    )
  )
    throw new Error(
      'Candidate sequence requires reconciled prior tasks and an unused next operation.',
    );
}
