import { count, desc, eq, inArray } from 'drizzle-orm';

import {
  AdminCreateEconomyConfigRequest,
  type AdminEconomyConfigChange,
  type AdminEconomyConfigDetailResponse,
  type AdminEconomyConfigSummary,
  AdminPinEconomyConfigRequest,
  canonicalEconomyJson,
  diffEconomyConfig,
  type EconomyConfig as EconomyConfigContract,
  type EconomyConfigChange,
} from '@tailfin/shared';

import { writeAudit } from '../admin/audit';
import { type Actor } from '../admin/grants';
import { type Database } from '../db/client';
import { economyConfig, world, worldEvent } from '../db/schema';

import { defineEconomyConfig, economyChecksum } from './config';
import { clearEconomyConfigCache, loadEconomyConfig } from './loader';

/**
 * Creating an economy version, and pointing a world at one (M3-11, §22.3).
 *
 * Two separate acts, separately audited, and the separation is the safety rail.
 * Writing a new set of coefficients changes nothing at all until a world is
 * pinned to them — so a retune can be prepared, diffed and reviewed while every
 * world carries on running the numbers it was already running. §22.3's
 * *"sandbox → canary world → production, never straight to production"* is that
 * separation used deliberately: pin the canary world first.
 *
 * Rollback is the same act pointed backwards. Versions are immutable and never
 * deleted, so the previous one is always still there to be pinned again.
 */

/**
 * The two operations refuse for different reasons, and the split is load-bearing
 * rather than tidiness: each route maps its own codes onto HTTP statuses, and a
 * shared code list would let a status table go stale without the compiler
 * noticing — `Record<AllCodes, number>` type-checks even when a code has moved
 * to a route that cannot produce it.
 */
export type CreateEconomyRefusalCode =
  'invalid_request' | 'invalid_payload' | 'version_exists' | 'unknown_parent';

export type PinEconomyRefusalCode =
  | 'invalid_request'
  | 'unknown_version'
  | 'world_not_found'
  | 'world_archived'
  | 'version_stale'
  | 'version_unchanged';

export type EconomyRefusalCode = CreateEconomyRefusalCode | PinEconomyRefusalCode;

export interface EconomyRefusal<C extends EconomyRefusalCode = EconomyRefusalCode> {
  ok: false;
  code: C;
  message: string;
  /** Keyed by form field, as `ApiError.fields` carries it. */
  fields: Record<string, string[]>;
}

function refuse<C extends EconomyRefusalCode>(
  code: C,
  field: string,
  reason: string,
  message = reason,
): EconomyRefusal<C> {
  return { ok: false, code, message, fields: { [field]: [reason] } };
}

function fieldErrors(
  issues: readonly { path: PropertyKey[]; message: string }[],
): Record<string, string[]> {
  const fields: Record<string, string[]> = {};
  for (const issue of issues) {
    const field = issue.path.length > 0 ? String(issue.path[0]) : 'form';
    (fields[field] ??= []).push(issue.message);
  }
  return fields;
}

/**
 * The diff, narrowed for the wire.
 *
 * Every leaf in an `EconomyConfig` is a scalar, and the walk descends into
 * arrays by index, so this narrowing never actually drops anything. It is a
 * guard rather than a conversion: if it ever *did* find an object, silently
 * sending `{}` to an admin about to approve a balance change would be worse
 * than saying what happened.
 */
function wireDiff(changes: readonly EconomyConfigChange[]): AdminEconomyConfigChange[] {
  const scalar = (value: unknown): number | string | boolean | null | undefined => {
    if (value === undefined || value === null) return value ?? null;
    if (typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean') {
      return value;
    }
    return JSON.stringify(value);
  };

  return changes.map((change) => ({
    path: change.path,
    ...(change.before === undefined ? {} : { before: scalar(change.before) }),
    ...(change.after === undefined ? {} : { after: scalar(change.after) }),
  }));
}

// ---------------------------------------------------------------------- read

interface EconomyConfigRowShape {
  version: string;
  checksum: string;
  parentVersion: string | null;
  notes: string | null;
  createdAt: Date;
  createdByPlayerId: string | null;
  createdByLabel: string;
}

function summarise(row: EconomyConfigRowShape, worldsPinned: number): AdminEconomyConfigSummary {
  return {
    version: row.version,
    checksum: row.checksum,
    parentVersion: row.parentVersion,
    notes: row.notes,
    createdAt: row.createdAt.toISOString(),
    createdByPlayerId: row.createdByPlayerId,
    createdByLabel: row.createdByLabel,
    worldsPinned,
  };
}

/**
 * How many worlds pin each version.
 *
 * A grouped query and a lookup rather than a correlated subquery in the select
 * list — the pattern `countWorldContents` and `listPlayers` use, for the reason
 * CLAUDE.md records: the correlated form came back empty against real Postgres.
 */
async function worldsPerVersion(db: Database): Promise<Map<string, number>> {
  const rows = await db
    .select({ version: world.economyConfigVersion, worlds: count(world.id) })
    .from(world)
    .groupBy(world.economyConfigVersion);
  return new Map(rows.map((row) => [row.version, row.worlds]));
}

export async function listEconomyConfigVersions(
  db: Database,
): Promise<AdminEconomyConfigSummary[]> {
  const [rows, pinned] = await Promise.all([
    db.select().from(economyConfig).orderBy(desc(economyConfig.createdAt)),
    worldsPerVersion(db),
  ]);
  return rows.map((row) => summarise(row, pinned.get(row.version) ?? 0));
}

/**
 * Two versions, compared directly (M11-02/M11-03, §22.3).
 *
 * `readEconomyConfigVersion` diffs a version against its **parent**, which
 * answers *"what did this change?"*. §22.3's promotion path — sandbox → canary →
 * production — asks a different question: *"what differs between what production
 * is running and what I am about to pin?"*, and those two versions are usually
 * not parent and child. Comparing an arbitrary pair is the one the operator
 * needs before a publish, so it is its own read.
 *
 * Null when either version does not exist; the caller turns that into the same
 * 404 an unknown version already gets. Direction matters: `before` is `from`.
 */
export async function compareEconomyConfigVersions(
  db: Database,
  from: string,
  to: string,
): Promise<AdminEconomyConfigChange[] | null> {
  // Existence is checked against the table rather than inferred from a load
  // failure, so an unknown version is a miss instead of a thrown parse error.
  const rows = await db
    .select({ version: economyConfig.version })
    .from(economyConfig)
    .where(inArray(economyConfig.version, [...new Set([from, to])]));
  const known = new Set(rows.map((row) => row.version));
  if (!known.has(from) || !known.has(to)) return null;

  if (from === to) return [];

  // Through the cache, like the parent diff: comparing repeatedly must not
  // re-parse two immutable payloads every time.
  const [before, after] = await Promise.all([
    loadEconomyConfig(db, from),
    loadEconomyConfig(db, to),
  ]);
  return wireDiff(diffEconomyConfig(before, after));
}

/**
 * One version with its payload, diffed against whatever it came from.
 *
 * `comparedWith` is the row's own `parent_version` — the version this was
 * derived from — which is what makes *"every version is diffable against the
 * previous"* a property of the data rather than of whoever remembers to ask.
 */
export async function readEconomyConfigVersion(
  db: Database,
  version: string,
): Promise<AdminEconomyConfigDetailResponse | null> {
  const rows = await db
    .select()
    .from(economyConfig)
    .where(eq(economyConfig.version, version))
    .limit(1);

  const row = rows[0];
  if (!row) return null;

  const pinned = await worldsPerVersion(db);
  let diff: AdminEconomyConfigChange[] | null = null;

  if (row.parentVersion !== null) {
    // Loaded through the cache, so opening a version repeatedly does not
    // re-parse two payloads every time.
    const [parent, self] = await Promise.all([
      loadEconomyConfig(db, row.parentVersion),
      loadEconomyConfig(db, row.version),
    ]);
    diff = wireDiff(diffEconomyConfig(parent, self));
  }

  return {
    summary: summarise(row, pinned.get(row.version) ?? 0),
    payloadJson: row.payload,
    comparedWith: row.parentVersion,
    diff,
  };
}

// -------------------------------------------------------------- create (write)

export interface CreateEconomyConfigResult {
  ok: true;
  summary: AdminEconomyConfigSummary;
  diff: AdminEconomyConfigChange[];
}

export type CreateEconomyConfigOutcome =
  CreateEconomyConfigResult | EconomyRefusal<CreateEconomyRefusalCode>;

export interface ValidatedCreate {
  ok: true;
  request: AdminCreateEconomyConfigRequest;
  payload: EconomyConfigContract;
}

/**
 * Everything decidable without the database: the request's shape, and whether
 * the payload is a valid economy at all.
 *
 * Split out for the same reason `validateSpeedRequest` is: what needs the
 * database — does this version already exist, does the parent — has to be
 * decided inside the transaction that writes, or two admins race between the
 * check and the insert.
 */
export function validateCreateRequest(
  input: unknown,
): ValidatedCreate | EconomyRefusal<CreateEconomyRefusalCode> {
  const parsed = AdminCreateEconomyConfigRequest.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      code: 'invalid_request',
      message: 'That is not a version this can create.',
      fields: fieldErrors(parsed.error.issues),
    };
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(parsed.data.payloadJson);
  } catch {
    return refuse('invalid_payload', 'payloadJson', 'That is not valid JSON.');
  }

  const payload = { ...(decoded as Record<string, unknown>), version: parsed.data.version };
  const checked = defineEconomyConfigSafely(payload);
  if (!checked.ok) return checked;

  if (parsed.data.version === parsed.data.parentVersion) {
    return refuse(
      'invalid_request',
      'parentVersion',
      'A version cannot be derived from itself. Name the version this was tuned from.',
    );
  }

  return { ok: true, request: parsed.data, payload: checked.payload };
}

function defineEconomyConfigSafely(
  input: unknown,
): { ok: true; payload: EconomyConfigContract } | EconomyRefusal<'invalid_payload'> {
  try {
    return { ok: true, payload: defineEconomyConfig(input) };
  } catch (error) {
    const issues = (error as { issues?: { path: PropertyKey[]; message: string }[] }).issues;
    if (!issues) throw error;
    return {
      ok: false,
      code: 'invalid_payload',
      message: 'That payload is not a valid economy.',
      // Prefixed, because these paths are inside the payload rather than at the
      // top of the form — `demand.logit.beta.leisure.price`, not `demand`.
      fields: {
        payloadJson: issues.map(
          (issue) => `${issue.path.map(String).join('.') || 'payload'}: ${issue.message}`,
        ),
      },
    };
  }
}

/**
 * Write a new version, and record who wrote it — one transaction.
 *
 * Nothing is pinned to it. That is the point: this is a proposal until somebody
 * points a world at it, and the two acts appear separately in the audit log.
 */
export async function createEconomyConfigVersion(
  db: Database,
  validated: ValidatedCreate,
  actor: Actor,
): Promise<CreateEconomyConfigOutcome> {
  const { request, payload } = validated;

  return db.transaction(async (tx): Promise<CreateEconomyConfigOutcome> => {
    const existing = await tx
      .select({ version: economyConfig.version })
      .from(economyConfig)
      .where(eq(economyConfig.version, request.version))
      .limit(1);

    if (existing.length > 0) {
      // Not an update. The rows are immutable and the trigger would refuse one
      // anyway; saying so plainly is better than surfacing a Postgres exception.
      return refuse(
        'version_exists',
        'version',
        `Version "${request.version}" already exists, and a version cannot be edited. Choose a new name.`,
      );
    }

    const parentRows = await tx
      .select({ payload: economyConfig.payload })
      .from(economyConfig)
      .where(eq(economyConfig.version, request.parentVersion))
      .limit(1);

    const parentRow = parentRows[0];
    if (!parentRow) {
      return refuse(
        'unknown_parent',
        'parentVersion',
        `There is no version "${request.parentVersion}" to derive this from.`,
      );
    }

    const parent = defineEconomyConfig(JSON.parse(parentRow.payload) as unknown);
    const diff = wireDiff(diffEconomyConfig(parent, payload));

    const canonical = canonicalEconomyJson(payload);
    const checksum = economyChecksum(payload);
    const createdAt = new Date();

    await tx.insert(economyConfig).values({
      version: request.version,
      payload: canonical,
      checksum,
      parentVersion: request.parentVersion,
      notes: request.notes,
      createdAt,
      createdByPlayerId: actor.playerId,
      createdByLabel: actor.label,
    });

    await writeAudit(tx, {
      actorPlayerId: actor.playerId,
      actorLabel: actor.label,
      action: 'economy.version_created',
      subjectType: 'economy_config',
      subjectId: request.version,
      before: { version: request.parentVersion },
      after: {
        version: request.version,
        checksum,
        notes: request.notes,
        // The changes themselves, in the log. A version can be read back from
        // `economy_config` at any time, but "what did this retune actually
        // move?" is the question somebody asks under pressure, and it should
        // not require fetching two payloads and comparing them by hand.
        changes: diff,
      },
      requestId: actor.requestId,
    });

    return {
      ok: true,
      summary: summarise(
        {
          version: request.version,
          checksum,
          parentVersion: request.parentVersion,
          notes: request.notes,
          createdAt,
          createdByPlayerId: actor.playerId,
          createdByLabel: actor.label,
        },
        0,
      ),
      diff,
    };
  });
}

// ----------------------------------------------------------------- pin (write)

export interface PinEconomyConfigResult {
  ok: true;
  worldId: string;
  worldName: string;
  before: string;
  after: string;
  diff: AdminEconomyConfigChange[];
  pendingEvents: number;
}

export type PinEconomyConfigOutcome =
  PinEconomyConfigResult | EconomyRefusal<PinEconomyRefusalCode>;

export function validatePinRequest(
  input: unknown,
): { ok: true; request: AdminPinEconomyConfigRequest } | EconomyRefusal<PinEconomyRefusalCode> {
  const parsed = AdminPinEconomyConfigRequest.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      code: 'invalid_request',
      message: 'That is not an economy version this world can be moved to.',
      fields: fieldErrors(parsed.error.issues),
    };
  }
  return { ok: true, request: parsed.data };
}

/**
 * Point a world at a different economy, and record it — one transaction.
 *
 * The world row is locked `FOR UPDATE` before anything is read from it, so the
 * "expected version" check and the write cannot be interleaved with another
 * admin doing the same thing.
 *
 * ## What this does and does not move
 *
 * It changes what future work is priced with. It does **not** rewrite anything
 * already settled: a `flight_result` records the version it was billed under and
 * keeps it, which is the only reason an old flight stays explicable after a
 * retune (invariant 4). Demand pools are the exception worth knowing about —
 * they are generated once from the gravity coefficients and stored, so moving a
 * world to a version with a different `k` does not resize the pools that already
 * exist. `pnpm demand:generate` does that, deliberately and separately, because
 * it is a rewrite of a million rows rather than a config read.
 */
export async function pinWorldEconomyConfig(
  db: Database,
  worldId: string,
  request: AdminPinEconomyConfigRequest,
  actor: Actor,
): Promise<PinEconomyConfigOutcome> {
  return db.transaction(async (tx): Promise<PinEconomyConfigOutcome> => {
    const rows = await tx.select().from(world).where(eq(world.id, worldId)).limit(1).for('update');
    const row = rows[0];
    if (!row) {
      return {
        ok: false,
        code: 'world_not_found',
        message: 'No world with that id.',
        fields: { form: ['That world no longer exists. Reload the list.'] },
      };
    }

    if (row.status === 'archived') {
      // An archived world is a record of something that happened. Repricing one
      // would change the economy of a world nobody can play.
      return refuse(
        'world_archived',
        'form',
        `"${row.name}" is archived. An archived world is a record of what happened, so its economy stays as it was.`,
      );
    }

    if (row.economyConfigVersion !== request.expectedVersion) {
      return {
        ok: false,
        code: 'version_stale',
        message: 'The world is no longer on the economy version you were shown.',
        fields: {
          form: [
            `"${row.name}" is on "${row.economyConfigVersion}", not "${request.expectedVersion}" as shown. ` +
              'Somebody else changed it. Check the audit log, then decide again.',
          ],
        },
      };
    }

    if (row.economyConfigVersion === request.version) {
      // Not an error, but not a change either — and it must not write an audit
      // entry, because a log full of "changed v2 to v2" is a log nobody reads.
      return refuse(
        'version_unchanged',
        'version',
        `"${row.name}" is already running economy "${request.version}".`,
      );
    }

    const target = await tx
      .select({ payload: economyConfig.payload })
      .from(economyConfig)
      .where(eq(economyConfig.version, request.version))
      .limit(1);

    const targetRow = target[0];
    if (!targetRow) {
      return refuse(
        'unknown_version',
        'version',
        `There is no economy version "${request.version}". Create it before pinning a world to it.`,
      );
    }

    const currentRows = await tx
      .select({ payload: economyConfig.payload })
      .from(economyConfig)
      .where(eq(economyConfig.version, row.economyConfigVersion))
      .limit(1);

    // A world can be sitting on a version that is not in the table — a database
    // restored from before the version was created, say. That is worth
    // recording rather than refusing: moving it *onto* a known version is the
    // fix, so the diff is simply empty and the log says which version it left.
    const currentPayload = currentRows[0]?.payload;
    const diff =
      currentPayload === undefined
        ? []
        : wireDiff(
            diffEconomyConfig(
              defineEconomyConfig(JSON.parse(currentPayload) as unknown),
              defineEconomyConfig(JSON.parse(targetRow.payload) as unknown),
            ),
          );

    const pending = await tx
      .select({ n: count() })
      .from(worldEvent)
      .where(eq(worldEvent.worldId, worldId));
    const pendingEvents = pending[0]?.n ?? 0;

    await tx
      .update(world)
      .set({ economyConfigVersion: request.version })
      .where(eq(world.id, worldId));

    await writeAudit(tx, {
      actorPlayerId: actor.playerId,
      actorLabel: actor.label,
      action: 'world.economy_pinned',
      subjectType: 'world',
      subjectId: worldId,
      before: { name: row.name, economyConfigVersion: row.economyConfigVersion },
      after: {
        name: row.name,
        economyConfigVersion: request.version,
        pendingEvents,
        changes: diff,
      },
      requestId: actor.requestId,
    });

    return {
      ok: true,
      worldId,
      worldName: row.name,
      before: row.economyConfigVersion,
      after: request.version,
      diff,
      pendingEvents,
    };
  });
}

/**
 * Forget a cached version.
 *
 * Re-exported here so the admin surface has one import for economy operations.
 * Not needed after a create — a brand-new version cannot be in the cache — and
 * not needed after a pin, because the pin is never cached.
 */
export { clearEconomyConfigCache };
