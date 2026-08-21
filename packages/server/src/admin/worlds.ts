import { asc, count, eq } from 'drizzle-orm';

import {
  type AdminWorldSummary,
  WorldConfig,
  type WorldConfig as WorldConfigType,
} from '@tailfin/shared';
import { gameTime } from '@tailfin/sim';

import { type Database } from '../db/client';
import { airline, world, worldEvent, type WorldRow } from '../db/schema';
import { type EconomyVersionCheck } from '../world/config';
import { createWorld } from '../world/lifecycle';

import { writeAudit } from './audit';
import { type Actor } from './grants';

/**
 * Creating worlds from the console (M1A-02, design doc §22.2).
 *
 * M1-09 already knows how to turn a config into a world; what was missing was a
 * way to *decide* the config without a shell. The parameters of a world are a
 * decision rather than a constant, and decisions belong in an interface with a
 * record of who made them.
 */

/**
 * Constraint names, translated.
 *
 * The schema's checks are the real backstop — they hold whatever the application
 * believes — but `world_speed_multiplier_positive` is not a sentence, and an
 * admin who sees it learns nothing about what to change. Every constraint that
 * can plausibly fire from this form has a reason written out here, and the field
 * it belongs to so the form can point at it.
 *
 * Validation happens before the insert too. This is what catches the cases
 * validation cannot: a race between two admins, or a rule the schema knows and
 * the application has forgotten.
 */
const CONSTRAINT_REASONS: Record<string, { field: string; reason: string }> = {
  world_name_key: {
    field: 'name',
    reason:
      'A world with this name already exists. Names are how worlds are told apart, so they have to be unique.',
  },
  world_speed_multiplier_positive: {
    field: 'speedMultiplier',
    reason: 'The speed multiplier must be greater than zero. A world at zero speed never advances.',
  },
  world_player_cap_positive: {
    field: 'playerCap',
    reason: 'The player cap must be at least one, or empty for no cap at all.',
  },
};

export interface ValidationFailure {
  ok: false;
  /** Field name to the reasons it was refused, for a form to render beside its inputs. */
  fields: Record<string, string[]>;
}

export type ValidationResult = { ok: true; config: WorldConfigType } | ValidationFailure;

/** Turns a zod path into the field name the form knows. */
function fieldOf(path: readonly PropertyKey[]): string {
  return path.length > 0 ? String(path[0]) : 'form';
}

/**
 * Validates a submitted config, in the words an admin needs.
 *
 * Three layers now. The zod schema is the shape; the epoch rule is the meaning;
 * and since M3-11 the economy version is a fact about the database rather than
 * about a registry in code, which is what makes this asynchronous. The lookup is
 * passed in for the same reason `assertUsableConfig` takes one — this file
 * should not become a second place that knows how `economy_config` is stored. An epoch at or after now makes `gameTime` start in the future and
 * makes a reset a no-op — the exact failure ADR-0005 exists to prevent, and one
 * that would surface weeks later when somebody tried to reset and nothing moved.
 */
export async function validateWorldConfig(
  input: unknown,
  now: Date,
  versionExists: EconomyVersionCheck,
): Promise<ValidationResult> {
  const parsed = WorldConfig.safeParse(input);
  if (!parsed.success) {
    const fields: Record<string, string[]> = {};
    for (const issue of parsed.error.issues) {
      const field = fieldOf(issue.path);
      (fields[field] ??= []).push(issue.message);
    }
    return { ok: false, fields };
  }

  const config = parsed.data;
  const epochMs = Date.parse(config.epoch);
  if (Number.isNaN(epochMs)) {
    return { ok: false, fields: { epoch: ['That is not a date this can read.'] } };
  }
  if (epochMs >= now.getTime()) {
    return {
      ok: false,
      fields: {
        epoch: [
          'The epoch has to be in the past. It is where the calendar begins and where a reset ' +
            'returns to, so an epoch of today or later would make a reset do nothing (ADR-0005).',
        ],
      },
    };
  }

  if (!(await versionExists(config.economyConfigVersion))) {
    return {
      ok: false,
      fields: {
        economyConfigVersion: [
          `There is no economy version "${config.economyConfigVersion}". ` +
            'Pick one from the economy list, or create it first.',
        ],
      },
    };
  }

  return { ok: true, config };
}

/**
 * Reads a Postgres constraint violation, if that is what an error is.
 *
 * The driver puts the constraint name on the error, but drizzle wraps errors, so
 * the cause chain is walked — the same lesson as the audit-log tests.
 */
export function constraintFailure(error: unknown): ValidationFailure | null {
  let current: unknown = error;
  while (current instanceof Error) {
    const constraint = (current as { constraint?: unknown }).constraint;
    if (typeof constraint === 'string') {
      const known = CONSTRAINT_REASONS[constraint];
      return {
        ok: false,
        fields: known
          ? { [known.field]: [known.reason] }
          : // An unmapped constraint is a bug in this map rather than in the
            // request, so it says so instead of blaming the admin's input.
            { form: [`The database refused this world (${constraint}).`] },
      };
    }
    current = current.cause;
  }
  return null;
}

export interface CreateResult {
  world: WorldRow;
  /** False when a world of that name already existed; nothing was written. */
  created: boolean;
}

/**
 * Creates a world and records who did it, in one transaction.
 *
 * The audit row and the world share a transaction for the reason every M1A
 * action does: a record written afterwards is one that can go missing exactly
 * when the change was the one somebody wanted hidden.
 *
 * `created: false` means a world of that name was already there. M1-09's
 * `createWorld` is idempotent on purpose — it is what a fresh environment runs,
 * repeatedly — but an admin filling in a form is not asking to be idempotent,
 * they are asking to create something, so the caller turns this into a refusal.
 */
export async function createWorldAsAdmin(
  db: Database,
  config: WorldConfigType,
  actor: Actor,
  now: Date = new Date(),
): Promise<CreateResult> {
  return db.transaction(async (tx) => {
    const result = await createWorld(tx, config, now);
    if (!result.created) return { world: result.world, created: false };

    await writeAudit(tx, {
      actorPlayerId: actor.playerId,
      actorLabel: actor.label,
      action: 'world.created',
      subjectType: 'world',
      subjectId: result.world.id,
      // No `before`: nothing existed. `after` is the config as decided, which is
      // what makes the entry answer "what was this world set up to be?".
      after: {
        name: config.name,
        epoch: config.epoch,
        speedMultiplier: config.speedMultiplier,
        aircraftCatalogueVersion: config.aircraftCatalogueVersion,
        economyConfigVersion: config.economyConfigVersion,
        playerCap: config.playerCap,
        status: result.world.status,
      },
      requestId: actor.requestId,
    });

    return { world: result.world, created: true };
  });
}

/** What is inside a world, for the summary. Zero is the honest default for a world just created. */
export interface WorldContents {
  pendingEvents: number;
  airlines: number;
}

const EMPTY: WorldContents = { pendingEvents: 0, airlines: 0 };

/**
 * A world row as the console shows it, with the in-game date worked out.
 *
 * The counts are passed in rather than queried here, so that listing twenty
 * worlds is three queries rather than forty-one, and so a caller that already
 * counted them inside a transaction can use the numbers it has. They are one
 * object rather than two positional arguments because a reset confirmation
 * depends on both being right, and `summariseWorld(row, now, 4, 12)` is a
 * transposition waiting to happen.
 */
export function summariseWorld(
  row: WorldRow,
  now: Date = new Date(),
  contents: WorldContents = EMPTY,
): AdminWorldSummary {
  const speedMultiplier = Number(row.speedMultiplier);
  return {
    id: row.id,
    name: row.name,
    epoch: row.epoch.toISOString(),
    launchDate: row.launchDate.toISOString(),
    speedMultiplier,
    status: row.status,
    aircraftCatalogueVersion: row.aircraftCatalogueVersion,
    economyConfigVersion: row.economyConfigVersion,
    playerCap: row.playerCap,
    createdAt: row.createdAt.toISOString(),
    inGameDate: gameTime(
      { epoch: row.epoch, launchDate: row.launchDate, speedMultiplier },
      now,
    ).toISOString(),
    pendingEvents: contents.pendingEvents,
    airlines: contents.airlines,
  };
}

/**
 * What each world contains, in two grouped queries rather than two per world.
 *
 * A world with nothing in it has no row in either result, which is why the
 * lookups fall back to zero rather than treating a missing key as unknown.
 */
export async function countWorldContents(db: Database): Promise<Map<string, WorldContents>> {
  const pending = await db
    .select({ worldId: worldEvent.worldId, n: count() })
    .from(worldEvent)
    .where(eq(worldEvent.status, 'pending'))
    .groupBy(worldEvent.worldId);

  const airlines = await db
    .select({ worldId: airline.worldId, n: count() })
    .from(airline)
    .groupBy(airline.worldId);

  const contents = new Map<string, WorldContents>();
  for (const entry of pending) {
    contents.set(entry.worldId, { pendingEvents: entry.n, airlines: 0 });
  }
  for (const entry of airlines) {
    const existing = contents.get(entry.worldId);
    contents.set(entry.worldId, {
      pendingEvents: existing?.pendingEvents ?? 0,
      airlines: entry.n,
    });
  }
  return contents;
}

export async function listWorlds(
  db: Database,
  now: Date = new Date(),
): Promise<AdminWorldSummary[]> {
  const rows = await db.select().from(world).orderBy(asc(world.createdAt));
  const contents = await countWorldContents(db);

  return rows.map((row) => summariseWorld(row, now, contents.get(row.id) ?? EMPTY));
}
