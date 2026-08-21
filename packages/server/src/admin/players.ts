import { asc, count, desc, eq, ilike, inArray, max, or, sql } from 'drizzle-orm';

import { type AdminPlayerDetail, type AdminPlayerSummary } from '@tailfin/shared';

import { type Database } from '../db/client';
import { adminGrant, airline, player, playerIdentity, session, world } from '../db/schema';

import { writeAudit } from './audit';
import { type Actor } from './grants';

/**
 * Browsing players and their airlines (M1A-08, design doc §22).
 *
 * ## Read-only, and structurally so
 *
 * Nothing in this module writes to player data. Editing, banning, deleting and
 * impersonating are M11-06, and each needs confirmation and audit machinery that
 * looking does not — so the read half lands first, on its own, and there is no
 * half-built destructive path sitting behind a feature flag in the meantime.
 *
 * The one thing it does write is an audit row, and only for the detail view. See
 * `readPlayer`.
 *
 * ## What is deliberately not returned
 *
 * **No session token, in any form.** The database stores only a SHA-256 of it
 * (M0-11) and the response shape has nowhere to put one — the protection is
 * structural rather than a rule somebody has to remember.
 *
 * **No email address in the list.** It is on the detail view only. A list is the
 * wide surface: it is what a search returns and what a screenshot catches, and an
 * address is not needed to *find* someone.
 */

/** How many players one page returns. Bounded so a stray request cannot ask for everything. */
export const PLAYER_PAGE_LIMIT = 50;
const MAX_LIMIT = 200;

export interface PlayerQuery {
  /** Matched against display name, airline name, and IATA/ICAO code. Empty means everyone. */
  query?: string;
  limit?: number;
  offset?: number;
}

export interface PlayerPage {
  players: AdminPlayerSummary[];
  total: number;
  query: string;
  limit: number;
  offset: number;
}

/**
 * Escapes a user's search text so `%` and `_` are literals rather than wildcards.
 *
 * Without this, searching for `_` matches every player, which looks like a broken
 * search rather than a working one. The backslash is doubled because it is also
 * the escape character.
 */
function escapeLike(input: string): string {
  return input.replace(/[\\%_]/g, (char) => `\\${char}`);
}

/**
 * Players, newest first, or those matching a search.
 *
 * ## The search spans two tables on purpose
 *
 * Support is handed whatever the player quoted: their own name, their airline's
 * name, or the code on the side of the aircraft. Requiring the right one before
 * anything is found makes the feature useless in exactly the situation it exists
 * for. So one box searches all four, and the caller does not have to know which
 * kind of thing they were given.
 *
 * ## Why `ILIKE` and not a trigram index
 *
 * `ILIKE '%x%'` cannot use a btree index and scans. At the acceptance
 * criterion's scale — 10,000 players — that is a few milliseconds, and it is
 * measured rather than assumed in `players.test.ts`. A `pg_trgm` index would
 * make it sub-millisecond and would also mean an extension and a migration for a
 * table that will not need it for a long time. Revisit at a scale that shows up
 * in a measurement.
 */
export async function listPlayers(db: Database, options: PlayerQuery = {}): Promise<PlayerPage> {
  const query = (options.query ?? '').trim();
  const limit = Math.min(Math.max(Math.trunc(options.limit ?? PLAYER_PAGE_LIMIT), 1), MAX_LIMIT);
  const offset = Math.max(Math.trunc(options.offset ?? 0), 0);

  const pattern = `%${escapeLike(query)}%`;
  // A player matches if their own name matches, or if any airline they hold
  // matches by name or by code. `exists` rather than a join so a player with
  // three matching airlines is still one row.
  const matches =
    query === ''
      ? undefined
      : or(
          ilike(player.displayName, pattern),
          sql`exists (
            select 1 from ${airline}
            where ${airline.playerId} = ${player.id}
              and (
                ${ilike(airline.name, pattern)}
                or ${ilike(airline.iataCode, pattern)}
                or ${ilike(airline.icaoCode, pattern)}
              )
          )`,
        );

  const totals = await db.select({ n: count() }).from(player).where(matches);

  const rows = await db
    .select({
      id: player.id,
      displayName: player.displayName,
      createdAt: player.createdAt,
    })
    .from(player)
    .where(matches)
    // Total, not merely sorted: `created_at` ties on rows inserted in the same
    // millisecond, and a page boundary landing inside a tie would show a row
    // twice or not at all.
    .orderBy(desc(player.createdAt), asc(player.id))
    .limit(limit)
    .offset(offset);

  const ids = rows.map((row) => row.id);
  const extras = await countFor(db, ids);

  return {
    players: rows.map((row) => ({
      id: row.id,
      displayName: row.displayName,
      createdAt: row.createdAt.toISOString(),
      lastSeenAt: toIso(extras.lastSeen.get(row.id) ?? null),
      airlines: extras.airlines.get(row.id) ?? 0,
      isAdmin: extras.admins.has(row.id),
    })),
    total: totals[0]?.n ?? 0,
    query,
    limit,
    offset,
  };
}

/**
 * What each player on the page holds — three grouped queries, not three
 * correlated subqueries.
 *
 * The first version computed these as correlated scalar subqueries inside the
 * select list. Against real Postgres they came back as zero and null for players
 * who demonstrably had airlines and sessions, while the *same* correlated shape
 * in the `where` clause worked. Rather than debug drizzle's rendering blind — the
 * database-backed tests only run in CI — this uses the pattern already proven in
 * `countWorldContents`: group once per table, look up by id.
 *
 * Scoped to the ids on the page, so the cost is bounded by page size rather than
 * by how many players exist. Grouped rather than joined because a join to both
 * airlines and sessions multiplies them together and counts each several times.
 */
async function countFor(
  db: Database,
  ids: string[],
): Promise<{
  airlines: Map<string, number>;
  lastSeen: Map<string, Date | string>;
  admins: Set<string>;
}> {
  if (ids.length === 0) {
    return { airlines: new Map(), lastSeen: new Map(), admins: new Set() };
  }

  // `inArray` against a list of real player ids already excludes NPC carriers:
  // SQL's `NULL IN (…)` is never true, so an airline with no player cannot
  // match. The null is filtered out again when the map is built, because the
  // column's type is now nullable and a silent `null` key would be a bug that
  // only showed up as a missing count.
  const airlines = await db
    .select({ playerId: airline.playerId, n: count() })
    .from(airline)
    .where(inArray(airline.playerId, ids))
    .groupBy(airline.playerId);

  const seen = await db
    .select({ playerId: session.playerId, at: max(session.lastSeenAt) })
    .from(session)
    .where(inArray(session.playerId, ids))
    .groupBy(session.playerId);

  const admins = await db
    .select({ playerId: adminGrant.playerId })
    .from(adminGrant)
    .where(inArray(adminGrant.playerId, ids));

  const lastSeen = new Map<string, Date | string>();
  for (const row of seen) {
    // Drizzle types `max()` as the column's type, `Date`. It is not: a column
    // type parser applies to a *column*, and a raw aggregate is not one, so the
    // driver's own decoding is what arrives — a string. The same assertion
    // typechecked happily in `queueDepth` and threw against real Postgres.
    const at: Date | string | null = row.at;
    if (at !== null) lastSeen.set(row.playerId, at);
  }

  return {
    airlines: new Map(
      airlines
        .filter((row): row is { playerId: string; n: number } => row.playerId !== null)
        .map((row) => [row.playerId, row.n]),
    ),
    lastSeen,
    admins: new Set(admins.map((row) => row.playerId)),
  };
}

function toIso(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

/**
 * One player, in full — and a record that somebody looked.
 *
 * ## Why a read is audited
 *
 * §22.1 asks for an immutable log of every admin action, and opening somebody's
 * account **is** an action: it exposes their identities, their email address and
 * where they have been signed in. A support tool that can read any account
 * without leaving a trace is one nobody can be held to.
 *
 * Only the detail view is recorded. A search that returns a page of names is not
 * a view of a person's record, and auditing every keystroke's worth of results
 * would bury the entries that matter under noise — which is the failure mode
 * this decision has to avoid rather than accept. The other half of that decision
 * lives in `readAudit`, which leaves `player.viewed` out of the log by default.
 *
 * The audit row shares a transaction with the read, so the record and the
 * disclosure cannot come apart.
 */
export async function readPlayer(
  db: Database,
  playerId: string,
  actor: Actor,
  now: Date = new Date(),
): Promise<AdminPlayerDetail | null> {
  return db.transaction(async (tx) => {
    const rows = await tx.select().from(player).where(eq(player.id, playerId)).limit(1);
    const row = rows[0];
    if (!row) return null;

    const identities = await tx
      .select()
      .from(playerIdentity)
      .where(eq(playerIdentity.playerId, playerId))
      .orderBy(asc(playerIdentity.createdAt));

    const sessions = await tx
      .select({
        id: session.id,
        createdAt: session.createdAt,
        expiresAt: session.expiresAt,
        lastSeenAt: session.lastSeenAt,
      })
      .from(session)
      .where(eq(session.playerId, playerId))
      .orderBy(desc(session.lastSeenAt));

    const airlines = await tx
      .select({
        id: airline.id,
        worldId: airline.worldId,
        worldName: world.name,
        name: airline.name,
        iataCode: airline.iataCode,
        icaoCode: airline.icaoCode,
        callsign: airline.callsign,
        cashMinor: airline.cashMinor,
        reputation: airline.reputation,
        status: airline.status,
        statusChangedAt: airline.statusChangedAt,
        ceasedAt: airline.ceasedAt,
        createdAt: airline.createdAt,
      })
      .from(airline)
      .innerJoin(world, eq(world.id, airline.worldId))
      .where(eq(airline.playerId, playerId))
      .orderBy(asc(airline.createdAt));

    const grants = await tx
      .select({ playerId: adminGrant.playerId })
      .from(adminGrant)
      .where(eq(adminGrant.playerId, playerId))
      .limit(1);

    await writeAudit(tx, {
      actorPlayerId: actor.playerId,
      actorLabel: actor.label,
      action: 'player.viewed',
      subjectType: 'player',
      subjectId: playerId,
      // No before/after: nothing changed. What is worth recording is *what was
      // disclosed*, which is why the counts are here rather than the contents —
      // the audit log must not become a second copy of the data it guards.
      after: {
        displayName: row.displayName,
        identities: identities.length,
        sessions: sessions.length,
        airlines: airlines.length,
      },
      requestId: actor.requestId,
    });

    return {
      id: row.id,
      displayName: row.displayName,
      avatarUrl: row.avatarUrl,
      anonymizedAt: row.anonymizedAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
      isAdmin: grants.length > 0,
      identities: identities.map((identity) => ({
        provider: identity.provider,
        subject: identity.subject,
        email: identity.email,
        createdAt: identity.createdAt.toISOString(),
      })),
      sessions: sessions.map((entry) => ({
        id: entry.id,
        createdAt: entry.createdAt.toISOString(),
        expiresAt: entry.expiresAt.toISOString(),
        lastSeenAt: entry.lastSeenAt.toISOString(),
        // Decided here, against the server's clock. A browser with a wrong clock
        // must not disagree with the server about whether a session is live.
        expired: entry.expiresAt.getTime() <= now.getTime(),
      })),
      airlines: airlines.map((entry) => ({
        id: entry.id,
        worldId: entry.worldId,
        worldName: entry.worldName,
        name: entry.name,
        iataCode: entry.iataCode,
        icaoCode: entry.icaoCode,
        callsign: entry.callsign,
        cashMinor: entry.cashMinor,
        reputation: Number(entry.reputation),
        status: entry.status,
        statusChangedAt: entry.statusChangedAt.toISOString(),
        ceasedAt: entry.ceasedAt?.toISOString() ?? null,
        createdAt: entry.createdAt.toISOString(),
      })),
    };
  });
}

/** Exported for the tests that prove the search does not treat `%` as a wildcard. */
export { escapeLike };
