import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  index,
  numeric,
  pgEnum,
  pgTable,
  serial,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * Database schema.
 *
 * Migrations are generated into `drizzle/` and **committed as SQL**. They are
 * never generated at runtime (M0-05). Never edit an applied migration — add a
 * new one.
 *
 * Conventions used throughout:
 *
 *   - **UUID primary keys** on anything that will appear in a URL or an API
 *     response. Sequential ids would leak how many worlds, players and airlines
 *     exist, and §16 makes airline profiles public.
 *   - **Money is integer minor units**, never floating point. See `cash_minor`.
 *   - **No balance numbers as column defaults.** Starting cash, starting
 *     reputation and the like are configuration (CONTRIBUTING invariant 3). The
 *     one exception is `reputation`, whose 0.35 is fixed by §15 as part of the
 *     scale's definition rather than being a tunable.
 *   - **Timestamps are `timestamptz`.** The server is UTC, players are not.
 */

// ---------------------------------------------------------------------------
// health — proves the migration pipeline end to end (M0-05)
// ---------------------------------------------------------------------------

export const health = pgTable('health', {
  id: serial('id').primaryKey(),

  /**
   * Set by the database, not by the application. A row whose timestamp came
   * from the server process would prove the server's clock works, not that the
   * database is reachable and writable — which is the point of the table.
   */
  checkedAt: timestamp('checked_at', { withTimezone: true }).notNull().defaultNow(),

  note: text('note'),
});

// ---------------------------------------------------------------------------
// world — the top-level container. Multiple worlds run in parallel (§22.2).
// ---------------------------------------------------------------------------

export const worldStatus = pgEnum('world_status', ['staging', 'open', 'locked', 'archived']);

export const world = pgTable(
  'world',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),

    /**
     * Where the in-game calendar begins — `2024-10-20T00:00:00Z` for the
     * flagship world (§3.1b).
     *
     * `timestamptz`, not `date`, even though §22.2 calls it a date: the clock
     * formula adds a scaled real-time delta to it, and day granularity would
     * make that arithmetic lossy.
     */
    epoch: timestamp('epoch', { withTimezone: true }).notNull(),

    /**
     * The real instant this world's clock started running. In-game time is
     * derived from it and never stored:
     *
     *     inGameDate = epoch + speed_multiplier × (now − launch_date)
     *
     * An admin reset therefore sets this to `now()` and leaves `epoch` alone,
     * which returns the calendar to the epoch by definition rather than by
     * recalculation. See ADR-0005.
     */
    launchDate: timestamp('launch_date', { withTimezone: true }).notNull(),

    /** 2 for the flagship world (§3.1). Changing it mid-world rewrites the calendar — §22.2 gates this. */
    speedMultiplier: numeric('speed_multiplier', { precision: 4, scale: 2 }).notNull(),

    status: worldStatus('status').notNull().default('staging'),

    /** Pinned so retuning aircraft or economy does not retroactively change a running world (§22.2, §22.5). */
    aircraftCatalogueVersion: text('aircraft_catalogue_version').notNull(),
    economyConfigVersion: text('economy_config_version').notNull(),

    /** NULL means uncapped. */
    playerCap: bigint('player_cap', { mode: 'number' }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('world_name_key').on(t.name),
    index('world_status_idx').on(t.status),
    check('world_speed_multiplier_positive', sql`${t.speedMultiplier} > 0`),
    check('world_player_cap_positive', sql`${t.playerCap} IS NULL OR ${t.playerCap} > 0`),
    // A world whose clock started before its calendar begins is not meaningful,
    // but launch_date *may* legitimately precede epoch in wall-clock terms —
    // the flagship world's epoch is in the past. So no ordering check here on
    // purpose; the note exists so nobody adds one thinking it was forgotten.
  ],
);

// ---------------------------------------------------------------------------
// player — a person. Distinct from `airline`: one person may hold an airline in
// several worlds.
// ---------------------------------------------------------------------------

export const player = pgTable('player', {
  id: uuid('id').primaryKey().defaultRandom(),
  displayName: text('display_name').notNull(),
  /** From the provider's `picture` claim. Nullable — not everyone has one. */
  avatarUrl: text('avatar_url'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Login sessions (M0-11).
 *
 * Sessions live here rather than in memory because every deploy restarts the
 * process (`deploy.sh`), and in-memory sessions would sign everyone out on each
 * release.
 *
 * **The cookie's token is never stored.** Only its SHA-256 hash is, so a dump of
 * this table does not hand an attacker a set of live sessions — the same reason
 * password hashes exist. Lookup is by hash, which is why `token_hash` is unique
 * rather than the primary key being the token.
 */
export const session = pgTable(
  'session',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    playerId: uuid('player_id')
      .notNull()
      .references(() => player.id, { onDelete: 'cascade' }),

    /** Hex SHA-256 of the opaque token held by the client. */
    tokenHash: text('token_hash').notNull(),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    /** Absolute expiry. Checked on every request; sweeping old rows is separate. */
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('session_token_hash_key').on(t.tokenHash),
    index('session_player_id_idx').on(t.playerId),
    // Sweeping expired sessions is a range scan over this.
    index('session_expires_at_idx').on(t.expiresAt),
    check('session_token_hash_is_sha256', sql`length(${t.tokenHash}) = 64`),
    check('session_expires_after_creation', sql`${t.expiresAt} > ${t.createdAt}`),
  ],
);

export const authProvider = pgEnum('auth_provider', ['google']);

/**
 * External identities that map onto a player.
 *
 * **A deliberate deviation from M0-06's wording**, which asks for
 * `player.external_auth_id`. ADR-0004 chose Google OAuth and requires the
 * account model to tolerate more than one identity per player, so that adding a
 * second provider is not a migration over live accounts. One extra table now
 * instead of that later.
 *
 * The key is the provider's stable subject claim — Google's `sub` — and never
 * the email address. People change email addresses, and matching accounts on
 * email is how account-takeover bugs happen.
 */
export const playerIdentity = pgTable(
  'player_identity',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    playerId: uuid('player_id')
      .notNull()
      .references(() => player.id, { onDelete: 'cascade' }),
    provider: authProvider('provider').notNull(),
    subject: text('subject').notNull(),
    /** Informational only. Never used to match an identity to a player. */
    email: text('email'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('player_identity_provider_subject_key').on(t.provider, t.subject),
    index('player_identity_player_id_idx').on(t.playerId),
  ],
);

// ---------------------------------------------------------------------------
// airline — a player's presence in one world.
// ---------------------------------------------------------------------------

export const airline = pgTable(
  'airline',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    worldId: uuid('world_id')
      .notNull()
      .references(() => world.id, { onDelete: 'cascade' }),

    /**
     * `restrict`, not `cascade`. §22.10 requires GDPR deletion to anonymise the
     * player while keeping the airline's operational record — world history
     * must survive. Restricting the delete forces that path instead of quietly
     * taking the airline with it.
     */
    playerId: uuid('player_id')
      .notNull()
      .references(() => player.id, { onDelete: 'restrict' }),

    name: text('name').notNull(),

    /**
     * IATA is 2 characters, ICAO 3, and both are scarce enough to be worth
     * enforcing per world (§24 flags ~1,300 usable IATA codes against an
     * unbounded player count). Name and callsign are deliberately *not* unique:
     * §22.6 treats those as a moderation matter, not a constraint violation.
     */
    iataCode: text('iata_code').notNull(),
    icaoCode: text('icao_code').notNull(),
    callsign: text('callsign').notNull(),

    /** ISO 3166-1 alpha-2. */
    baseCountry: text('base_country').notNull(),

    /**
     * Cash in **integer minor units** (cents), never a float — currency
     * arithmetic in binary floating point loses money in ways that are painful
     * to reconcile. `bigint` in `number` mode is exact to 2^53 minor units,
     * about 90 trillion, which is beyond any plausible balance.
     *
     * Which currency is still open: §24 lists it as design debt and M8-02
     * resolves it. Nothing here assumes one.
     *
     * Defaults to 0 rather than to a starting grant: the $500k start is a
     * balance number and belongs in config (CONTRIBUTING invariant 3).
     */
    cashMinor: bigint('cash_minor', { mode: 'number' }).notNull().default(0),

    /**
     * Compound reputation on the 0.00–1.00 scale used consistently across the
     * design doc (§15, App. A.3, F.4, E.6). New airlines start at 0.35; the
     * world median sits near 0.50.
     *
     * `numeric(3,2)` rather than a float so the stored value is exactly the
     * two-decimal figure the design specifies, and cannot drift to 1.0000001
     * and trip the range check.
     */
    reputation: numeric('reputation', { precision: 3, scale: 2 }).notNull().default('0.35'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('airline_world_id_iata_code_key').on(t.worldId, t.iataCode),
    unique('airline_world_id_icao_code_key').on(t.worldId, t.icaoCode),
    // One airline per player per world.
    unique('airline_world_id_player_id_key').on(t.worldId, t.playerId),
    index('airline_world_id_idx').on(t.worldId),
    index('airline_player_id_idx').on(t.playerId),
    check('airline_reputation_range', sql`${t.reputation} >= 0 AND ${t.reputation} <= 1`),
    check('airline_iata_code_format', sql`${t.iataCode} ~ '^[A-Z0-9]{2}$'`),
    check('airline_icao_code_format', sql`${t.icaoCode} ~ '^[A-Z]{3}$'`),
    check('airline_base_country_format', sql`${t.baseCountry} ~ '^[A-Z]{2}$'`),
    check('airline_cash_finite', sql`${t.cashMinor} > -9007199254740991`),
  ],
);

// ---------------------------------------------------------------------------
// Inferred types. `packages/shared` gets the zod schemas in M0-07; these are
// the database's own row shapes.
// ---------------------------------------------------------------------------

export type HealthRow = typeof health.$inferSelect;
export type NewHealthRow = typeof health.$inferInsert;

export type WorldRow = typeof world.$inferSelect;
export type NewWorldRow = typeof world.$inferInsert;

export type PlayerRow = typeof player.$inferSelect;
export type NewPlayerRow = typeof player.$inferInsert;

export type PlayerIdentityRow = typeof playerIdentity.$inferSelect;
export type NewPlayerIdentityRow = typeof playerIdentity.$inferInsert;

export type SessionRow = typeof session.$inferSelect;
export type NewSessionRow = typeof session.$inferInsert;

export type AirlineRow = typeof airline.$inferSelect;
export type NewAirlineRow = typeof airline.$inferInsert;
