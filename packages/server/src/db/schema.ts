import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  doublePrecision,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  serial,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import type { AirlineLogo } from '@tailfin/shared';

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
     * The world's randomness (M2-08).
     *
     * Every non-deterministic outcome in a world — which flights are disrupted
     * and why, and in time which airframes break and which used aircraft appear
     * on the market — is derived from this value together with the identity of
     * the thing it happens to. Replaying a world with the same seed reproduces
     * it exactly, which is what M13-01's harness and M13-02's economy regression
     * suite both rest on.
     *
     * A **column rather than a derivation** from something already here, and the
     * two obvious shortcuts are both wrong. `id` alone would make an admin reset
     * replay the identical run of bad weather, which is not a fresh world. And
     * `launch_date` is re-anchored on every speed change (see `admin/speed.ts`),
     * so folding it in would re-roll every pending disruption the moment somebody
     * moved the clock — a silent, invisible re-randomisation of the future.
     *
     * Re-rolled on reset, alongside `launch_date`, because ADR-0005's reset is a
     * new world in an old shell and should not know what the last one suffered.
     *
     * The database default is what makes this addable to a table that already
     * has worlds in it: `ADD COLUMN … NOT NULL` with no default fails outright
     * against existing rows, and there is a flagship world in production. Every
     * world that predates M2-08 therefore gets its own seed on migration rather
     * than sharing one — which matters, because a shared seed would correlate
     * two worlds' disruptions for ever.
     */
    seed: text('seed')
      .notNull()
      .default(sql`gen_random_uuid()::text`),

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
  /**
   * The player's chosen display currency (M8-02, an ISO-4217 code). **Nullable,
   * and null means the default `USD`** — so a migration bakes in no default and a
   * world reset that clears it restores the default. Purely a display preference:
   * all money stays USD minor units. The code is validated against
   * `SUPPORTED_CURRENCIES` at the write boundary, not by a database constraint.
   */
  displayCurrency: text('display_currency'),
  /** Set when personal identity is removed while the world-history anchor remains (§22.10). */
  anonymizedAt: timestamp('anonymized_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Live FX rates for display currencies (M8-02).
 *
 * One row per supported ISO-4217 code, carrying its rate against USD. **This
 * table is mutable by design** — it is unlike `economy_config` and
 * `aircraft_type`, which are immutable, seed-if-absent and never updated. This
 * one is seed-if-absent *and* refreshed nightly by the worker, because a display
 * rate is meant to track the real world. Do not "fix" it to match the immutable
 * tables.
 *
 * Money never lives here: `rate_e6` is a **ratio** (rate × 1,000,000 vs USD, so
 * USD is exactly 1,000,000), stored as an integer for determinism rather than
 * because it is money. Conversion happens only at the client's render boundary.
 */
export const currencyRate = pgTable('currency_rate', {
  /** ISO-4217 code, e.g. `EUR`. Primary key — one rate per currency. */
  code: text('code').primaryKey(),
  /** Rate × 1,000,000 vs USD. The USD row is exactly 1,000,000. */
  rateE6: bigint('rate_e6', { mode: 'number' }).notNull(),
  /** Where this rate came from: the seed baseline, or the FX provider host. */
  source: text('source').notNull(),
  /** When the worker (or the seed) last wrote this rate. */
  refreshedAt: timestamp('refreshed_at', { withTimezone: true }).notNull().defaultNow(),
});
export type CurrencyRateRow = typeof currencyRate.$inferSelect;

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
    /** Absolute expiry. Checked in the lookup query on every request. */
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('session_token_hash_key').on(t.tokenHash),
    index('session_player_id_idx').on(t.playerId),
    // Supports expiry/retention inspection without affecting request correctness.
    index('session_expires_at_idx').on(t.expiresAt),
    check('session_token_hash_is_sha256', sql`length(${t.tokenHash}) = 64`),
    check('session_expires_after_creation', sql`${t.expiresAt} > ${t.createdAt}`),
  ],
);

/**
 * How a player can prove they own their account (AUTH-01).
 *
 * The original four shipped at once even though only `google` and `discord`
 * had code behind them, because extending a Postgres enum is a migration and
 * four one-value migrations would be three more chances to get an `ALTER TYPE`
 * wrong on a live database. An enum value nothing writes is inert; a missing
 * one blocks a deploy.
 *
 * `twitch` arrived later and did cost its own migration (0061) — which is the
 * price of the reasoning above rather than a refutation of it: the four were
 * batched because they were foreseen, and a fifth provider was not.
 *
 * `email` is the magic-link identity (AUTH-10) and `passkey` the WebAuthn one
 * (AUTH-15). Both are placeholders here on purpose: the `player_identity` row
 * is the *link*, so `passkey` needs a companion table for the credentials
 * themselves, and that table's shape belongs with the WebAuthn library that
 * will read it rather than guessed at now.
 */
export const authProvider = pgEnum('auth_provider', [
  'google',
  'discord',
  'twitch',
  'email',
  'passkey',
]);
export type AuthProviderName = (typeof authProvider.enumValues)[number];

/**
 * External identities that map onto a player.
 *
 * **A deliberate deviation from M0-06's wording**, which asks for
 * `player.external_auth_id`. ADR-0004 chose Google OAuth and requires the
 * account model to tolerate more than one identity per player, so that adding a
 * second provider is not a migration over live accounts. One extra table now
 * instead of that later.
 *
 * The key is the provider's stable subject claim — Google's `sub`, Discord's
 * `id` — and never the email address. People change email addresses, and
 * matching accounts on email is how account-takeover bugs happen. AUTH-04 makes
 * that a rule rather than a habit: a provider reporting an address another
 * account already uses changes nothing at all.
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
    /**
     * When this identity last completed an authentication (AUTH-01).
     *
     * **Nullable, and null means never used** — not "used at the epoch". An
     * identity a player linked and has not signed in with yet has honestly
     * never been used, and that is exactly what the account page (AUTH-18) and
     * the last-method guard (AUTH-03) need to be able to say. A `defaultNow()`
     * here would have every identity claim it was used the moment it was
     * created, which is the same class of lie as a zeroed
     * `airframe.maintenance_state`.
     */
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    /**
     * Set on every write to the row, unlike `lastUsedAt` which tracks
     * *authentications*. The two diverge: renaming a passkey touches this and
     * not that, and signing in touches both.
     */
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('player_identity_provider_subject_key').on(t.provider, t.subject),
    index('player_identity_player_id_idx').on(t.playerId),
  ],
);

// ---------------------------------------------------------------------------
// airline — a player's presence in one world.
// ---------------------------------------------------------------------------

export const airlineStatus = pgEnum('airline_status', ['active', 'restricted', 'ceased']);

/**
 * Who runs an airline (M3-12).
 *
 * NPC carriers are **the same kind of thing as player airlines**, in the same
 * table, under the same constraints, resolved by the same demand model. That is
 * not tidiness — it is the acceptance criterion. A separate `npc_carrier` table
 * would need its own routes, its own fares and its own settlement, and the
 * first divergence between the two would be a competitor playing a different
 * game from the player it is competing with.
 */
export const airlineKind = pgEnum('airline_kind', ['player', 'npc']);

/**
 * What kind of airline an NPC is pretending to be (M3-12, §24).
 *
 * Four archetypes, because §24 names four and because they are the ones that
 * produce visibly different behaviour in App. A.3's logit: a flag carrier and
 * a low-cost carrier competing on the same pair should lose to each other in
 * different segments, which is the whole point of the segmented model.
 */
export const npcArchetype = pgEnum('npc_archetype', ['flag', 'lcc', 'regional', 'charter']);
export type AirlineStatus = (typeof airlineStatus.enumValues)[number];

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
    playerId: uuid('player_id').references(() => player.id, { onDelete: 'restrict' }),

    /**
     * Player-run or NPC (M3-12). Defaults to `player`, which is what every row
     * that predates this column is.
     */
    kind: airlineKind('kind').notNull().default('player'),

    /** Null for a player airline. Set for every NPC, and the basis of its behaviour. */
    archetype: npcArchetype('archetype'),

    /** Unicode/category policy lives in the shared AIR-02 schema; checks below defend direct writes. */
    name: text('name').notNull(),

    /**
     * IATA is 2 characters, ICAO 3, and both are scarce enough to be worth
     * enforcing per world (§24 flags ~1,300 usable IATA codes against an
     * unbounded player count). Name and callsign are deliberately *not* unique:
     * §22.6 treats those as a moderation matter, not a uniqueness constraint.
     * Their deterministic AIR-02 format checks are still enforced below.
     */
    iataCode: text('iata_code').notNull(),
    icaoCode: text('icao_code').notNull(),
    callsign: text('callsign').notNull(),

    /** ISO 3166-1 alpha-2. */
    baseCountry: text('base_country').notNull(),

    /**
     * The brand emblem — a small procedural `AirlineLogo` spec (§15/§16), or null
     * for an airline that has never set one, in which case the client shows a
     * default derived from the code. jsonb because it is a structured value, not
     * text; nothing queries inside it, but jsonb lets the identity-change check
     * compare two logos with `IS DISTINCT FROM`.
     */
    logo: jsonb('logo').$type<AirlineLogo>(),

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

    /** AIR-09 lifecycle; cessation retains the row as immutable world history. */
    status: airlineStatus('status').notNull().default('active'),
    /** Real time at which `status` most recently changed. */
    statusChangedAt: timestamp('status_changed_at', { withTimezone: true }).notNull().defaultNow(),
    /** Present only for terminal cessation; codes are reusable from this instant. */
    ceasedAt: timestamp('ceased_at', { withTimezone: true }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Ceased rows retain their historical designators, while the live namespace
    // can allocate those scarce codes again (ADR-0018).
    uniqueIndex('airline_world_id_iata_code_key')
      .on(t.worldId, t.iataCode)
      .where(sql`${t.status} <> 'ceased'`),
    uniqueIndex('airline_world_id_icao_code_key')
      .on(t.worldId, t.icaoCode)
      .where(sql`${t.status} <> 'ceased'`),
    // One airline per player per world. NPCs are unaffected: Postgres treats
    // NULLs as distinct in a unique constraint, so any number of NPC rows can
    // share a null player without colliding — which is the behaviour wanted
    // here and is worth stating, because it is the opposite of what a reader
    // expects a unique constraint to do.
    unique('airline_world_id_player_id_key').on(t.worldId, t.playerId),
    index('airline_world_id_idx').on(t.worldId),
    index('airline_player_id_idx').on(t.playerId),
    check('airline_reputation_range', sql`${t.reputation} >= 0 AND ${t.reputation} <= 1`),
    check('airline_iata_code_format', sql`${t.iataCode} ~ '^[A-Z0-9]{2}$'`),
    check('airline_icao_code_format', sql`${t.icaoCode} ~ '^[A-Z]{3}$'`),
    check('airline_name_length', sql`char_length(${t.name}) BETWEEN 1 AND 120`),
    check(
      'airline_name_structure',
      sql`${t.name} = btrim(${t.name}) AND position('  ' in ${t.name}) = 0 AND ${t.name} !~ '[[:cntrl:]]'`,
    ),
    check(
      'airline_callsign_format',
      sql`char_length(${t.callsign}) BETWEEN 2 AND 32 AND ${t.callsign} ~ '^[A-Z0-9]+( [A-Z0-9]+)*$' AND ${t.callsign} ~ '[A-Z]'`,
    ),
    check('airline_base_country_format', sql`${t.baseCountry} ~ '^[A-Z]{2}$'`),
    check(
      'airline_cash_safe_integer',
      sql`${t.cashMinor} >= -9007199254740991 AND ${t.cashMinor} <= 9007199254740991`,
    ),
    check(
      'airline_ceased_at_matches_status',
      sql`(${t.status} = 'ceased' AND ${t.ceasedAt} IS NOT NULL)
          OR (${t.status} <> 'ceased' AND ${t.ceasedAt} IS NULL)`,
    ),
    /**
     * A player airline has a player and no archetype; an NPC has an archetype
     * and no player (M3-12).
     *
     * Enforced here rather than trusted to the seeding job, because the whole
     * value of putting NPCs in the `airline` table is that they cannot drift
     * into being a different kind of object. A player row that lost its player,
     * or an NPC that acquired one, would break `resolvePlayerAirline` and the
     * founding player-cap count in ways that are hard to trace back.
     */
    check(
      'airline_kind_matches_operator',
      sql`(${t.kind} = 'player' AND ${t.playerId} IS NOT NULL AND ${t.archetype} IS NULL)
          OR (${t.kind} = 'npc' AND ${t.playerId} IS NULL AND ${t.archetype} IS NOT NULL)`,
    ),
  ],
);

// ---------------------------------------------------------------------------
// airline_status_transition — immutable lifecycle history (AIR-09)
// ---------------------------------------------------------------------------

/**
 * One recorded lifecycle transition. The current status remains on `airline`
 * for fast permission and leaderboard predicates; this table explains how it
 * got there and is retained with the airline's operational record.
 */
export const airlineStatusTransition = pgTable(
  'airline_status_transition',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    airlineId: uuid('airline_id')
      .notNull()
      .references(() => airline.id, { onDelete: 'cascade' }),
    fromStatus: airlineStatus('from_status').notNull(),
    toStatus: airlineStatus('to_status').notNull(),
    reason: text('reason').notNull(),
    /** Game time at which the transition took effect in this world. */
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    /** Real time at which the transition committed. */
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('airline_status_transition_airline_id_occurred_at_idx').on(t.airlineId, t.occurredAt),
    check('airline_status_transition_changes_status', sql`${t.fromStatus} <> ${t.toStatus}`),
    check(
      'airline_status_transition_reason_not_blank',
      sql`char_length(${t.reason}) > 0 AND ${t.reason} = btrim(${t.reason})`,
    ),
  ],
);

export type AirlineStatusTransitionRow = typeof airlineStatusTransition.$inferSelect;
export type NewAirlineStatusTransitionRow = typeof airlineStatusTransition.$inferInsert;

// ---------------------------------------------------------------------------
// cash_movement — the authoritative explanation for airline.cash_minor (AIR-06)
// ---------------------------------------------------------------------------

/**
 * Deliberately narrow. M8-01 adds P&L categories and entity dimensions; these
 * are the balance-changing causes that exist now and can therefore be honest.
 */
export const cashMovementCause = pgEnum('cash_movement_cause', [
  'airline_founding',
  'airline_rebrand',
  'aircraft_lease_deposit',
  'aircraft_used_purchase',
  'aircraft_new_purchase',
  'maintenance_check',
  'crew_base_opening',
  'crew_hiring',
  'crew_conversion',
  'crew_payroll',
  'crew_base_overhead',
  'crew_positioning',
  'office_salary',
  'office_expansion',
  'executive_floor',
  'executive_office',
  'hub_purchase',
  'hub_facility_opening',
  'hub_upkeep',
  /** §9.3's *"breaking one early costs a penalty"*, pro-rated to what is left of the term. */
  'ground_contract_penalty',
  /** The committed departures a term ended without flying (§9.3). */
  'ground_volume_shortfall',
  /** Monthly payroll for a station the airline handles itself (§9.3). */
  'ground_self_handling_payroll',
  /** §10.1's capital: a training academy level, or a module inside one (M9-01). */
  'academy_construction',
  /** What the buildings cost every month once they are teaching (§10.1). */
  'academy_upkeep',
  'admin_adjustment',
  'flight_settlement',
  'disruption_cost',
  'migration_opening_balance',
  /** §13.3: cash in, when a loan is drawn. */
  'loan_draw',
  /** §13.4's per-game-day drain, and the arrears it leaves when cash is short. */
  'loan_interest',
]);
export type CashMovementCause = (typeof cashMovementCause.enumValues)[number];

/**
 * The stable accounting vocabulary used by M8-01.  Categories are deliberately
 * narrower than causes: one cause can produce several lines (a flight is the
 * important example), while the category is what a P&L groups.
 */
export const ledgerCategory = pgEnum('ledger_category', [
  'opening_balance',
  'equity',
  'ticket',
  'ancillary',
  'cargo',
  'charter',
  'acmi',
  'fuel',
  'lease_finance',
  'crew',
  'office_salary',
  'maintenance',
  'airport_slot',
  'atc',
  'ground_handling',
  'marketing',
  'repaint_retrofit',
  'interest',
  'aircraft_purchase',
  'asset_deposit',
  /** §13.3's loan principal arriving — neither revenue nor cost (M8-06). */
  'debt_draw',
  /** Buying a hub, or building a facility at one — capital, like `aircraft_purchase` (M7-04). */
  'hub_purchase',
  /** App. B.5's recurring hub and facility fees — operating cost, unlike the above (M7-04). */
  'hub_facility',
  'other',
]);
export type LedgerCategory = (typeof ledgerCategory.enumValues)[number];

/**
 * One immutable row for every change to an airline's game balance.
 *
 * `cause + reference` is the logical identity of a movement. A flight id, for
 * example, can settle once even if an event is replayed or two workers race.
 * `balance_after_minor` makes the fold checkable against `airline.cash_minor`
 * rather than leaving drift silent.
 *
 * This is in-game currency only. ADR-0006 keeps commerce money in different
 * tables, types and helpers.
 */
export const cashMovement = pgTable(
  'cash_movement',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    airlineId: uuid('airline_id')
      .notNull()
      .references(() => airline.id, { onDelete: 'cascade' }),

    amountMinor: bigint('amount_minor', { mode: 'number' }).notNull(),
    cause: cashMovementCause('cause').notNull(),
    /** Stable id of the thing that caused this movement, stored generically for later domains. */
    reference: text('reference').notNull(),
    balanceAfterMinor: bigint('balance_after_minor', { mode: 'number' }).notNull(),

    /**
     * When this movement happened **in the owning airline's world** (TIME-02).
     *
     * Game time for every cause. It was game time only for the simulation ones
     * until migration 0051: founding, the executive floor and its offices,
     * headquarters expansion, operator adjustments and 0019's opening-balance
     * backfill all used the wall clock, so one sorted account held two calendars
     * and a date-ranged query returned a set that depended on which kind of row
     * it caught. `recorded_at` below is the row's wall-clock audit stamp and is
     * the only real instant on this table.
     */
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    /** Real time the row reached the ledger, useful when delayed processing is diagnosed. */
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('cash_movement_cause_reference_key').on(t.cause, t.reference),
    index('cash_movement_airline_id_occurred_at_idx').on(t.airlineId, t.occurredAt),
    check(
      'cash_movement_amount_safe_integer',
      sql`${t.amountMinor} >= -9007199254740991 AND ${t.amountMinor} <= 9007199254740991`,
    ),
    check(
      'cash_movement_balance_safe_integer',
      sql`${t.balanceAfterMinor} >= -9007199254740991 AND ${t.balanceAfterMinor} <= 9007199254740991`,
    ),
    check(
      'cash_movement_reference_not_blank',
      sql`char_length(${t.reference}) > 0 AND ${t.reference} = btrim(${t.reference})`,
    ),
  ],
);

// ---------------------------------------------------------------------------
// ledger_entry — immutable, attributable P&L lines (M8-01)
// ---------------------------------------------------------------------------

/**
 * One or more lines explain one cash movement.  A cash movement remains the
 * balance-control record owned by AIR-06; this table is the dimensional
 * accounting projection used by finance.  The deferred reconciliation trigger
 * in migration 0036 requires the line total for an airline to equal its cash
 * balance, so a P&L cannot silently diverge from the purse.
 *
 * Optional dimension ids are intentionally UUIDs without foreign keys. Flights
 * outlive schedules and future domains may retain financial history after an
 * operational row is archived; the owning domain is responsible for resolving
 * those ids at drill-down time.
 */
export const ledgerEntry = pgTable(
  'ledger_entry',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    worldId: uuid('world_id')
      .notNull()
      .references(() => world.id, { onDelete: 'cascade' }),
    airlineId: uuid('airline_id')
      .notNull()
      .references(() => airline.id, { onDelete: 'cascade' }),
    cashMovementId: uuid('cash_movement_id')
      .notNull()
      .references(() => cashMovement.id, { onDelete: 'cascade' }),
    lineNumber: integer('line_number').notNull(),
    amountMinor: bigint('amount_minor', { mode: 'number' }).notNull(),
    category: ledgerCategory('category').notNull(),
    counterparty: text('counterparty').notNull().default('system'),
    flightId: uuid('flight_id'),
    routeId: uuid('route_id'),
    aircraftId: uuid('aircraft_id'),
    hubId: uuid('hub_id'),
    cabinClass: text('cabin_class'),
    /**
     * Copied from the movement this line belongs to, so it carries the same game
     * instant (TIME-02). Three indexes sort on it, which is why the domain has to
     * be one thing: a P&L window that mixed calendars would silently include and
     * exclude rows by cause.
     */
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    /** The row's wall-clock audit stamp. Not the same question as `occurred_at`. */
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('ledger_entry_movement_line_key').on(t.cashMovementId, t.lineNumber),
    index('ledger_entry_airline_occurred_at_idx').on(t.airlineId, t.occurredAt),
    index('ledger_entry_airline_category_occurred_at_idx').on(
      t.airlineId,
      t.category,
      t.occurredAt,
    ),
    index('ledger_entry_route_occurred_at_idx').on(t.airlineId, t.routeId, t.occurredAt),
    index('ledger_entry_aircraft_occurred_at_idx').on(t.airlineId, t.aircraftId, t.occurredAt),
    index('ledger_entry_hub_occurred_at_idx').on(t.airlineId, t.hubId, t.occurredAt),
    check(
      'ledger_entry_amount_safe_integer',
      sql`${t.amountMinor} >= -9007199254740991 AND ${t.amountMinor} <= 9007199254740991`,
    ),
    check('ledger_entry_line_number_positive', sql`${t.lineNumber} > 0`),
    check(
      'ledger_entry_counterparty_not_blank',
      sql`char_length(${t.counterparty}) > 0 AND ${t.counterparty} = btrim(${t.counterparty})`,
    ),
    check(
      'ledger_entry_cabin_class_valid',
      sql`${t.cabinClass} IS NULL OR ${t.cabinClass} IN ('economy', 'premium_economy', 'business', 'first')`,
    ),
  ],
);

// ---------------------------------------------------------------------------
// airline_identity_change — paid player rebrand events (AIR-08, §15)
// ---------------------------------------------------------------------------

/**
 * One ordinary player rebrand, retained independently of the current airline
 * label. Operational rows keep resolving the stable airline UUID to its current
 * identity (ADR-0007); this event is the honest history of how that identity
 * changed and the cash movement references its id.
 */
export const airlineIdentityChange = pgTable(
  'airline_identity_change',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    airlineId: uuid('airline_id')
      .notNull()
      .references(() => airline.id, { onDelete: 'cascade' }),

    beforeName: text('before_name').notNull(),
    afterName: text('after_name').notNull(),
    beforeCallsign: text('before_callsign').notNull(),
    afterCallsign: text('after_callsign').notNull(),
    beforeBaseCountry: text('before_base_country').notNull(),
    afterBaseCountry: text('after_base_country').notNull(),

    /** The brand emblem before and after; null where the airline had/keeps no logo. */
    beforeLogo: jsonb('before_logo').$type<AirlineLogo>(),
    afterLogo: jsonb('after_logo').$type<AirlineLogo>(),

    costMinor: bigint('cost_minor', { mode: 'number' }).notNull(),
    /** Game time when the rebrand took effect. */
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    /** Real database time, retained for support and delayed-processing diagnosis. */
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('airline_identity_change_airline_id_occurred_at_idx').on(t.airlineId, t.occurredAt),
    check('airline_identity_change_cost_positive', sql`${t.costMinor} > 0`),
    check(
      'airline_identity_change_changes_something',
      sql`${t.beforeName} <> ${t.afterName}
          OR ${t.beforeCallsign} <> ${t.afterCallsign}
          OR ${t.beforeBaseCountry} <> ${t.afterBaseCountry}
          OR ${t.beforeLogo} IS DISTINCT FROM ${t.afterLogo}`,
    ),
  ],
);

export type AirlineIdentityChangeRow = typeof airlineIdentityChange.$inferSelect;
export type NewAirlineIdentityChangeRow = typeof airlineIdentityChange.$inferInsert;

// ---------------------------------------------------------------------------
// Reference data — global, not per world (M1-01).
//
// Airports are the same geography in every world. Era worlds (§19.2, App. B.1)
// filter this set by opening and closing date rather than owning a copy of it,
// so there is one row per real aerodrome and worlds hold a view over it. A
// per-world copy of 85,000 airports per world would be the obvious alternative
// and it would be wrong: the geography does not vary, only which of it counts.
// ---------------------------------------------------------------------------

/**
 * Which dataset version is loaded, and when.
 *
 * Required by M1-01, and it is the same discipline as `world.aircraft_catalogue_version`
 * (§22.2, §22.5): a running world must be able to say which data it was built on.
 * OurAirports publishes no version number, so the SHA-256 of the files *is* the
 * version — two imports with the same checksum are the same data whatever the
 * date on them.
 */
export const datasetVersion = pgTable(
  'dataset_version',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    dataset: text('dataset').notNull(),
    /** Upstream's own label where it has one — here, the HTTP Last-Modified date. */
    version: text('version').notNull(),
    sourceUrl: text('source_url').notNull(),
    /** Hex SHA-256 over the source files, in a fixed order. The real identity. */
    checksum: text('checksum').notNull(),
    /** What landed, so a later import can be compared against it without recounting. */
    rowCounts: text('row_counts').notNull(),
    importedAt: timestamp('imported_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // The same bytes may only be recorded once per dataset, which is what makes
    // a re-run a no-op rather than a duplicate history entry.
    unique('dataset_version_dataset_checksum_key').on(t.dataset, t.checksum),
    index('dataset_version_dataset_imported_at_idx').on(t.dataset, t.importedAt),
    check('dataset_version_checksum_is_sha256', sql`length(${t.checksum}) = 64`),
  ],
);

/**
 * App. B.3's five tiers. Nullable on `airport`: B.3's counts sum to ~4,045,
 * which is the scheduled-service subset, not all 86,000 aerodromes. An airstrip
 * with no airline service has no tier because it has no demand pool to size.
 */
export const airportTier = pgEnum('airport_tier', [
  'flagship',
  'large',
  'medium',
  'small',
  'regional',
]);

/** OurAirports' own `type` column, carried through rather than reinterpreted. */
export const airportKind = pgEnum('airport_kind', [
  'large_airport',
  'medium_airport',
  'small_airport',
  'heliport',
  'seaplane_base',
  'balloonport',
  'closed',
]);

/**
 * Every aerodrome in the world (App. B.1).
 *
 * The key is `ident`, not ICAO: only about 12% of rows carry an official ICAO
 * code, while `ident` is present and unique on all of them. See the note in
 * `@tailfin/shared`'s `airport.ts` for the full reconciliation against B.2.
 *
 * Tier, slot level, catchment, capacity, fees, curfew and constraints are all
 * absent on purpose — M1-02 and M1-03 add them. Columns nothing fills yet would
 * be indistinguishable from columns something failed to fill.
 */
export const airport = pgTable(
  'airport',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    /** OurAirports' row id. Kept so a row can be traced back to the source file. */
    sourceId: integer('source_id').notNull(),

    ident: text('ident').notNull(),
    icaoCode: text('icao_code'),
    iataCode: text('iata_code'),

    name: text('name').notNull(),
    municipality: text('municipality'),
    /** ISO 3166-1 alpha-2. */
    isoCountry: text('iso_country').notNull(),
    /** ISO 3166-2, e.g. `US-CA`. */
    isoRegion: text('iso_region'),
    continent: text('continent'),

    kind: airportKind('kind').notNull(),

    /**
     * `double precision`, not `numeric`.
     *
     * Every great-circle formula (M1-04) consumes doubles, so storing an exact
     * decimal would mean converting on every read for no gain. This is not the
     * money case: there is no exact decimal answer being preserved, and a
     * position is a measurement rather than a quantity that must balance.
     */
    latitude: doublePrecision('latitude').notNull(),
    longitude: doublePrecision('longitude').notNull(),

    /** Null means unknown, never sea level — it feeds takeoff length in B.4. */
    elevationFt: integer('elevation_ft'),

    /** Upstream's flag for "airline service exists here". ~4,400 of ~86,000. */
    scheduledService: boolean('scheduled_service').notNull(),

    /**
     * Whether the source has any runway rows for this airport.
     *
     * Explicit rather than derived, because "no runways in the table" and "we
     * were never told about the runways" mean very different things to a
     * reachability check — and 308 scheduled-service airports are in the second
     * case. A count-based derivation cannot tell them apart.
     */
    hasRunwayData: boolean('has_runway_data').notNull(),

    /**
     * Tier (M1-02). NULL for anything without scheduled service — see the enum.
     */
    tier: airportTier('tier'),

    /**
     * IATA slot designation: 1 free, 2 schedules-facilitated, 3 coordinated.
     * NULL means no coordination at all, which is where regional airports sit.
     */
    slotLevel: integer('slot_level'),

    /**
     * Why this airport got its tier, as JSON.
     *
     * M1-02 requires the classification inputs to be stored "so a human can
     * audit why an airport got its tier". Storing the *rule that fired* plus the
     * numbers it fired on means a surprising tier can be explained without
     * re-deriving it, and means changing the thresholds later produces a visible
     * diff rather than a silent reshuffle.
     */
    tierBasis: text('tier_basis'),

    classifiedAt: timestamp('classified_at', { withTimezone: true }),

    /**
     * Timezone (M3-04a) — what the local clock reads at this airport.
     *
     * A.3's `SchedFit` is a curve over **local** departure time, and until this
     * existed the only way to get one was longitude ÷ 15, which puts mainland
     * Spain in the Canaries' zone and cannot express India's half-hour offset.
     *
     * `utc_offset_minutes` is **standard time**, deliberately not daylight
     * saving: `schedule_leg.departure_minute` is fixed in absolute time, so a
     * DST-aware offset would slide a player's departure an hour along the
     * SchedFit curve twice a year without them touching anything. See
     * `data/timezone/offset.ts`.
     *
     * Minutes rather than hours because Kolkata is +330, Kathmandu +345 and
     * Chatham +765. An hours column would have been wrong for a tenth of the
     * world on the day it was written.
     *
     * `timezone` is NULL only where resolution fell through to the longitude
     * approximation; the offset never is. `timezone_basis` says which happened,
     * the same discipline as `tier_basis` — an offset decided by a city 8 km
     * away is a different quality of answer from one decided by a band of
     * longitude, and §14.1 says a figure has to be able to explain itself.
     */
    timezone: text('timezone'),
    utcOffsetMinutes: integer('utc_offset_minutes'),
    timezoneBasis: text('timezone_basis'),

    /**
     * Catchment (M1-03) — the four numbers App. A.2's gravity model consumes.
     *
     * `D_base = k · (Pop_o · Wealth_o · Pop_d · Wealth_d)^α · f(distance) · Affinity_od`
     *
     * Population is people, already split between the airports of a multi-airport
     * city so a metro is not counted twice. The three indices are **normalised
     * multipliers with a world median of 1.0**, not raw quantities: A.2 multiplies
     * them, so a value is only meaningful relative to everywhere else. Storing raw
     * GDP per capita would make the same formula produce wildly different numbers
     * the moment the source changed units.
     *
     * NULL only where an airport has no scheduled service — the same rule as
     * `tier`, for the same reason: no service, no demand pool to size.
     */
    catchmentPopulation: bigint('catchment_population', { mode: 'number' }),
    wealthIndex: numeric('wealth_index', { precision: 6, scale: 4 }),
    tourismIndex: numeric('tourism_index', { precision: 6, scale: 4 }),
    businessIndex: numeric('business_index', { precision: 6, scale: 4 }),

    /** How the four numbers were arrived at, as JSON. Same audit contract as `tier_basis`. */
    /**
     * Proximity connection boost — a multiplier on usage, 1.0 for an isolated
     * airport and up to ~1.24 for one with several neighbours within 15 km.
     *
     * Clamped so a boosted airport can never overtake the tier above it: a
     * regional field beside two medium airports is a better regional field, not
     * a medium airport. See data/catchment/connectivity.ts.
     */
    connectivityIndex: numeric('connectivity_index', { precision: 6, scale: 4 }),

    catchmentBasis: text('catchment_basis'),
    catchmentAt: timestamp('catchment_at', { withTimezone: true }),

    /**
     * How hard this field is to fly into, 0-1 (M9-02, §10.2).
     *
     * §10.2's crew XP difficulty multiplier reads it, and nothing else does
     * yet. **Null means never rated**, not easy — the same distinction
     * `crew_base.morale` draws between *never reviewed* and *nothing*, and for
     * the same reason: a world whose `data:difficulty` job has not run must not
     * quietly pay flat XP everywhere while looking correctly configured.
     * `xpFor` treats null as 0 and the Crew page can say which it is.
     *
     * Two of §10.2's four terms — short runway, high elevation — are derived
     * from columns already on this table; slope and terrain are seeded from
     * `data/reference/airport-difficulty.csv`, because OurAirports carries
     * neither. The stored value is `max(derived, seeded)`.
     *
     * A rating, not a rate. What a difficulty point is *worth* is
     * `EconomyConfig.crew.xp` — so a world can pay hard flying better without
     * re-rating its geography, and a crew pool's history can say which of the
     * two moved.
     */
    difficulty: doublePrecision('difficulty'),
    /** Which terms fired and what they scored, as JSON. Same audit contract as `tier_basis`. */
    difficultyBasis: text('difficulty_basis'),
    difficultyRatedAt: timestamp('difficulty_rated_at', { withTimezone: true }),

    importedAt: timestamp('imported_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('airport_ident_key').on(t.ident),
    unique('airport_source_id_key').on(t.sourceId),
    // Partial uniqueness: thousands of rows have no code, and NULLs do not
    // collide in Postgres, so a plain unique index is already correct here.
    unique('airport_icao_code_key').on(t.icaoCode),
    unique('airport_iata_code_key').on(t.iataCode),
    index('airport_iso_country_idx').on(t.isoCountry),
    index('airport_scheduled_service_idx').on(t.scheduledService),
    // The route picker's working set is scheduled-service airports by country.
    index('airport_kind_scheduled_service_idx').on(t.kind, t.scheduledService),
    check('airport_latitude_range', sql`${t.latitude} >= -90 AND ${t.latitude} <= 90`),
    check(
      'airport_difficulty_range',
      sql`${t.difficulty} IS NULL OR (${t.difficulty} >= 0 AND ${t.difficulty} <= 1)`,
    ),
    check('airport_longitude_range', sql`${t.longitude} >= -180 AND ${t.longitude} <= 180`),
    // Null Island is the canonical failed-geocode value; no aerodrome is there.
    check('airport_not_null_island', sql`NOT (${t.latitude} = 0 AND ${t.longitude} = 0)`),
    check(
      'airport_elevation_plausible',
      sql`${t.elevationFt} IS NULL OR (${t.elevationFt} >= -2000 AND ${t.elevationFt} <= 30000)`,
    ),
    check(
      'airport_icao_code_format',
      sql`${t.icaoCode} IS NULL OR ${t.icaoCode} ~ '^[A-Z0-9]{4}$'`,
    ),
    check(
      'airport_iata_code_format',
      sql`${t.iataCode} IS NULL OR ${t.iataCode} ~ '^[A-Z0-9]{3}$'`,
    ),
    check('airport_iso_country_format', sql`${t.isoCountry} ~ '^[A-Z]{2}$'`),
    // A tier is a statement about a demand pool, and only the scheduled-service
    // subset has one (App. B.1, B.3).
    check('airport_tier_needs_service', sql`${t.tier} IS NULL OR ${t.scheduledService}`),
    check(
      'airport_slot_level_range',
      sql`${t.slotLevel} IS NULL OR (${t.slotLevel} >= 1 AND ${t.slotLevel} <= 3)`,
    ),
    index('airport_tier_idx').on(t.tier),
    check(
      'airport_catchment_population_nonneg',
      sql`${t.catchmentPopulation} IS NULL OR ${t.catchmentPopulation} >= 0`,
    ),
    // Indices are multipliers around 1.0. A zero would silently annihilate a
    // whole city pair's demand, and a negative one is meaningless.
    check('airport_wealth_index_positive', sql`${t.wealthIndex} IS NULL OR ${t.wealthIndex} > 0`),
    check(
      'airport_tourism_index_positive',
      sql`${t.tourismIndex} IS NULL OR ${t.tourismIndex} > 0`,
    ),
    check(
      'airport_business_index_positive',
      sql`${t.businessIndex} IS NULL OR ${t.businessIndex} > 0`,
    ),
    // Never below 1: the boost only ever helps, and a value under 1 would mean a
    // well-connected airport had been penalised for it.
    check(
      'airport_connectivity_index_range',
      sql`${t.connectivityIndex} IS NULL OR (${t.connectivityIndex} >= 1 AND ${t.connectivityIndex} <= 4)`,
    ),
  ],
);

// ---------------------------------------------------------------------------
// airline_hub — airports at which an airline is based (AIR-01, App. B.5)
// ---------------------------------------------------------------------------

/**
 * App. B.5 prices four tiers; B.3 classifies airports into five.
 *
 * A separate enum from `airport_tier` rather than a reuse, because it is a
 * different thing: this is the **price band** a hub was sold in, and `regional`
 * has no price of its own. Keeping them separate means adding a sixth airport
 * tier cannot silently invent a sixth hub price.
 */
export const hubTier = pgEnum('hub_tier', ['small', 'medium', 'large', 'flagship']);

/**
 * Founding grants the first hub; M7-04 adds paid hubs and facilities.
 *
 * The relationship gets its own row rather than a single hub column on
 * `airline`, because an airline may own several hubs. The airport foreign key
 * is restrictive: reference-data refreshes must not erase a player's base.
 */
export const airlineHub = pgTable(
  'airline_hub',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    airlineId: uuid('airline_id')
      .notNull()
      .references(() => airline.id, { onDelete: 'cascade' }),
    airportId: uuid('airport_id')
      .notNull()
      .references(() => airport.id, { onDelete: 'restrict' }),
    /** Consumed from the world's starting-position config, so its zero cost is explainable. */
    founderGrant: boolean('founder_grant').notNull().default(false),

    /**
     * The price band this hub was sold in, pinned at purchase (M7-04).
     *
     * Not derived from `airport.tier` on read, and the difference is the point: a
     * reference-data refresh can reclassify an airport, and an airline's annual
     * fee must not change because somebody re-ran `data:classify`. The bill an
     * airline pays is the one it agreed to.
     *
     * **Nullable, meaning a hub granted before M7-04** — every existing founder
     * hub. Those read as their airport's current tier, which is the only answer
     * available and was true when they were granted. New rows always set it.
     */
    tier: hubTier('tier'),
    /** What was paid, minor units. Null alongside `tier`; zero for a founder grant. */
    purchaseCostMinor: bigint('purchase_cost_minor', { mode: 'number' }),
    /**
     * Game time the hub opened — the anchor the monthly fee is billed from.
     *
     * Game time rather than `created_at`'s wall clock, so a world reset moves it
     * with everything else (ADR-0005) and a world at 4x bills twice as often in
     * real time as one at 2x. Null on pre-M7-04 rows, which fall back to
     * `created_at`: an approximation, but the alternative is a hub that is never
     * billed, and free hubs would be a worse lie than a fee starting a few real
     * days early on dev data.
     */
    openedAt: timestamp('opened_at', { withTimezone: true }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('airline_hub_airline_id_airport_id_key').on(t.airlineId, t.airportId),
    index('airline_hub_airline_id_idx').on(t.airlineId),
    index('airline_hub_airport_id_idx').on(t.airportId),
  ],
);

/**
 * App. B.5's unlockables, minus the two `HubFacilityKind` explains are absent.
 *
 * `cargo_facility` is a deliberate omission rather than a forgotten one, and it
 * is **expected to arrive**: cargo was committed on 2026-09-07 and CARGO-10
 * (#1096) adds the terminal through this mechanism. Adding the value then is an
 * `ALTER TYPE … ADD VALUE`, which is expand-safe.
 */
export const hubFacilityKind = pgEnum('hub_facility_kind', [
  'training_academy',
  'maintenance_line',
  'heavy_check',
  'lounge',
  'self_handling',
]);

/**
 * One facility unlocked at one hub (M7-04, App. B.5).
 *
 * A row's existence *is* the unlock — there is no status column, because a
 * facility is not closed or reopened: App. B.5 gives an opening cost and an
 * annual fee and no way back, and a nullable `closed_at` would be a mechanic
 * nobody has designed sitting in the schema looking load-bearing.
 *
 * The prices are pinned here for the same reason `airline_hub.tier` is: a retune
 * of the economy config must not silently re-price a facility somebody already
 * bought, and a hub's monthly bill has to be explicable from its own rows.
 */
export const hubFacility = pgTable(
  'hub_facility',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    hubId: uuid('hub_id')
      .notNull()
      .references(() => airlineHub.id, { onDelete: 'cascade' }),
    kind: hubFacilityKind('kind').notNull(),

    /** What opening it cost, minor units — pinned, like the hub's own price. */
    openingCostMinor: bigint('opening_cost_minor', { mode: 'number' }).notNull(),
    /** What it adds to the hub's annual bill, minor units. Pinned for the same reason. */
    annualFeeMinor: bigint('annual_fee_minor', { mode: 'number' }).notNull(),

    /** Game time, like the hub's own `opened_at`. */
    openedAt: timestamp('opened_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('hub_facility_hub_id_kind_key').on(t.hubId, t.kind),
    index('hub_facility_hub_id_idx').on(t.hubId),
  ],
);

export const runwaySurface = pgEnum('runway_surface', [
  'asphalt',
  'concrete',
  'gravel',
  'grass',
  'water',
  'other',
]);

export const runway = pgTable(
  'runway',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sourceId: integer('source_id').notNull(),
    airportId: uuid('airport_id')
      .notNull()
      .references(() => airport.id, { onDelete: 'cascade' }),

    /** Both ends, e.g. `09/27` or `18L/36R`. */
    identifier: text('identifier').notNull(),

    /** Null where the source has none. 292 rows, plus 6 that claim zero or less. */
    lengthFt: integer('length_ft'),
    widthFt: integer('width_ft'),

    /**
     * The source's own spelling, kept alongside the normalised value.
     *
     * There are 664 distinct surface strings upstream, so the mapping in
     * `normalise.ts` is certainly incomplete. Keeping the raw text means a better
     * mapping can be applied later with a single UPDATE instead of a re-import.
     */
    surfaceRaw: text('surface_raw'),
    surface: runwaySurface('surface').notNull(),

    lighted: boolean('lighted').notNull(),
    /** A closed runway is still geography — it just cannot be planned onto. */
    closed: boolean('closed').notNull(),
  },
  (t) => [
    unique('runway_source_id_key').on(t.sourceId),
    index('runway_airport_id_idx').on(t.airportId),
    check('runway_length_positive', sql`${t.lengthFt} IS NULL OR ${t.lengthFt} > 0`),
    check('runway_width_positive', sql`${t.widthFt} IS NULL OR ${t.widthFt} > 0`),
  ],
);

// ---------------------------------------------------------------------------
// world_event — the scheduled event queue (M1-06, §21)
// ---------------------------------------------------------------------------

/** The transitions the tick loop drives. More arrive with M2. */
export const worldEventType = pgEnum('world_event_type', [
  'FLIGHT_DEPART',
  'FLIGHT_ARRIVE',
  'TURNAROUND_COMPLETE',
]);

/**
 * Where an event is in its life (M1-06, SCALE-05).
 *
 * `unsupported` exists because one state was being asked to mean two things.
 * *This event is broken* is a data problem an operator should investigate;
 * *this Worker cannot do this yet* is a deployment problem that resolves itself
 * when the handler ships. Both used to land in `failed`, which made handler
 * absence look terminal and made a rising `failed` count meaningless.
 *
 * `unsupported` is deliberately **not** `pending`: the claim predicate skips it,
 * so it cannot be reclaimed on every tick and starve the queue behind it. And
 * deliberately **not** terminal: nothing has happened to the event, and a Worker
 * that knows the type moves it back.
 */
export const worldEventStatus = pgEnum('world_event_status', [
  'pending',
  'done',
  'failed',
  'unsupported',
]);

/**
 * Scheduled events, in **game time**.
 *
 * §21: flight positions are computed rather than stored per tick, and discrete
 * transitions are driven by this queue rather than by polling every aircraft.
 * Polling 10,000 aircraft once a second to ask "have you landed yet" is the
 * design this exists to avoid.
 *
 * `fire_at` is a game-time instant, not a real one. That is what lets an event
 * survive a speed change or an admin reset with its meaning intact: "this flight
 * lands at 14:05 on 3 November in world time" stays true however the world's
 * clock is running. Converting to a real instant is `realTimeAtGameTime`'s job,
 * done at drain time.
 */
export const worldEvent = pgTable(
  'world_event',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    worldId: uuid('world_id')
      .notNull()
      .references(() => world.id, { onDelete: 'cascade' }),

    type: worldEventType('type').notNull(),
    /** Game-time instant this event becomes due. */
    fireAt: timestamp('fire_at', { withTimezone: true }).notNull(),
    payload: text('payload').notNull(),

    /**
     * The exactly-once guarantee.
     *
     * Unique per world, so scheduling the same logical event twice — after a
     * restart, a retry, or two workers racing — is refused by the database rather
     * than by application logic that has to be right every time. The acceptance
     * criterion asks for an idempotency key per event; this is it.
     */
    idempotencyKey: text('idempotency_key').notNull(),

    status: worldEventStatus('status').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp('processed_at', { withTimezone: true }),
  },
  (t) => [
    unique('world_event_world_id_idempotency_key').on(t.worldId, t.idempotencyKey),
    // The drain query is "pending events for this world at or before now, in
    // game-time order". This index is that query.
    index('world_event_due_idx').on(t.worldId, t.status, t.fireAt),
    check('world_event_attempts_nonneg', sql`${t.attempts} >= 0`),
    check(
      'world_event_processed_when_finished',
      /**
       * `processed_at` is set exactly when something finished the event.
       *
       * Written in terms of the **terminal** statuses rather than as
       * `status <> 'pending'`, which is what it used to say. Two reasons, and
       * both matter:
       *
       *   - `unsupported` has not been processed. Nothing ran, nothing decided
       *     anything, and stamping a time on it would be a lie that later made
       *     "when did this happen?" unanswerable.
       *   - Naming only values that already exist is what lets the enum gain
       *     `unsupported` and this constraint be rewritten **in the same
       *     migration transaction**. Postgres refuses to *use* a new enum value
       *     in the transaction that added it; it does not mind one being added
       *     and left alone. `deploy.sh` batches the whole pending set into one
       *     transaction, so a constraint mentioning the new value would fail
       *     the deploy at the migration step.
       */
      sql`(${t.status} IN ('done', 'failed')) = (${t.processedAt} IS NOT NULL)`,
    ),
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

export type CashMovementRow = typeof cashMovement.$inferSelect;
export type NewCashMovementRow = typeof cashMovement.$inferInsert;

export type LedgerEntryRow = typeof ledgerEntry.$inferSelect;
export type NewLedgerEntryRow = typeof ledgerEntry.$inferInsert;

export type AirlineHubRow = typeof airlineHub.$inferSelect;
export type NewAirlineHubRow = typeof airlineHub.$inferInsert;

export type DatasetVersionRow = typeof datasetVersion.$inferSelect;
export type NewDatasetVersionRow = typeof datasetVersion.$inferInsert;

export type AirportRow = typeof airport.$inferSelect;
export type NewAirportRow = typeof airport.$inferInsert;

export type WorldEventRow = typeof worldEvent.$inferSelect;
export type NewWorldEventRow = typeof worldEvent.$inferInsert;

export type RunwayRow = typeof runway.$inferSelect;
export type NewRunwayRow = typeof runway.$inferInsert;

// ---------------------------------------------------------------------------
// Admin console (M1A-01, §22)
// ---------------------------------------------------------------------------

/**
 * Who is an admin.
 *
 * A **grant table rather than a column on `player`**, for two reasons.
 *
 * The first is that a grant has provenance: who gave it and when. A boolean on
 * `player` records that someone is an admin but not how they came to be one,
 * and "how did this account get admin?" is the first question asked when
 * something has gone wrong.
 *
 * The second is containment. M1A-05 builds a player browser that selects from
 * `player`; an `is_admin` column there is one careless `select *` away from
 * telling every player who the admins are. Authorisation lives in its own table
 * so it cannot leak out of a query about identity.
 *
 * Presence of a row *is* the grant — revoking deletes it. The permanent record
 * of both lives in `admin_audit`, which cannot be edited.
 */
/**
 * The administrator roles §22.1 names (M11-01).
 *
 * The authority a role carries lives in `admin/capabilities.ts`, not here — this
 * is only how the choice is stored. `capabilities.test.ts` holds the two lists
 * to the same set, so a role added in one place and not the other fails a test
 * rather than silently granting nothing.
 */
export const adminRole = pgEnum('admin_role', [
  'support',
  'game_master',
  'economist',
  'world_admin',
  'super_admin',
]);
export type AdminRoleName = (typeof adminRole.enumValues)[number];

export const adminGrant = pgTable('admin_grant', {
  playerId: uuid('player_id')
    .primaryKey()
    .references(() => player.id, { onDelete: 'cascade' }),

  /**
   * What this administrator may do.
   *
   * Defaults to `super_admin` deliberately: every grant that existed before
   * roles did carried unrestricted access, and a migration that quietly demoted
   * the people holding the keys — possibly including the only account that can
   * grant anything — would be a lockout dressed as a security improvement.
   * Narrowing an existing grant is an explicit act, not a side effect of a deploy.
   */
  role: adminRole('role').notNull().default('super_admin'),
  /**
   * Null for the first admin.
   *
   * There is no admin to grant the first one, so it comes from the command line
   * (`admin-cli.ts`). Null is the honest record of that rather than a fiction
   * about who authorised it, and the audit row says `bootstrap` in as many words.
   */
  grantedByPlayerId: uuid('granted_by_player_id').references(() => player.id, {
    onDelete: 'set null',
  }),
  grantedAt: timestamp('granted_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Columns that must never become client-assignable by accident (SEC-06).
 *
 * The `satisfies` clauses derive every name from the Drizzle insert schemas:
 * renaming or removing a protected column therefore breaks typecheck here
 * instead of leaving a stale security checklist. Keep new authority,
 * ownership, identity, session and server-computed columns in this registry.
 */
export const SENSITIVE_REQUEST_FIELDS = {
  adminGrant: ['playerId'] satisfies readonly (keyof typeof adminGrant.$inferInsert)[],
  world: [
    'speedMultiplier',
    'launchDate',
    'epoch',
    'status',
  ] satisfies readonly (keyof typeof world.$inferInsert)[],
  airline: [
    'cashMinor',
    'reputation',
    'playerId',
    'worldId',
  ] satisfies readonly (keyof typeof airline.$inferInsert)[],
  playerIdentity: [
    'email',
    'subject',
    'playerId',
    // Server-computed, and load-bearing for AUTH-03's last-method guard: a
    // client that could post `lastUsedAt` could make a stale identity look
    // fresh, or an unused one look like the only way in.
    'lastUsedAt',
    'updatedAt',
  ] satisfies readonly (keyof typeof playerIdentity.$inferInsert)[],
  session: ['tokenHash', 'playerId'] satisfies readonly (keyof typeof session.$inferInsert)[],
} as const;

/** Authority-shaped inputs with no backing writable column are hostile too. */
export const VIRTUAL_PRIVILEGE_FIELDS = ['isAdmin', 'adminGrant'] as const;

/**
 * Financial facts are produced by the simulation and ledger, never accepted
 * from a player request (SEC-09). Some duplicate database columns above; the
 * remainder are response/API names with no writable column to derive from.
 */
export const SERVER_OWNED_FINANCIAL_FIELDS = [
  'cash',
  'cashMinor',
  'balanceMinor',
  'reputation',
  'amountMinor',
  'priceMinor',
  'chargedMinor',
  'monthlyLeaseRateMinor',
  'resultingCashMinor',
  'credits',
  'entitlements',
  'paymentStatus',
  'orderStatus',
] as const;

/**
 * The audit log. Append-only, enforced by the database.
 *
 * "No UPDATE or DELETE path in the application" would be a convention, and a
 * convention is exactly what fails on the day it matters. Migration 0008 adds a
 * trigger that raises on either, so an audit row cannot be altered by anything —
 * an ORM call, a migration, or a psql session — without first dropping a trigger,
 * which is itself a conspicuous act.
 *
 * Every mutating admin action writes one **inside the same transaction as the
 * change**. An audit row written afterwards is one that goes missing precisely
 * when the change was the one somebody wanted hidden.
 */
export const adminAudit = pgTable(
  'admin_audit',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
    /**
     * Who did it — **deliberately not a foreign key**.
     *
     * An audit row is a historical statement, not a live reference. A foreign
     * key would make the log's integrity depend on the lifecycle of the thing it
     * describes, and there are only two ways that can go: the log blocks the
     * deletion, or the deletion rewrites the log. `ON DELETE SET NULL` is the
     * second one, and it would also be an UPDATE against an append-only table —
     * the trigger below would refuse it, turning an unrelated deletion into a
     * baffling error.
     *
     * So the id is kept for joining while the account exists, and `actor_label`
     * carries the meaning for ever.
     */
    actorPlayerId: uuid('actor_player_id'),
    /** Denormalised so the entry stays legible after the account behind it is anonymised (§22.10). */
    actorLabel: text('actor_label').notNull(),
    action: text('action').notNull(),
    subjectType: text('subject_type').notNull(),
    subjectId: text('subject_id'),
    /** JSON text rather than jsonb: nothing queries inside these, and text needs no cast. */
    before: text('before'),
    after: text('after'),
    /** Fastify's request id, so a log line and an audit row can be tied together. */
    requestId: text('request_id'),
  },
  (t) => [index('admin_audit_at_idx').on(t.at)],
);

export type AdminGrantRow = typeof adminGrant.$inferSelect;
export type NewAdminGrantRow = typeof adminGrant.$inferInsert;

export type AdminAuditRow = typeof adminAudit.$inferSelect;
export type NewAdminAuditRow = typeof adminAudit.$inferInsert;

// ---------------------------------------------------------------------------
// Schedules and flights (M2-03, §8.2, App. F.3)
// ---------------------------------------------------------------------------

export const repeatKind = pgEnum('repeat_kind', ['daily', 'weekdays']);

/**
 * A repeating rotation.
 *
 * §8.2: "assign an aircraft to a rotation; the sim runs it continuously." The
 * legs live in `schedule_leg` because a rotation is an **ordered cycle**, and
 * order is a property the database should hold rather than one the application
 * has to remember.
 *
 * ## The one column with no foreign key
 *
 * `airframe_id` references nothing, because there is no `airframe` table yet —
 * that is M4-01. Every other reference in this schema is enforced, and this is a
 * deliberate exception rather than a lapse: a schedule without an aircraft is
 * meaningless, so the column is `not null`, but nothing can check that it points
 * at a real aeroplane until the fleet exists. **M4-01 adds
 * `references(airframe.id, { onDelete: 'cascade' })` here**, and until then the
 * service layer is the only thing standing behind it.
 */
/**
 * A route an airline sells, and what it charges (M2-01's deferred entity, M3-09).
 *
 * `schedule_leg` has carried a note since M2-03 saying this was coming and what
 * it would own: *"when a `route` table does land, a `route_id` column joins
 * these rather than replacing them: fares belong to the route, geography to the
 * leg."* This is that table, added because M3-09 needs somewhere for a fare to
 * live and the design had already decided where.
 *
 * Deliberately **not** joined to `schedule_leg` yet. Doing that means deciding
 * what happens to a leg whose route is deleted, and to a schedule that flies a
 * pair with no route — both real questions, neither of them M3-09's. The
 * endpoints are stored here the same way the leg stores them, so the join is a
 * column away when somebody owns that decision.
 */
export const route = pgTable(
  'route',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    worldId: uuid('world_id')
      .notNull()
      .references(() => world.id, { onDelete: 'cascade' }),

    /**
     * `cascade`, like `schedule`. A route is an instruction rather than a
     * record: deleting the airline that opened it leaves nothing worth keeping,
     * and the flights it produced carry their own airline reference for the
     * history §22.10 requires to survive.
     */
    airlineId: uuid('airline_id')
      .notNull()
      .references(() => airline.id, { onDelete: 'cascade' }),

    originIcao: text('origin_icao')
      .notNull()
      .references(() => airport.icaoCode),
    destinationIcao: text('destination_icao')
      .notNull()
      .references(() => airport.icaoCode),

    /** Stored rather than derived, so a fare stays explicable after the matrix is rebuilt. */
    greatCircleNm: doublePrecision('great_circle_nm').notNull(),

    /**
     * Per-cabin fares in integer minor units, as JSON.
     *
     * A column per cabin would be a migration every time a cabin class is added,
     * and `FareTable` is already the shared shape — partial, because an
     * all-economy aircraft has no business fare and should not invent one. Parsed
     * through the zod schema on the way out rather than cast, for the same reason
     * `flight.load` is: a malformed fare table must fail loudly rather than
     * price a seat at a plausible wrong number.
     */
    fares: text('fares').notNull().default('{}'),

    /**
     * Consecutive NPC reviews in which this route was judged a loss-maker (M3-12).
     *
     * Always 0 for a player's route — nothing reviews those. It lives here
     * rather than in a table of its own because it is a property *of the route*
     * with the same lifetime as the route: closing the route ends it, and a
     * world reset takes it with the row. A side table would need its own
     * cascade and its own reset, for one integer.
     *
     * The alternative was to re-derive it each review, which does not work: a
     * margin is a snapshot, and "losing now" cannot distinguish a route that has
     * been failing for a month from one having a bad week. Sustained loss is the
     * whole point of the rule.
     */
    npcLossReviews: integer('npc_loss_reviews').notNull().default(0),

    active: boolean('active').notNull().default(true),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // One route per airline per directional pair. Two rows for the same pair
    // would give a player two fares for the same seat and no way to say which
    // one sold it.
    unique('route_airline_pair_key').on(t.airlineId, t.originIcao, t.destinationIcao),
    index('route_world_id_idx').on(t.worldId),
    index('route_airline_id_idx').on(t.airlineId),
    check('route_endpoints_differ', sql`${t.originIcao} <> ${t.destinationIcao}`),
    check('route_distance_positive', sql`${t.greatCircleNm} > 0`),
  ],
);

export const schedule = pgTable(
  'schedule',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    worldId: uuid('world_id')
      .notNull()
      .references(() => world.id, { onDelete: 'cascade' }),

    /**
     * `cascade`, unlike `airline.player_id`. A schedule is an instruction rather
     * than a record: deleting the airline that issued it leaves nothing worth
     * keeping, and the flights it produced carry their own airline reference for
     * the history §22.10 requires to survive.
     */
    airlineId: uuid('airline_id')
      .notNull()
      .references(() => airline.id, { onDelete: 'cascade' }),

    /** See the note above — no foreign key until M4-01 creates the target. */
    airframeId: uuid('airframe_id').notNull(),

    /**
     * The repeat pattern, split across two columns so the database enforces the
     * discriminated union rather than trusting whatever wrote the row.
     *
     * `daily` carries no days at all — not an empty array, which is the
     * convention this schema deliberately does not use. An empty list meaning
     * "every day" cannot be told apart from days that were lost on the way in.
     */
    repeatKind: repeatKind('repeat_kind').notNull(),
    repeatDays: integer('repeat_days').array(),

    /** A paused schedule stops producing flights without being deleted. */
    active: boolean('active').notNull().default(true),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('schedule_world_id_idx').on(t.worldId),
    index('schedule_airline_id_idx').on(t.airlineId),
    // The materialisation query is "active schedules in this world".
    index('schedule_world_id_active_idx').on(t.worldId, t.active),
    /**
     * `coalesce(cardinality(...), 0)`, and both halves of that are load-bearing.
     *
     * `array_length('{}', 1)` is **NULL** in Postgres, not 0 — and a check
     * constraint passes when its result is unknown. Written the obvious way,
     * this constraint let an empty array through: exactly the "empty means every
     * day" ambiguity it exists to forbid. `cardinality` gives 0 for an empty
     * array, and the `coalesce` closes the same hole for a null one.
     */
    check(
      'schedule_repeat_days_match_kind',
      sql`(${t.repeatKind} = 'daily' AND ${t.repeatDays} IS NULL)
          OR (${t.repeatKind} = 'weekdays'
              AND coalesce(cardinality(${t.repeatDays}), 0) BETWEEN 1 AND 7
              AND ${t.repeatDays} <@ ARRAY[1,2,3,4,5,6,7])`,
    ),
  ],
);

/**
 * One leg of a rotation, in order.
 *
 * Endpoints are ICAO codes referencing `airport` rather than a `route_id`,
 * because there is no `route` table — M2-01 shipped the reachability checks as
 * pure functions and left the entity to a later milestone. `shared`'s `Flight`
 * already names its endpoints the same way, so a materialised flight copies them
 * across without a join. When a `route` table does land, a `route_id` column
 * joins these rather than replacing them: fares belong to the route, geography
 * to the leg.
 *
 * `block_minutes` is M2-05's to compute and `turnaround_minutes` is M2-04's.
 * Both are stored rather than derived, so a flight already on the books can
 * still be explained after those models are retuned (CONTRIBUTING invariant 4).
 */
export const scheduleLeg = pgTable(
  'schedule_leg',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    scheduleId: uuid('schedule_id')
      .notNull()
      .references(() => schedule.id, { onDelete: 'cascade' }),

    /** Position in the rotation, from zero. */
    legIndex: integer('leg_index').notNull(),

    originIcao: text('origin_icao')
      .notNull()
      .references(() => airport.icaoCode),
    destinationIcao: text('destination_icao')
      .notNull()
      .references(() => airport.icaoCode),

    /**
     * Off-blocks, in minutes from the cycle anchor.
     *
     * Not a minute of the day. A rotation that lands at 00:15 the next morning
     * has a leg at minute 1,455, and forcing that back under 1,440 would put it
     * in a different cycle from the one it belongs to.
     */
    departureMinute: integer('departure_minute').notNull(),
    /** Off-blocks to on-blocks. */
    blockMinutes: integer('block_minutes').notNull(),
    /** Ground time required after this leg. */
    turnaroundMinutes: integer('turnaround_minutes').notNull(),
  },
  (t) => [
    // Order is a database property: two legs cannot share a position.
    unique('schedule_leg_schedule_id_leg_index_key').on(t.scheduleId, t.legIndex),
    index('schedule_leg_schedule_id_idx').on(t.scheduleId),
    check('schedule_leg_index_nonneg', sql`${t.legIndex} >= 0`),
    check('schedule_leg_departure_nonneg', sql`${t.departureMinute} >= 0`),
    check('schedule_leg_block_positive', sql`${t.blockMinutes} > 0`),
    check('schedule_leg_turnaround_nonneg', sql`${t.turnaroundMinutes} >= 0`),
    check('schedule_leg_not_circular', sql`${t.originIcao} <> ${t.destinationIcao}`),
  ],
);

/**
 * A held airport slot (M7-05, §7.4 / design §"Slots").
 *
 * One row is one airline's standing right to operate **departures** at a
 * coordinated (IATA Level 3) airport in one **hourly band** (0–23). It is the
 * game's model of the scarce resource the design doc calls "held, traded, and
 * lost through underuse": scheduling a departure whose local off-blocks fall in a
 * band the airline does not hold is refused by reachability's slot check.
 *
 * A slot is a **per-band operating right**, not a per-movement token — one row
 * lets the airline fly any number of departures in that band. Per-movement
 * counting, trading (→ MARKET), incumbency priority, use-it-or-lose-it and
 * seasonality (→ SEASON) are all deliberately out of this first cut; see
 * ADR-0025. The scarcity that exists here is the per-band **capacity**: only so
 * many airlines may hold a given band, enforced at claim time.
 *
 * There is no fee row: the per-movement airport charge already flows through
 * settlement's `airport_slot` ledger category, and a recurring holding fee would
 * need a worker to bill it, which §"Costs" puts later. Holding is standing state
 * and needs no worker at all — which is why, unlike most of the fleet and
 * network engine, this works on a world with no worker.
 */
export const slotHolding = pgTable(
  'slot_holding',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    worldId: uuid('world_id')
      .notNull()
      .references(() => world.id, { onDelete: 'cascade' }),
    airlineId: uuid('airline_id')
      .notNull()
      .references(() => airline.id, { onDelete: 'cascade' }),

    /** The coordinated airport, by ICAO — the same reference shape a route leg uses. */
    airportIcao: text('airport_icao')
      .notNull()
      .references(() => airport.icaoCode),

    /** The hour of the local day the slot covers, 0–23. `floor(departureMinute / 60)`. */
    band: integer('band').notNull(),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // One holding per airline per band per airport: claiming is idempotent, and
    // capacity counts distinct holders, so a second claim must not make a second row.
    unique('slot_holding_world_airline_airport_band_key').on(
      t.worldId,
      t.airlineId,
      t.airportIcao,
      t.band,
    ),
    // Counting how full a band is (capacity check) reads by world + airport + band.
    index('slot_holding_world_airport_band_idx').on(t.worldId, t.airportIcao, t.band),
    // Resolving an airline's holdings when it authors a schedule reads by owner.
    index('slot_holding_world_airline_idx').on(t.worldId, t.airlineId),
    check('slot_holding_band_range', sql`${t.band} >= 0 AND ${t.band} <= 23`),
  ],
);

export const flightPhase = pgEnum('flight_phase', [
  'scheduled',
  'boarding',
  'pushback',
  'taxi_out',
  'departure',
  'climb',
  'cruise',
  'descent',
  'approach',
  'landing',
  'taxi_in',
  'turnaround',
  'idle',
]);

/**
 * Why the aircraft is flying (M2-07).
 *
 * `ferry` is a positioning flight: no passengers, no revenue, and every cost of
 * a real one. Kept as a column rather than inferred from an empty load, because
 * "this flight was never meant to earn" and "this flight failed to sell a seat"
 * are different facts that a cost report has to be able to tell apart.
 *
 * More kinds are coming — §11 names charter and ACMI as revenue lines — and
 * adding one is `ALTER TYPE … ADD VALUE`, which is cheap. Speculating about them
 * now is not.
 */
export const flightKind = pgEnum('flight_kind', ['scheduled', 'ferry']);

export const flightDisruption = pgEnum('flight_disruption', [
  'delayed',
  'cancelled',
  'returned_to_stand',
  'air_return',
  'diverted',
]);

/**
 * Why a flight went wrong (M2-08, M5-02).
 *
 * M2-08 modelled these in `packages/sim` as `DisruptionCause` and `flight`
 * stored only the outcome, so until now the reason was computed and thrown
 * away. Section 14.1 forbids a number a player cannot interrogate, and
 * *"delayed 40 minutes"* is not information in the way *"delayed 40 minutes
 * because the crew were out of hours"* is - the second one names something the
 * player can change.
 *
 * The values mirror `DisruptionCause` exactly. Two enums that must agree is one
 * more than ideal; the alternative is a text column that agrees with nothing,
 * and the pairing is asserted by a test rather than by memory.
 */
export const flightDisruptionCause = pgEnum('flight_disruption_cause', [
  'weather_origin',
  'weather_destination',
  'atc_flow',
  'technical',
  'crew_timeout',
  'ground_vendor',
  'airport_closure',
]);

/**
 * A concrete flight, dated and assigned.
 *
 * §21 requires flight state to be **computed, not stored per tick**: what is
 * persisted is the plan and the discrete transitions, and position is
 * interpolated on read. So there is no latitude here, and there should never be.
 *
 * ## `materialisation_key` is the exactly-once guarantee
 *
 * Unique per world, and built by `@tailfin/sim` from
 * `(rotation, cycle date, leg index)` — never from when the roll ran. Rolling
 * the same horizon twice, after a restart or with two workers racing, is refused
 * **by this constraint** rather than by application logic that has to be right
 * every time. Same discipline as `world_event`'s idempotency key, for the same
 * reason.
 *
 * Null for a flight that came from somewhere other than a schedule: a ferry
 * positioning leg (M2-07) belongs to no cycle.
 */
export const flight = pgTable(
  'flight',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    worldId: uuid('world_id')
      .notNull()
      .references(() => world.id, { onDelete: 'cascade' }),
    airlineId: uuid('airline_id')
      .notNull()
      .references(() => airline.id, { onDelete: 'cascade' }),

    /**
     * `set null`, not `cascade`. Deleting a schedule must not delete the flights
     * it already produced — one of them may have flown and earned money, and
     * §22.10 wants the operational record to survive. A flight keeps its own
     * endpoints and times, so it is complete without its parent.
     */
    scheduleId: uuid('schedule_id').references(() => schedule.id, { onDelete: 'set null' }),

    /** No foreign key yet, for the same reason as `schedule.airframe_id`. */
    airframeId: uuid('airframe_id').notNull(),

    originIcao: text('origin_icao')
      .notNull()
      .references(() => airport.icaoCode),
    destinationIcao: text('destination_icao')
      .notNull()
      .references(() => airport.icaoCode),
    /** Set only when diverted, and then it is where the aircraft actually went. */
    diversionIcao: text('diversion_icao').references(() => airport.icaoCode),

    /**
     * Defaults to `scheduled`, which is what every existing row was. A ferry has
     * to be asked for explicitly — a positioning flight created by accident is a
     * flight that earns nothing, and that should never be the default.
     */
    kind: flightKind('kind').notNull().default('scheduled'),

    phase: flightPhase('phase').notNull().default('scheduled'),
    disruption: flightDisruption('disruption'),
    /**
     * Null when nothing went wrong, and also null for a disruption recorded
     * before M5-02 added the column. Those are different facts and the column
     * cannot tell them apart, which is the honest cost of adding it late; a
     * disruption with no cause is old, not causeless.
     */
    disruptionCause: flightDisruptionCause('disruption_cause'),
    /**
     * The duty period whose crew operated this flight (M5-02).
     *
     * Nullable, and stays nullable: a ferry positioned before the crew model
     * existed has none, and neither does a flight in a world that has not yet
     * opened a crew base. `set null` rather than `cascade` for the reason
     * `schedule_id` gives - the operational record outlives the thing that
     * caused it.
     */
    crewDutyPeriodId: uuid('crew_duty_period_id'),

    /** All four are **game-time** instants, like `world_event.fire_at`. */
    scheduledDeparture: timestamp('scheduled_departure', { withTimezone: true }).notNull(),
    actualDeparture: timestamp('actual_departure', { withTimezone: true }),
    estimatedArrival: timestamp('estimated_arrival', { withTimezone: true }).notNull(),
    actualArrival: timestamp('actual_arrival', { withTimezone: true }),

    /**
     * What the departure turn's handling cost, relative to the standard grade
     * (M5-06, §9.3) — snapshotted when the aeroplane actually left.
     *
     * **Null means the flight departed before handling was snapshotted**, not
     * that it was handled at the standard rate. The settlement resolves such a
     * flight's arrangement live, which is what it did for every flight until
     * this column existed.
     *
     * Stored rather than resolved at arrival because the arrangement is mutable
     * and the flight is not: a player who switches handlers mid-flight was
     * otherwise billed for the handler they have *now* rather than the one that
     * worked the turn, and a replay of an old arrival re-derived a different
     * cost — which `settleArrivedFlight` promises it will not do.
     *
     * `double precision` rather than `numeric` for the reason `latitude` gives:
     * it is a measurement rather than a quantity that must balance, and a
     * `numeric` would come back from the driver as a string.
     */
    handlingPriceFactor: doublePrecision('handling_price_factor'),

    /** JSON text, like `world_event.payload`. M2-06 fills it; nothing queries inside it. */
    load: text('load').notNull().default('{}'),
    /** Belly cargo in kilograms (§12.1). */
    cargoKg: integer('cargo_kg').notNull().default(0),

    /** See the note above. Null for a flight that did not come from a schedule. */
    materialisationKey: text('materialisation_key'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('flight_world_id_materialisation_key').on(t.worldId, t.materialisationKey),
    index('flight_world_id_scheduled_departure_idx').on(t.worldId, t.scheduledDeparture),
    index('flight_schedule_id_idx').on(t.scheduleId),
    index('flight_airline_id_idx').on(t.airlineId),
    check('flight_cargo_nonneg', sql`${t.cargoKg} >= 0`),
    check('flight_arrives_after_departure', sql`${t.estimatedArrival} > ${t.scheduledDeparture}`),
    check('flight_not_circular', sql`${t.originIcao} <> ${t.destinationIcao}`),
  ],
);

export type ScheduleRow = typeof schedule.$inferSelect;
export type NewScheduleRow = typeof schedule.$inferInsert;

export type ScheduleLegRow = typeof scheduleLeg.$inferSelect;
export type NewScheduleLegRow = typeof scheduleLeg.$inferInsert;

export type FlightRow = typeof flight.$inferSelect;
export type NewFlightRow = typeof flight.$inferInsert;

// ---------------------------------------------------------------------------
// flight_result — economic resolution (M2-06, §3.1, §11, §14.1)
// ---------------------------------------------------------------------------

/**
 * What a flight earned and what it cost, written once when it arrives.
 *
 * §3.1: economic resolution happens **at flight events, not continuously**. This
 * is the record that event produces, and it is permanent — a settled flight is a
 * financial fact, and §22.10 wants the operational record to outlive the schedule
 * that created it.
 *
 * ## The unique constraint is the idempotency guarantee
 *
 * `flight_id` is unique, so a flight can be settled **once**. Replaying
 * `FLIGHT_ARRIVE` — after a restart, a retry, or two workers racing — is refused
 * by the database rather than by application logic that has to be right every
 * time. Same discipline as `world_event.idempotency_key` and
 * `flight.materialisation_key`, for the same reason, and it is what makes M2-06's
 * "replaying a settled flight is a no-op" a property of the schema instead of a
 * promise.
 *
 * That matters more here than anywhere else in the schema: every other duplicate
 * costs a wasted row, and this one would pay an airline twice.
 *
 * ## Why the breakdown is JSON and the totals are columns
 *
 * The three totals are money that has to be summed, compared and indexed across
 * millions of rows — §14.4's *"profit by route, ranked"* is a query over
 * `net_minor`. The per-line breakdown is read one flight at a time, only ever for
 * that flight, and its shape belongs to the settlement model rather than to the
 * database. Splitting it into columns would freeze §11's cost list into DDL and
 * make adding a line a migration.
 *
 * `flight_result_net_reconciles` then keeps the two halves honest at the database
 * level: the net is the difference, always, and no application bug can write a
 * row where it is not.
 */
export const flightResult = pgTable(
  'flight_result',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    worldId: uuid('world_id')
      .notNull()
      .references(() => world.id, { onDelete: 'cascade' }),

    /**
     * One result per flight, for ever. See the note above — this constraint is
     * the idempotency guarantee, not an incidental tidiness.
     */
    flightId: uuid('flight_id')
      .notNull()
      .unique()
      .references(() => flight.id, { onDelete: 'cascade' }),

    /**
     * Denormalised from `flight`, deliberately. A P&L is queried by airline far
     * more often than by flight, and joining through `flight` to answer "what did
     * this airline earn last week" would be a join per row for a column that
     * cannot change: a flight never moves between airlines.
     */
    airlineId: uuid('airline_id')
      .notNull()
      .references(() => airline.id, { onDelete: 'cascade' }),

    /** Integer minor units, like `airline.cash_minor`. Never a float — see that column. */
    revenueMinor: bigint('revenue_minor', { mode: 'number' }).notNull(),
    costMinor: bigint('cost_minor', { mode: 'number' }).notNull(),
    /**
     * `revenue_minor − cost_minor`. Contribution rather than profit: period costs
     * — lease, gate, admin — are not caused by a flight and are not settled here.
     */
    netMinor: bigint('net_minor', { mode: 'number' }).notNull(),

    /**
     * Denormalised from `flight`, like `airline_id` and for the same reason: a
     * cost report asks "how much did positioning cost us this month" far more
     * often than it asks about one flight, and a flight never changes its kind.
     *
     * It is also what makes M2-07's *"clearly marked as non-revenue"* true of the
     * money rather than only of the schedule — a ferry's row is legible as a
     * ferry without joining back to find out why it earned nothing.
     */
    kind: flightKind('kind').notNull().default('scheduled'),

    seats: integer('seats').notNull(),
    passengers: integer('passengers').notNull(),
    /**
     * Passengers this flight turned away (App. A.5, M3-05).
     *
     * Stored rather than derived, because it cannot be derived: a settled
     * flight at 100% load factor looks identical whether it spilled nobody or
     * two hundred, and the difference is the whole strategic signal — A.5 wants
     * the game to say *"you turned away 40 passengers a day"*, which is what
     * tells a player to upgauge rather than to celebrate a full aeroplane.
     *
     * Defaults to 0 so every result written before M3-05 stays valid; that
     * reads as "none recorded", and the rows that predate the column are
     * distinguishable by their settlement version.
     */
    spilledPassengers: integer('spilled_passengers').notNull().default(0),
    cargoKg: integer('cargo_kg').notNull().default(0),

    /**
     * Block time in **seconds**, integer.
     *
     * Not minutes: block time is fractional (75.6 minutes for AMS–LHR) and this
     * is a financial record that crew and maintenance costs were charged against,
     * so it has to reproduce them exactly. `numeric` would do it too and would
     * come back as a string from the driver — an integer count of seconds is
     * exact, sorts, and needs no parsing at the boundary.
     */
    blockSeconds: integer('block_seconds').notNull(),

    /**
     * Arrival delay in minutes against the plan; negative for an early arrival.
     *
     * A **reputation input**, recorded rather than acted on. §15 owns what
     * punctuality does to an airline's standing and none of that is decided yet,
     * so this captures the fact at the moment it is knowable and leaves the
     * consequence to the system that owns it.
     */
    arrivalDelayMinutes: integer('arrival_delay_minutes').notNull().default(0),

    /** The itemised lines, as JSON. See the note above on why this is not columns. */
    breakdown: text('breakdown').notNull(),

    /**
     * Which settlement rates this ran under, mirroring `world.economy_config_version`.
     *
     * Load-bearing rather than decorative: after the rates are retuned, this is
     * the only thing that can explain why a flight in October earned what it did
     * (invariant 4).
     */
    settlementVersion: text('settlement_version').notNull(),

    /** Game-time instant the flight was settled — its on-blocks time. */
    settledAt: timestamp('settled_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('flight_result_airline_id_settled_at_idx').on(t.airlineId, t.settledAt),
    index('flight_result_world_id_settled_at_idx').on(t.worldId, t.settledAt),
    // The breakdown and the totals cannot disagree, whatever the application does.
    check('flight_result_net_reconciles', sql`${t.netMinor} = ${t.revenueMinor} - ${t.costMinor}`),
    check('flight_result_seats_nonneg', sql`${t.seats} >= 0`),
    check(
      'flight_result_passengers_fit',
      sql`${t.passengers} >= 0 AND ${t.passengers} <= ${t.seats}`,
    ),
    /**
     * Spill is only possible on a full aircraft (A.5, M3-05).
     *
     * If seats were empty, whoever was turned away could have sat in one — so a
     * row claiming both is arithmetically impossible rather than merely odd,
     * and the database is the right place to say so. The same rule is enforced
     * in `summariseLoad`; this is the copy that a new write path cannot forget.
     */
    check(
      'flight_result_spill_needs_a_full_aircraft',
      sql`${t.spilledPassengers} >= 0
          AND (${t.spilledPassengers} = 0 OR ${t.passengers} = ${t.seats})`,
    ),
    check('flight_result_cargo_nonneg', sql`${t.cargoKg} >= 0`),
    check('flight_result_block_positive', sql`${t.blockSeconds} > 0`),
    /**
     * A ferry earns nothing. Enforced here as well as in the settlement model,
     * because this is the row that becomes an airline's cash: a bug that books
     * revenue on a positioning flight must not be able to persist, whatever
     * path it arrives by.
     */
    check(
      'flight_result_ferry_earns_nothing',
      sql`${t.kind} <> 'ferry' OR (${t.revenueMinor} = 0 AND ${t.passengers} = 0)`,
    ),
  ],
);

// ---------------------------------------------------------------------------
// demand_pool — App. A.2's market size, per city pair (M3-01)
// ---------------------------------------------------------------------------

/**
 * How many people want to fly between two cities, before anyone flies it.
 *
 * A.2's step one, computed once when a world is created and then modulated live
 * by M3-02 rather than recomputed. It is the input to every commercial decision
 * in the game, which is why it is a table rather than a function call: M3-03's
 * share model runs against it constantly, and re-deriving a gravity model on
 * every query would be paying for the same arithmetic for ever.
 *
 * ## Stored per world, not globally
 *
 * The airports are global — geography does not vary — but the pool is not. A.2's
 * `k` and `α` are economy config, a world pins its `economy_config_version`, and
 * ADR-0005's reset gives a world a fresh start. A pool computed under one set of
 * coefficients cannot be shared with a world running another.
 *
 * ## One row per unordered pair
 *
 * A market is the same market in both directions: the segment split is symmetric
 * and so is the affinity, so storing AMS→LHR and LHR→AMS separately would be
 * double-counting rather than thoroughness. The check constraint enforces the
 * canonical ordering so the application cannot write both.
 *
 * That halves nearly ten million pairs to five, and the viability filter cuts it
 * much further — a pair nobody could fill a turboprop on is not a market
 * M3-03 should spend time dividing between competitors.
 */
export const demandPool = pgTable(
  'demand_pool',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    worldId: uuid('world_id')
      .notNull()
      .references(() => world.id, { onDelete: 'cascade' }),

    /** Alphabetically first, enforced below — a market has no direction. */
    originIcao: text('origin_icao')
      .notNull()
      .references(() => airport.icaoCode),
    destinationIcao: text('destination_icao')
      .notNull()
      .references(() => airport.icaoCode),

    /** Great-circle nautical miles, from M1-04's matrix. */
    distanceNm: integer('distance_nm').notNull(),

    /**
     * Passengers a day, both directions, before any live modulation.
     *
     * `numeric` rather than an integer: a thin regional market is genuinely 27.4
     * a day, and rounding every pool to a whole passenger would quantise the
     * small end of the world into steps a player could see.
     */
    dailyPassengers: numeric('daily_passengers', { precision: 12, scale: 2 }).notNull(),

    /**
     * A.2's three segments. Stored as columns rather than JSON because M3-03
     * filters and aggregates on them — *"show me the business-heavy routes I am
     * not serving"* is a query, not a document read.
     */
    businessShare: numeric('business_share', { precision: 5, scale: 4 }).notNull(),
    leisureShare: numeric('leisure_share', { precision: 5, scale: 4 }).notNull(),
    vfrShare: numeric('vfr_share', { precision: 5, scale: 4 }).notNull(),

    /**
     * The mass, distance and affinity terms that produced it, as JSON.
     *
     * §14.1: a number a player cannot interrogate is a number they will not
     * trust, and the entire demand model rests on that trust. *"Why is this
     * route worth so little"* has to be answerable, and the answer is which of
     * the three terms was small.
     */
    basis: text('basis').notNull(),

    /** Which coefficients this ran under, mirroring `world.economy_config_version`. */
    gravityVersion: text('gravity_version').notNull(),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('demand_pool_world_id_pair_key').on(t.worldId, t.originIcao, t.destinationIcao),
    // The query M3-03 runs: the biggest markets this airline could serve.
    index('demand_pool_world_id_daily_passengers_idx').on(t.worldId, t.dailyPassengers),
    index('demand_pool_world_id_origin_idx').on(t.worldId, t.originIcao),
    index('demand_pool_world_id_destination_idx').on(t.worldId, t.destinationIcao),
    // A market has no direction, so only one of the two orderings may be stored.
    check('demand_pool_canonical_order', sql`${t.originIcao} < ${t.destinationIcao}`),
    check('demand_pool_distance_positive', sql`${t.distanceNm} > 0`),
    check('demand_pool_passengers_nonneg', sql`${t.dailyPassengers} >= 0`),
    // The shares are a split, so they add up. Enforced here as well as in the
    // model, because this row is what every commercial decision reads.
    check(
      'demand_pool_shares_sum_to_one',
      sql`abs((${t.businessShare} + ${t.leisureShare} + ${t.vfrShare}) - 1) < 0.001`,
    ),
  ],
);

export type DemandPoolRow = typeof demandPool.$inferSelect;
export type NewDemandPoolRow = typeof demandPool.$inferInsert;

export type FlightResultRow = typeof flightResult.$inferSelect;
export type NewFlightResultRow = typeof flightResult.$inferInsert;

// ---------------------------------------------------------------------------
// node_heartbeat — what each machine says about itself (OPS-15)
// ---------------------------------------------------------------------------

export const nodeRole = pgEnum('node_role', ['web', 'worker']);

/**
 * One row per node, rewritten on every heartbeat.
 *
 * ## Why a table and not an HTTP call
 *
 * The admin console runs in the web process. It cannot reach the worker's health
 * endpoint and must never be able to: that endpoint binds loopback, the worker's
 * firewall allows only SSH, and its unit carries `IPAddressDeny=any`. ADR-0019
 * makes the database the channel between the processes, and this is that channel
 * used for the one thing the console needs from a machine it cannot touch.
 *
 * It also inverts the direction of trust in the useful way. The web application
 * opens no connection to another host and holds no key to one. A node that stops
 * writing is **detected as stale** rather than merely unreachable — which is a
 * stronger statement, because it does not depend on the console's own network
 * path being healthy.
 *
 * ## Why the node name is the primary key
 *
 * A heartbeat is a node's current state, not a log of its past. One row per node,
 * upserted, so the table stays the size of the estate rather than growing at one
 * row per interval forever. History, if it is ever wanted, is a separate decision
 * with a retention policy attached.
 *
 * ## Why `load` and `engine` are text
 *
 * They are shapes the console renders and nothing queries by. Storing them as
 * validated JSON keeps the columns from being renegotiated every time a metric
 * is added, and the zod schema at the boundary is what actually guarantees the
 * shape — the same reasoning `world_event.payload` already uses.
 */
export const nodeHeartbeat = pgTable(
  'node_heartbeat',
  {
    /** The machine's hostname. Stable across restarts, unique in the estate. */
    node: text('node').primaryKey(),
    role: nodeRole('role').notNull(),
    /** Informational: a database only ever holds one environment's nodes. */
    environment: text('environment').notNull(),
    build: integer('build').notNull(),
    commit: text('commit').notNull(),
    /** When this process started, so a restart is visible as well as a stall. */
    startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    uptimeSeconds: integer('uptime_seconds').notNull(),
    /** `AdminNodeLoad` as JSON. */
    load: text('load').notNull(),
    /** `AdminNodeEngine` as JSON. Null for a web node, which runs no engine. */
    engine: text('engine'),
  },
  (t) => [
    index('node_heartbeat_last_seen_at_idx').on(t.lastSeenAt),
    check('node_heartbeat_uptime_nonnegative', sql`${t.uptimeSeconds} >= 0`),
    check('node_heartbeat_build_nonnegative', sql`${t.build} >= 0`),
    // A web node has no engine to report, and a worker that reports none has
    // not finished starting. Neither is a state worth storing.
    check(
      'node_heartbeat_engine_matches_role',
      sql`(${t.role} = 'worker' AND ${t.engine} IS NOT NULL)
          OR (${t.role} = 'web' AND ${t.engine} IS NULL)`,
    ),
  ],
);

export type NodeHeartbeatRow = typeof nodeHeartbeat.$inferSelect;

// ---------------------------------------------------------------------------
// Economy configuration (M3-11, §22.3)
// ---------------------------------------------------------------------------

/**
 * The economy, as versioned data.
 *
 * A.3 says the β coefficients *"belong in a config file that can be tuned live,
 * never hard-coded"*, and CONTRIBUTING makes that invariant 3. This is the file.
 * A world pins one row through `world.economy_config_version`, and changing that
 * pin is an audited admin action.
 *
 * ## Rows are immutable, and the triggers enforce it
 *
 * Editing a version means creating a new one. Three things depend on that:
 *
 *   - **`flight_result` records the version it settled under.** If a payload
 *     could change under it, an old settlement would stop being explicable,
 *     which is invariant 4 failing silently months later.
 *   - **The in-process cache is correct without invalidation logic.** Keyed by
 *     version, across every web and worker process, with no cross-process
 *     message needed — because a version cannot mean two things.
 *   - **Rollback is re-pinning, not editing.** §22.3's *"one-click rollback"*
 *     becomes an audited pin change to a version that still exists.
 *
 * ## No foreign key from `world.economy_config_version`
 *
 * It would be a good constraint and it is deliberately absent. Adding one means
 * the migration must insert a v1 row to satisfy the worlds already pinning it,
 * which would freeze a copy of every balance number into SQL — the exact
 * duplication this table exists to remove. The seed inserts v1 from
 * `ECONOMY_CONFIG_V1` at startup instead, and the loader refuses a world whose
 * version is missing rather than silently falling back to the shipped one.
 */
export const economyConfig = pgTable(
  'economy_config',
  {
    version: text('version').primaryKey(),

    /** The `EconomyConfig` payload as JSON text. Nothing queries inside it. */
    payload: text('payload').notNull(),

    /**
     * SHA-256 of `canonicalEconomyJson(payload)`.
     *
     * Key order is normalised first, so this identifies the *config* rather than
     * the text — which is what lets startup notice that a live-retuned v1 no
     * longer matches the shipped one and say so, instead of overwriting it.
     */
    checksum: text('checksum').notNull(),

    /** What this was derived from, so a diff has a natural counterpart. Null for the seed. */
    parentVersion: text('parent_version'),

    /** Why this version exists, in the author's words. */
    notes: text('notes'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),

    /** Not a foreign key, for the same reason as `admin_audit.actor_player_id`. */
    createdByPlayerId: uuid('created_by_player_id'),
    /** Denormalised so the row stays legible after the account is anonymised (§22.10). */
    createdByLabel: text('created_by_label').notNull(),
  },
  (t) => [index('economy_config_created_at_idx').on(t.createdAt)],
);

export type EconomyConfigRow = typeof economyConfig.$inferSelect;
export type NewEconomyConfigRow = typeof economyConfig.$inferInsert;

// ---------------------------------------------------------------------------
// npc_decision — why an NPC did what it did (M3-12)
// ---------------------------------------------------------------------------

export const npcDecisionKind = pgEnum('npc_decision_kind', [
  'route_opened',
  'route_closed',
  'fare_changed',
  'entry_declined',
]);

/**
 * Every decision an NPC carrier made, and the numbers it made it on.
 *
 * M3-12's third acceptance criterion asks for NPC decisions to be *logged and
 * inspectable*, and the reason is the same one behind App. A.1's explainability
 * requirement: a competitor whose behaviour cannot be inspected is one players
 * will assume is cheating. §22.8 wants the same thing for HHI monitoring — you
 * cannot reason about market concentration without knowing why it moved.
 *
 * `entry_declined` is deliberately recorded. A log that only holds the actions
 * taken cannot answer "why did nobody enter my fat monopoly route?", which is
 * exactly the question A.10's monopoly guard invites somebody to ask.
 *
 * Not append-only by trigger, unlike `admin_audit` and `economy_config`. This is
 * simulation telemetry rather than a record of human acts, it grows without
 * bound, and something will eventually have to prune it — a decision left to
 * whoever meets the volume, with the index below to make that cheap.
 */
export const npcDecision = pgTable(
  'npc_decision',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    worldId: uuid('world_id')
      .notNull()
      .references(() => world.id, { onDelete: 'cascade' }),
    airlineId: uuid('airline_id')
      .notNull()
      .references(() => airline.id, { onDelete: 'cascade' }),

    /** **Game time**, not real time — the instant the world thinks this happened. */
    decidedAt: timestamp('decided_at', { withTimezone: true }).notNull(),
    /** Real time, so an operator can correlate a decision with a worker log line. */
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull().defaultNow(),

    kind: npcDecisionKind('kind').notNull(),

    /** The market it was about. Null for a decision that is not route-specific. */
    originIcao: text('origin_icao'),
    destinationIcao: text('destination_icao'),

    /**
     * The figures the decision rested on, as JSON text.
     *
     * Text rather than jsonb for the same reason `admin_audit.before` is:
     * nothing queries inside it, and text needs no cast. The shape is
     * `NpcDecisionBasis` in `@tailfin/shared`.
     */
    basis: text('basis').notNull(),

    /** One sentence, server-written, in the player-facing vocabulary. */
    reason: text('reason').notNull(),

    /** The economy version the decision was judged under (M3-11, invariant 4). */
    economyConfigVersion: text('economy_config_version').notNull(),
  },
  (t) => [
    // The query the admin console runs: this world's decisions, newest first.
    index('npc_decision_world_id_decided_at_idx').on(t.worldId, t.decidedAt),
    index('npc_decision_airline_id_idx').on(t.airlineId),
    check(
      'npc_decision_route_pair_complete',
      sql`(${t.originIcao} IS NULL AND ${t.destinationIcao} IS NULL)
          OR (${t.originIcao} IS NOT NULL AND ${t.destinationIcao} IS NOT NULL)`,
    ),
  ],
);

export type NpcDecisionRow = typeof npcDecision.$inferSelect;
export type NewNpcDecisionRow = typeof npcDecision.$inferInsert;

// ---------------------------------------------------------------------------
// aircraft_type — the versioned catalogue (M4-01, App. C.1–C.2, §22.5)
// ---------------------------------------------------------------------------

/**
 * One aircraft type, in one version of the catalogue.
 *
 * §22.5: *"Catalogue **versioning** — a world is pinned to a version, so
 * retuning aircraft doesn't retroactively break running worlds."* A world pins
 * `world.aircraft_catalogue_version`, exactly as it pins its economy — and
 * deliberately as a *different* version, because a fare change and an
 * aerodynamics change must not share a number.
 *
 * ## Rows, not a payload
 *
 * `economy_config` stores one JSON blob per version because the economy is one
 * object that is always read whole. A catalogue is eighteen independent things
 * that are looked up by designation, listed, filtered by era and joined to
 * airframes — so it is rows, and the version is part of the key.
 *
 * ## Immutable, for the same reason the economy is
 *
 * The triggers below refuse UPDATE, DELETE and TRUNCATE. A world flying a type
 * has its performance baked into every `flight_result` it ever settled, and a
 * specification that could change underneath those would make an old flight
 * inexplicable (invariant 4). Retuning an aircraft is a **new catalogue
 * version**, and moving a world to it is a deliberate act.
 *
 * ## No foreign key from `world.aircraft_catalogue_version`
 *
 * Same reasoning as `economy_config`, and the same trade: a foreign key would
 * force the migration to seed a version, which means writing eighteen aircraft
 * into SQL. The seed inserts from `AIRCRAFT_CATALOGUE_V1` at startup instead.
 */
export const aircraftType = pgTable(
  'aircraft_type',
  {
    catalogueVersion: text('catalogue_version').notNull(),
    /** `A321neo`, `ATR 72-600`. Unique within a version — the catalogue key. */
    designation: text('designation').notNull(),

    /** Crew are rated per family, not per type (§9.2) — the commonality mechanic. */
    family: text('family').notNull(),
    manufacturer: text('manufacturer').notNull(),
    class: text('class').notNull(),
    maintenanceProfile: text('maintenance_profile').notNull(),

    /** `AircraftSpec` as JSON text. Read whole; nothing queries inside it. */
    baseSpec: text('base_spec').notNull(),
    /** `AircraftEraDates` as JSON text, including the restriction list. */
    eraDates: text('era_dates').notNull(),

    /**
     * The four dates again, as columns.
     *
     * Denormalised from `era_dates` on purpose: *"which types can this world
     * order today?"* is the question the catalogue is asked most, and answering
     * it by parsing eighteen JSON blobs in the application would make era
     * gating cost a table scan every time a player opened a list. The JSON
     * stays the source of truth and these are the index.
     */
    firstFlight: timestamp('first_flight', { withTimezone: true }),
    entryIntoService: timestamp('entry_into_service', { withTimezone: true }),
    productionEnd: timestamp('production_end', { withTimezone: true }),
    outOfService: timestamp('out_of_service', { withTimezone: true }),

    /** Null for a used-market-only type — App. C.2 shows those as "—". */
    listPriceMinor: bigint('list_price_minor', { mode: 'number' }),
    monthlyLeaseRateMinor: bigint('monthly_lease_rate_minor', { mode: 'number' }),
    /** Off-the-shelf factory lead in real weeks; options add to it (M4-04). */
    baseDeliveryLeadWeeks: integer('base_delivery_lead_weeks').notNull().default(4),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    /** Which build wrote it, so a mismatch can be traced to a release. */
    createdByLabel: text('created_by_label').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.catalogueVersion, t.designation] }),
    // The era-gating query: this version's types, orderable at a given date.
    index('aircraft_type_version_eis_idx').on(t.catalogueVersion, t.entryIntoService),
    check(
      'aircraft_type_era_dates_ordered',
      sql`(${t.firstFlight} IS NULL OR ${t.entryIntoService} IS NULL
           OR ${t.firstFlight} <= ${t.entryIntoService})
          AND (${t.entryIntoService} IS NULL OR ${t.productionEnd} IS NULL
           OR ${t.entryIntoService} <= ${t.productionEnd})
          AND (${t.productionEnd} IS NULL OR ${t.outOfService} IS NULL
           OR ${t.productionEnd} <= ${t.outOfService})`,
    ),
    check(
      'aircraft_type_prices_nonnegative',
      sql`(${t.listPriceMinor} IS NULL OR ${t.listPriceMinor} >= 0)
          AND (${t.monthlyLeaseRateMinor} IS NULL OR ${t.monthlyLeaseRateMinor} >= 0)`,
    ),
    check('aircraft_type_base_delivery_positive', sql`${t.baseDeliveryLeadWeeks} > 0`),
  ],
);

export type AircraftTypeRow = typeof aircraftType.$inferSelect;
export type NewAircraftTypeRow = typeof aircraftType.$inferInsert;

// ---------------------------------------------------------------------------
// aircraft_option — the factory configurator (M4-03, App. C.3, C.6)
// ---------------------------------------------------------------------------

/**
 * One factory option, in one version of the catalogue.
 *
 * Versioned and immutable for exactly the reason `aircraft_type` is: an airframe
 * built with three auxiliary tanks has that build's weight and range folded into
 * every `flight_result` it ever settled, and a delta that could change
 * underneath would make an old flight inexplicable (invariant 4). Retuning an
 * option is a new catalogue version.
 *
 * ## Why the availability is a separate table
 *
 * C.6 puts `available_options[]` on the type, which would suggest a column on
 * `aircraft_type`. It cannot be one: those rows are immutable by trigger, so a
 * column added now could never be backfilled for the v1 rows already seeded into
 * dev — every existing world would offer an empty configurator for ever, and the
 * only repair would be re-authoring eighteen types as v2.
 *
 * A join table has none of that problem. It is new, so there is nothing to
 * backfill; the seed completes v1's availability on a database that already
 * holds v1's types, which is the same *"partially-present version is completed
 * rather than refused"* behaviour `seedAircraftCatalogue` already documents.
 */
export const aircraftOption = pgTable(
  'aircraft_option',
  {
    catalogueVersion: text('catalogue_version').notNull(),
    /** `sharklets`, `act-3`. Unique within a version, and referenced by a build. */
    optionId: text('option_id').notNull(),

    name: text('name').notNull(),
    summary: text('summary').notNull(),
    /** Also what decides retrofittability — see `AircraftOptionCategory`. */
    category: text('category').notNull(),

    /** `AircraftSpecDelta` as JSON text. Read whole; nothing queries inside it. */
    specDeltas: text('spec_deltas').notNull(),

    priceMinor: bigint('price_minor', { mode: 'number' }).notNull(),
    /** C.3 rule 2: options extend delivery. Weeks added to the order. */
    leadTimeWeeks: integer('lead_time_weeks').notNull(),

    /** C.3 rule 5. False for anything structural or engine-related. */
    retrofittable: boolean('retrofittable').notNull(),
    /** §10.3 topics, as a JSON array of strings. */
    requiresResearch: text('requires_research').notNull(),
    /** Option ids, as a JSON array. Asserted symmetric by test, not by constraint. */
    conflictsWith: text('conflicts_with').notNull(),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    /** Which build wrote it, so a mismatch can be traced to a release. */
    createdByLabel: text('created_by_label').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.catalogueVersion, t.optionId] }),
    check('aircraft_option_price_nonnegative', sql`${t.priceMinor} >= 0`),
    check('aircraft_option_lead_time_nonnegative', sql`${t.leadTimeWeeks} >= 0`),
  ],
);

export type AircraftOptionRow = typeof aircraftOption.$inferSelect;
export type NewAircraftOptionRow = typeof aircraftOption.$inferInsert;

/**
 * Which options a type may be ordered with — C.6's `available_options[]`.
 *
 * No foreign keys, for the same reason `world.aircraft_catalogue_version` has
 * none: a key would force the migration to seed a version, which means writing
 * eighteen aircraft and eighteen options into SQL. The seed inserts from
 * `AIRCRAFT_CATALOGUE_V1` at startup instead, and `loadCatalogue` parses on the
 * way out so a row that does not resolve is caught at read time.
 */
export const aircraftTypeOption = pgTable(
  'aircraft_type_option',
  {
    catalogueVersion: text('catalogue_version').notNull(),
    designation: text('designation').notNull(),
    optionId: text('option_id').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.catalogueVersion, t.designation, t.optionId] }),
    // The configurator's query: what can this type be ordered with?
    index('aircraft_type_option_type_idx').on(t.catalogueVersion, t.designation),
  ],
);

export type AircraftTypeOptionRow = typeof aircraftTypeOption.$inferSelect;

// ---------------------------------------------------------------------------
// Aircraft acquisition and physical airframes (M4-04, §7.2, App. C.5–C.6)
// ---------------------------------------------------------------------------

export const aircraftAcquisitionKind = pgEnum('aircraft_acquisition_kind', [
  'lease',
  'used',
  'new',
]);
export const aircraftOrderStatus = pgEnum('aircraft_order_status', ['pending', 'delivered']);
export const airframeOwnership = pgEnum('airframe_ownership', ['owned', 'leased', 'financed']);

/**
 * Whether an airframe can fly (M4-06, §7.3).
 *
 * `grounded` is the maintenance grounding only — flown past
 * `groundingOverdueMultiple` times a check's interval. Unscheduled AOG from a
 * failed part or an incident is §24's separate, unspecified area, and giving it a
 * value here would imply this milestone had modelled it.
 */
export const airframeStatus = pgEnum('airframe_status', ['in_service', 'in_check', 'grounded']);
export const usedAircraftListingStatus = pgEnum('used_aircraft_listing_status', [
  'available',
  'sold',
  'withdrawn',
]);

/**
 * A server-authored used-aircraft offer.
 *
 * M4-04 owns the purchase boundary and the configuration snapshot. M4-05 owns
 * how these rows are generated, refreshed and priced; keeping that distinction
 * means a client can select a listing id but can never submit its own cheap,
 * young, unusually configured aircraft.
 */
export const usedAircraftListing = pgTable(
  'used_aircraft_listing',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    worldId: uuid('world_id')
      .notNull()
      .references(() => world.id, { onDelete: 'cascade' }),
    catalogueVersion: text('catalogue_version').notNull(),
    typeDesignation: text('type_designation').notNull(),
    registration: text('registration').notNull(),
    buildOptionIds: text('build_option_ids').notNull().default('[]'),
    cabinConfigId: uuid('cabin_config_id'),
    liveryId: uuid('livery_id'),
    effectiveSpec: text('effective_spec').notNull(),
    ownerHistory: text('owner_history').notNull().default('[]'),
    hours: doublePrecision('hours').notNull(),
    cycles: integer('cycles').notNull(),
    askingPriceMinor: bigint('asking_price_minor', { mode: 'number' }).notNull(),
    locationIcao: text('location_icao')
      .notNull()
      .references(() => airport.icaoCode),
    status: usedAircraftListingStatus('status').notNull().default('available'),
    /**
     * Game instants, both of them: the world's own calendar, like `built_at` and
     * `expires_at` below.
     *
     * `defaultNow()` is a wall-clock fallback that only a hand-written row can
     * reach — M4-05's generator always supplies the world's `gameNow`, and
     * `soldAt` is written by the acquisition transaction, which since TIME-01
     * uses game time as well. The default is kept because dropping a `NOT NULL`
     * column's default is not an expand-safe change, not because it is right.
     */
    availableAt: timestamp('available_at', { withTimezone: true }).notNull().defaultNow(),
    soldAt: timestamp('sold_at', { withTimezone: true }),

    // --- M4-05: generation, age and the price's own explanation ------------

    /**
     * Which berth this listing occupies, and which generation filled it.
     *
     * The pair is the listing's identity in the seeded draw, and the unique
     * index over `(world, slot, generation)` is what makes the refresh
     * *idempotent by construction* rather than by hoping the engine only calls
     * it once. The tick runs every second; a game generation lasts a week. The
     * database is what stops the second call.
     *
     * Nullable because this is an expand migration: M4-04's rows and any row a
     * test wrote by hand have no berth, and the previous build — which inserts
     * neither column — has to keep working. A null slot is a hand-made listing
     * and the refresh leaves it alone.
     */
    slotIndex: integer('slot_index'),
    generationIndex: integer('generation_index'),

    /**
     * When the airframe was built, as a game-time instant.
     *
     * Age is derived from this and the world clock, never stored — the same
     * reasoning ADR-0005 gives for the world clock itself. A stored `age_years`
     * would be wrong one game day later, and wrong in a way nothing would
     * notice.
     */
    builtAt: timestamp('built_at', { withTimezone: true }),

    /** Game-time instant the listing is withdrawn if nobody has bought it. */
    expiresAt: timestamp('expires_at', { withTimezone: true }),

    /**
     * The asking price, taken apart — anchor, age factor, utilisation factor and
     * the per-option configuration drag, as JSON.
     *
     * Stored rather than recomputed on read, and that is deliberate. The
     * economy config can be re-pinned, so recomputing would eventually explain
     * an old listing with today's coefficients and quietly disagree with the
     * price beside it. Invariant 4 is the rule: a number a player cannot
     * attribute is one they will assume is a bug.
     */
    valuation: text('valuation'),
  },
  (t) => [
    index('used_aircraft_listing_world_status_idx').on(t.worldId, t.status, t.availableAt),
    // One row per berth per generation, for ever. See `slotIndex` above.
    unique('used_aircraft_listing_slot_generation_key').on(
      t.worldId,
      t.slotIndex,
      t.generationIndex,
    ),
    // The withdrawal sweep: this world's available listings, oldest expiry first.
    index('used_aircraft_listing_expiry_idx').on(t.worldId, t.status, t.expiresAt),
    check('used_aircraft_listing_hours_nonnegative', sql`${t.hours} >= 0`),
    check('used_aircraft_listing_cycles_nonnegative', sql`${t.cycles} >= 0`),
    check('used_aircraft_listing_price_nonnegative', sql`${t.askingPriceMinor} >= 0`),
    check(
      'used_aircraft_listing_slot_nonnegative',
      sql`(${t.slotIndex} IS NULL OR ${t.slotIndex} >= 0)
          AND (${t.generationIndex} IS NULL OR ${t.generationIndex} >= 0)`,
    ),
    // A berth and a generation are one fact. Half of it would be a row the
    // refresh could neither recognise nor replace.
    check(
      'used_aircraft_listing_slot_generation_together',
      sql`(${t.slotIndex} IS NULL) = (${t.generationIndex} IS NULL)`,
    ),
    check(
      'used_aircraft_listing_built_before_available',
      sql`${t.builtAt} IS NULL OR ${t.builtAt} <= ${t.availableAt}`,
    ),
    check(
      'used_aircraft_listing_sold_at_matches_status',
      sql`(${t.status} = 'sold' AND ${t.soldAt} IS NOT NULL)
          OR (${t.status} <> 'sold' AND ${t.soldAt} IS NULL)`,
    ),
    check(
      'used_aircraft_listing_registration_not_blank',
      sql`char_length(${t.registration}) BETWEEN 2 AND 10 AND ${t.registration} = btrim(${t.registration})`,
    ),
  ],
);

/** One idempotent commercial commitment, including its immutable build snapshot. */
export const aircraftOrder = pgTable(
  'aircraft_order',
  {
    /** Client request id: also the cash-movement reference. */
    id: uuid('id').primaryKey(),
    worldId: uuid('world_id')
      .notNull()
      .references(() => world.id, { onDelete: 'cascade' }),
    airlineId: uuid('airline_id')
      .notNull()
      .references(() => airline.id, { onDelete: 'cascade' }),
    kind: aircraftAcquisitionKind('kind').notNull(),
    status: aircraftOrderStatus('status').notNull(),
    catalogueVersion: text('catalogue_version').notNull(),
    typeDesignation: text('type_designation').notNull(),
    buildOptionIds: text('build_option_ids').notNull().default('[]'),
    cabinConfigId: uuid('cabin_config_id'),
    liveryId: uuid('livery_id'),
    effectiveSpec: text('effective_spec').notNull(),
    ownerHistory: text('owner_history').notNull().default('[]'),
    hours: doublePrecision('hours').notNull().default(0),
    cycles: integer('cycles').notNull().default(0),
    /**
     * Inherited from a used listing, and null for a lease or a new order — those
     * airframes are built on delivery.
     *
     * Travels the same path `hours` and `cycles` already travel, for the same
     * reason: M4-04's acceptance criterion is that *"used airframes arrive with
     * their previous owner's configuration intact"*, and an aeroplane that was
     * twelve years old in the listing and brand new once bought would be the
     * most visible way to break it.
     *
     * This is an inherited build fact on an existing path, not an identity
     * claim. HIST-01 (#508) owns the airframe identity and serial contract, and
     * nothing here anticipates it.
     */
    builtAt: timestamp('built_at', { withTimezone: true }),
    chargedMinor: bigint('charged_minor', { mode: 'number' }).notNull(),
    monthlyLeaseRateMinor: bigint('monthly_lease_rate_minor', { mode: 'number' }),
    baseLeadTimeWeeks: integer('base_lead_time_weeks').notNull(),
    optionLeadTimeWeeks: integer('option_lead_time_weeks').notNull(),
    deliveryAirportIcao: text('delivery_airport_icao')
      .notNull()
      .references(() => airport.icaoCode),
    usedListingId: uuid('used_listing_id')
      .unique()
      .references(() => usedAircraftListing.id, { onDelete: 'restrict' }),
    /**
     * All three are **game** instants on the owning world's calendar (TIME-01,
     * ADR-0025).
     *
     * They were wall-clock until then, because §7.2 called a delivery slot
     * "weeks out (real time)" — the one span inside a world that did not
     * accelerate with world speed. `delivery_at` is therefore now the same kind
     * of quantity as `airframe.check_completes_at` or a `world_event.fire_at`,
     * and the Worker's sweep compares it against `gameTime(clock, now())`.
     *
     * Rows written before migration 0050 were converted through their world's
     * clock, so a pending order still arrives at the real instant it was
     * promised. The consequence for those rows only: `delivery_at - ordered_at`
     * is the *game* span the same real wait now buys, so it no longer equals
     * `base_lead_time_weeks + option_lead_time_weeks`. Legacy arithmetic, not a
     * new invariant — do not "repair" it by rewriting the lead weeks, which are
     * the immutable commercial fact the order was priced under.
     */
    orderedAt: timestamp('ordered_at', { withTimezone: true }).notNull(),
    deliveryAt: timestamp('delivery_at', { withTimezone: true }).notNull(),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
  },
  (t) => [
    index('aircraft_order_airline_ordered_at_idx').on(t.airlineId, t.orderedAt),
    index('aircraft_order_due_idx').on(t.worldId, t.status, t.deliveryAt),
    check('aircraft_order_charge_nonnegative', sql`${t.chargedMinor} >= 0`),
    check(
      'aircraft_order_lease_rate_nonnegative',
      sql`${t.monthlyLeaseRateMinor} IS NULL OR ${t.monthlyLeaseRateMinor} >= 0`,
    ),
    check(
      'aircraft_order_lead_times_nonnegative',
      sql`${t.baseLeadTimeWeeks} >= 0 AND ${t.optionLeadTimeWeeks} >= 0`,
    ),
    check('aircraft_order_hours_nonnegative', sql`${t.hours} >= 0`),
    check('aircraft_order_cycles_nonnegative', sql`${t.cycles} >= 0`),
    check('aircraft_order_delivery_not_before_order', sql`${t.deliveryAt} >= ${t.orderedAt}`),
    check(
      'aircraft_order_delivered_at_matches_status',
      sql`(${t.status} = 'delivered' AND ${t.deliveredAt} IS NOT NULL)
          OR (${t.status} = 'pending' AND ${t.deliveredAt} IS NULL)`,
    ),
    check(
      'aircraft_order_kind_terms_match',
      sql`(${t.kind} = 'lease' AND ${t.monthlyLeaseRateMinor} IS NOT NULL AND ${t.usedListingId} IS NULL)
          OR (${t.kind} = 'used' AND ${t.monthlyLeaseRateMinor} IS NULL AND ${t.usedListingId} IS NOT NULL)
          OR (${t.kind} = 'new' AND ${t.monthlyLeaseRateMinor} IS NULL AND ${t.usedListingId} IS NULL)`,
    ),
  ],
);

/** The physical object delivered by an order; its configuration never comes from the client. */
export const airframe = pgTable(
  'airframe',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    worldId: uuid('world_id')
      .notNull()
      .references(() => world.id, { onDelete: 'cascade' }),
    airlineId: uuid('airline_id')
      .notNull()
      .references(() => airline.id, { onDelete: 'cascade' }),
    sourceOrderId: uuid('source_order_id')
      .notNull()
      .unique()
      .references(() => aircraftOrder.id, { onDelete: 'restrict' }),
    catalogueVersion: text('catalogue_version').notNull(),
    typeDesignation: text('type_designation').notNull(),
    registration: text('registration').notNull(),
    buildOptionIds: text('build_option_ids').notNull().default('[]'),
    cabinConfigId: uuid('cabin_config_id'),
    liveryId: uuid('livery_id'),
    effectiveSpec: text('effective_spec').notNull(),
    ownerHistory: text('owner_history').notNull().default('[]'),
    hours: doublePrecision('hours').notNull().default(0),
    cycles: integer('cycles').notNull().default(0),
    ownership: airframeOwnership('ownership').notNull(),
    /** Carried from the order, so a bought used aircraft keeps its age (M4-05). */
    builtAt: timestamp('built_at', { withTimezone: true }),
    deliveredToIcao: text('delivered_to_icao')
      .notNull()
      .references(() => airport.icaoCode),
    /**
     * When this aeroplane entered the world, as a **game** instant (TIME-01).
     *
     * Carried from the order, so it is the world's calendar for the same reason
     * `built_at` beside it always was. `created_at` below is the row's own
     * wall-clock audit stamp and is the only real instant on this table — the
     * two are not interchangeable and the fleet's utilisation window reads this
     * one.
     */
    deliveredAt: timestamp('delivered_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),

    // --- M4-06: maintenance -------------------------------------------------

    /**
     * `MaintenanceState`'s per-tier "hours and cycles at last check", as JSON.
     *
     * A blob rather than six columns because nothing queries inside it: the due
     * calculation needs the whole state or none of it, and a fleet is small
     * enough to fold in the application. Same treatment `effective_spec` and
     * `owner_history` already get, and the same reason.
     *
     * Nullable, because this is an expand migration: airframes delivered before
     * M4-06 have no recorded history, and `null` is read as *"every tier last
     * done at the hours it has now"* rather than as *"catastrophically overdue"*.
     * Grounding an existing fleet on deploy would be the worst possible reading.
     */
    maintenanceState: text('maintenance_state'),

    /**
     * Whether the aeroplane can fly, and why not.
     *
     * A column rather than a derived value, because two of the three states are
     * facts about the world rather than about the totals: a check that is running
     * has a finish time, and `grounded` is a latch a player has to clear. Only
     * `in_service` is the absence of anything.
     */
    status: airframeStatus('status').notNull().default('in_service'),
    /** Which tier is running, when `status = 'in_check'`. */
    checkTier: text('check_tier'),
    /** Game-time instant the running check finishes. The worker sweeps on it. */
    checkCompletesAt: timestamp('check_completes_at', { withTimezone: true }),

    // --- M8-07: §13.5's fourth rung ------------------------------------------

    /**
     * Game time a lender seized this aeroplane, or null while the airline has it.
     *
     * A marker rather than a `DELETE`, and the reason is the same one
     * `loan.secured_airframe_id` gives for carrying no foreign key: `flight`,
     * `schedule` and every maintenance row point here by id without one, so a
     * deleted airframe would leave a settled flight unable to say what flew it.
     * §13.5's *"you keep the livery, not the airframe"* also needs the row to
     * survive — `livery_id` lives on it, and the document the player keeps is the
     * one this column must not take with it.
     *
     * A seized airframe is **out of the fleet**: excluded from the fleet list,
     * from what may be dispatched, from maintenance and from the tangible assets
     * a lender will advance against. It is also grounded, so the dispatch gate
     * refuses it even if a query somewhere forgets to filter.
     */
    repossessedAt: timestamp('repossessed_at', { withTimezone: true }),
  },
  (t) => [
    unique('airframe_world_registration_key').on(t.worldId, t.registration),
    index('airframe_airline_id_idx').on(t.airlineId),
    // The worker's completion sweep: this world's running checks, soonest first.
    index('airframe_check_due_idx').on(t.worldId, t.status, t.checkCompletesAt),
    check('airframe_hours_nonnegative', sql`${t.hours} >= 0`),
    check(
      'airframe_check_tier_valid',
      sql`${t.checkTier} IS NULL OR ${t.checkTier} IN ('a', 'c', 'd')`,
    ),
    // A running check is a tier and a finish time together, or it is not running.
    // Half of it would be a row the sweep could neither finish nor recognise.
    check(
      'airframe_in_check_has_terms',
      sql`(${t.status} = 'in_check'
             AND ${t.checkTier} IS NOT NULL AND ${t.checkCompletesAt} IS NOT NULL)
          OR (${t.status} <> 'in_check'
             AND ${t.checkTier} IS NULL AND ${t.checkCompletesAt} IS NULL)`,
    ),
    check('airframe_cycles_nonnegative', sql`${t.cycles} >= 0`),
    check(
      'airframe_registration_not_blank',
      sql`char_length(${t.registration}) BETWEEN 2 AND 10 AND ${t.registration} = btrim(${t.registration})`,
    ),
  ],
);

export type AircraftOrderRow = typeof aircraftOrder.$inferSelect;
export type NewAircraftOrderRow = typeof aircraftOrder.$inferInsert;
export type AirframeRow = typeof airframe.$inferSelect;
export type NewAirframeRow = typeof airframe.$inferInsert;
export type UsedAircraftListingRow = typeof usedAircraftListing.$inferSelect;
export type NewUsedAircraftListingRow = typeof usedAircraftListing.$inferInsert;

// ---------------------------------------------------------------------------
// Crew (M5-01, section 9.2)
// ---------------------------------------------------------------------------

/**
 * The flight-deck and cabin ladders, as one enum.
 *
 * One enum rather than two because a pool row holds exactly one rank and the
 * ladders never mix within a row; two enums would need two nullable columns and
 * a check constraint to keep exactly one of them filled. `@tailfin/sim`'s
 * `coversRank` is what knows a Captain cannot serve the cabin, and it refuses
 * across ladders regardless of what the column can hold.
 */
export const crewRank = pgEnum('crew_rank', [
  'cadet',
  'first_officer',
  'senior_first_officer',
  'captain',
  'training_captain',
  'cabin_crew',
  'senior_cabin_crew',
  'purser',
  'cabin_service_manager',
]);
export type CrewRankValue = (typeof crewRank.enumValues)[number];

export const crewBaseStatus = pgEnum('crew_base_status', ['open', 'closed']);

/**
 * What a base pays, relative to the book rate (M5-03, section 9.2).
 *
 * Bands rather than a multiplier the player types. Section 9.2 wants a decision
 * -- pay under the odds, pay the rate, or pay up -- and a slider turns that into
 * a hunt for the figure that buys the most morale per unit of cash.
 */
export const payBand = pgEnum('pay_band', ['lean', 'market', 'generous']);

/** What the crew sleep in when a duty period ends away from base (M5-03). */
export const hotelTier = pgEnum('hotel_tier', ['budget', 'standard', 'premium']);

/**
 * A crew base: an airline's presence at an airport, with its own hiring pool.
 *
 * Section 9.2 calls it an unlockable facility with its own hiring pool and cost
 * structure, and the cost structure is what stops an airline opening one per
 * destination: a monthly overhead falls due whether or not anybody is posted
 * there.
 *
 * Unique on `(airline_id, airport_icao)` — an airline has one base at an
 * airport or none. A base that is closed keeps its row so the audit trail of
 * what was paid for survives, which is why the uniqueness is not partial.
 */
export const crewBase = pgTable(
  'crew_base',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    worldId: uuid('world_id')
      .notNull()
      .references(() => world.id, { onDelete: 'cascade' }),
    airlineId: uuid('airline_id')
      .notNull()
      .references(() => airline.id, { onDelete: 'cascade' }),
    airportIcao: text('airport_icao')
      .notNull()
      .references(() => airport.icaoCode),

    status: crewBaseStatus('status').notNull().default('open'),

    /** The two policies M5-03 gives the player. Both cost money and buy morale. */
    payBand: payBand('pay_band').notNull().default('market'),
    hotelTier: hotelTier('hotel_tier').notNull().default('standard'),

    /**
     * Morale, 0-1. **Null means never reviewed**, not zero.
     *
     * A state rather than a formula: the four inputs give a *target* and this
     * eases toward it over game weeks, which is the delay section 9.2 asks for.
     * Without the gap there is no delayed bill and no decision worth making.
     *
     * Null rather than a default of 0.65, and the distinction is load-bearing
     * twice over. A base opened a minute ago has no morale history and reads as
     * its balance's `startingMorale`; a base reading 0 has been run into the
     * ground. And putting 0.65 in the schema would be a **balance literal in a
     * migration** -- retuning `startingMorale` afterwards would not move it, and
     * CLAUDE.md's rule is that the economy is a row and not a constant.
     *
     * The same shape as `airframe.maintenance_state`, and the same warning: do
     * not tidy this into a zero.
     */
    morale: doublePrecision('morale'),
    /** Game time of the last morale review. Null alongside `morale`. */
    moraleReviewedAt: timestamp('morale_reviewed_at', { withTimezone: true }),

    /** Game time, so a reset moves it with everything else (ADR-0005). */
    openedAt: timestamp('opened_at', { withTimezone: true }).notNull(),
    closedAt: timestamp('closed_at', { withTimezone: true }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('crew_base_airline_airport_key').on(t.airlineId, t.airportIcao),
    index('crew_base_airline_idx').on(t.airlineId),
    index('crew_base_world_idx').on(t.worldId),
  ],
);

/**
 * Heads at one rank, rated on one family, at one base.
 *
 * **A count, not a roster.** M5-01's acceptance criterion is that the player
 * interacts with pool sizes and never with individuals, so there is deliberately
 * no crew member table for this to reference. Individual hours and proficiency
 * are M9; if one arrives it should hang off this rather than replace it.
 *
 * `family` is text and not a foreign key to `aircraft_type`, because a family is
 * a property of several types rather than a table of its own — and because a
 * pool must survive a catalogue version that no longer lists the type it was
 * hired for. Crew do not lose their rating when a model leaves the price list.
 *
 * `unavailable` counts heads in conversion training. Held here rather than
 * subtracted from `headcount` so the player can see that their crew exist but
 * are in a classroom, which is the entire point of conversion taking time.
 */
export const crewPool = pgTable(
  'crew_pool',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    crewBaseId: uuid('crew_base_id')
      .notNull()
      .references(() => crewBase.id, { onDelete: 'cascade' }),

    family: text('family').notNull(),
    rank: crewRank('rank').notNull(),

    headcount: integer('headcount').notNull().default(0),
    unavailable: integer('unavailable').notNull().default(0),

    /**
     * Heads inside an open duty period, or serving the rest that follows one
     * (M5-02).
     *
     * Separate from `unavailable` because the two are different answers to the
     * player's question. A crew member in a classroom is gone for a fortnight
     * and the fix is to wait; one who is resting is back tonight and the fix is
     * to hire, or to keep a reserve. Folding them together would leave the Crew
     * page unable to tell those apart, and they are the two halves of section
     * 9.2's *"cost money and do nothing most days"* trade.
     */
    onDuty: integer('on_duty').notNull().default(0),
    /**
     * Heads the player has designated standby (section 9.2).
     *
     * A **designation, not a separate pool**: reserves are ordinary crew of this
     * rank and rating who are held back from the roster, so they draw the same
     * salary and can cover any flight the rest of the pool could. Modelling them
     * as their own pool would have meant a second set of ranks, a second set of
     * ratings and a second conversion path, all to express "not rostered today".
     *
     * They are what a timed-out crew is replaced from, which is the whole point:
     * section 9.2 calls the reserve *"deliberately a hard call"* because the
     * money is spent whether or not the day goes wrong.
     */
    reserve: integer('reserve').notNull().default(0),

    /**
     * Heads off sick (M5-03, section 9.2).
     *
     * A fourth bucket rather than a flavour of `unavailable`, for the reason
     * `on_duty` is a third: the fixes differ. A classroom is a fortnight and you
     * wait; a duty is a night and you hire or keep a reserve; sickness is a
     * symptom, and the fix is upstream of the roster entirely.
     */
    sick: integer('sick').notNull().default(0),
    /** Game time the sick heads come back. Null when nobody is off. */
    sickUntil: timestamp('sick_until', { withTimezone: true }),

    /**
     * Experience this pool has accumulated, in §10.2's XP (M9-02).
     *
     * ## A pool total, because there is still no crew member row
     *
     * M5-01's rule is that *"the player interacts with pool sizes and never
     * with individuals"*, and the comment on this table says the quiet part:
     * *"Individual hours and proficiency are M9; if one arrives it should hang
     * off this rather than replace it."* This is that arrival, and it hangs off
     * the pool: every head aboard a flight earns the same XP, and the sum lands
     * here.
     *
     * The readout a player wants is **XP per head** — `xp / headcount` — and
     * that behaves correctly in both directions. Hiring adds heads and no XP, so
     * the average falls: a base that doubles its headcount really does have a
     * greener crew force. Heads that **leave** take their share with them
     * (`reviewCrewMorale` removes it pro rata), because a resignation that left
     * the XP behind would make the survivors look better for having lost
     * colleagues.
     *
     * M9-03's personal skill trees will need individuals; when they arrive they
     * should draw from this rather than replace it, which is what keeps a base's
     * total history intact across that change.
     *
     * `bigint` rather than `integer`: a long-lived base flying widebodies earns
     * a few thousand a sector, and 2.1 billion is about ten world-years of a
     * large operation. Not a limit worth discovering in production.
     */
    xp: bigint('xp', { mode: 'number' }).notNull().default(0),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('crew_pool_base_family_rank_key').on(t.crewBaseId, t.family, t.rank),
    check('crew_pool_xp_nonneg', sql`${t.xp} >= 0`),
    index('crew_pool_base_idx').on(t.crewBaseId),
    // The worker's claim: pools whose sick leave has run out.
    index('crew_pool_sick_idx').on(t.sickUntil),
    check('crew_pool_headcount_nonneg', sql`${t.headcount} >= 0`),
    // The three together: never more people committed than there are on strength.
    check(
      'crew_pool_unavailable_within_headcount',
      sql`${t.unavailable} >= 0 AND ${t.unavailable} <= ${t.headcount}`,
    ),
    check(
      'crew_pool_on_duty_within_headcount',
      sql`${t.onDuty} >= 0 AND ${t.unavailable} + ${t.onDuty} <= ${t.headcount}`,
    ),
    check(
      'crew_pool_reserve_within_headcount',
      sql`${t.reserve} >= 0 AND ${t.reserve} <= ${t.headcount}`,
    ),
    /*
     * Sick heads sit alongside the classroom and the aeroplane rather than
     * inside either, so all three together still cannot exceed the payroll.
     * Without this an unlucky week could take a pool's committed heads past its
     * headcount and the arithmetic would stop meaning anything.
     */
    check(
      'crew_pool_sick_within_headcount',
      sql`${t.sick} >= 0 AND ${t.unavailable} + ${t.onDuty} + ${t.sick} <= ${t.headcount}`,
    ),
  ],
);

/**
 * A build inside §10.1: going up, or finished and teaching.
 *
 * Two states and no third. There is no `cancelled`: §10.1 gives construction a
 * capital cost and a duration and no way back, and a status nobody can reach
 * would be a mechanic sitting in the schema looking load-bearing — the same
 * argument `hub_facility` makes for having no `closed_at`.
 */
export const academyBuildStatus = pgEnum('academy_build_status', [
  'under_construction',
  'operational',
]);
export type AcademyBuildStatusValue = (typeof academyBuildStatus.enumValues)[number];

/** §10.1's seven modules. The shared `AcademyModuleKind` is the mirror of this. */
export const academyModuleKind = pgEnum('academy_module_kind', [
  'cbt_suite',
  'cabin_service_mockup',
  'emergency_drill',
  'fixed_base_sim',
  'full_flight_sim',
  'ground_ops_bay',
  'dispatch_lab',
]);
export type AcademyModuleKindValue = (typeof academyModuleKind.enumValues)[number];

/**
 * A training academy at a crew base (M9-01, §10.1).
 *
 * ## At a crew base, and the conflict that has to be named
 *
 * §10.1 opens *"Built at a crew base. One academy per base"*, and M9-01's issue
 * repeats it. §21's facility list says instead that an academy is *"unlocked per
 * hub"*, and M7-04 built that: `hub_facility` already has a `training_academy`
 * kind with an opening cost and an annual fee. The two statements disagree, and
 * this table follows §10.1 — the section M9-01 cites, and the specific one.
 *
 * The `hub_facility` row is left exactly as M7-04 shipped it and gates nothing
 * here. Making it a prerequisite would invent a rule neither section states, and
 * would strip the academy from every airline whose crew base is not at a hub.
 * See `docs/training-academy.md`; the conflict is recorded on the issue.
 *
 * ## Every instant on this row is **game** time
 *
 * §10.1 says construction takes *real* weeks. [ADR-0026](../../../../docs/adr/0026-in-world-spans-are-game-time.md)
 * names academy construction among the unbuilt spans it settles, and settles it
 * the other way: a span inside a world runs on the world's clock unless it is
 * genuinely a real-world quantity in the way an exchange rate is. A building at
 * a crew base, staffed and teaching this world's crew, is not — and TIME-01's
 * finding about factory orders applies unchanged, that a wall clock here would
 * make a 4× world specifically and only worse at building academies.
 *
 * The acceptance criterion that sentence existed to serve is kept and is
 * stronger for being structural: **nothing shortens a build**. There is no rush
 * cost, no balance lever and no endpoint that moves `construction_ready_at`
 * closer, so the rule holds by absence rather than by a check somebody could
 * later relax.
 *
 * So `construction_started_at`, `construction_ready_at` and
 * `academy_module.ready_at` are game instants like `crew_conversion.completes_at`,
 * and the worker's commissioning sweep compares them against
 * `gameTime(clock, now())`. `created_at` stays real, like every `created_at`.
 *
 * ## Level 0 is a building site, not a level
 *
 * A row is written when the player commissions level 1, with `level = 0` and
 * `pending_level = 1`. Nothing is permitted at 0 — not a rank, not a research
 * tier, not a training slot — which is the third acceptance criterion holding
 * automatically: there is no state in which the money has been taken and the
 * capability has arrived early.
 */
export const academy = pgTable(
  'academy',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    worldId: uuid('world_id')
      .notNull()
      .references(() => world.id, { onDelete: 'cascade' }),
    airlineId: uuid('airline_id')
      .notNull()
      .references(() => airline.id, { onDelete: 'cascade' }),
    /** §10.1's *"one academy per base"*, enforced by the unique below. */
    crewBaseId: uuid('crew_base_id')
      .notNull()
      .references(() => crewBase.id, { onDelete: 'cascade' }),

    /** The commissioned level, 0-5. **0 means nothing is operational yet.** */
    level: integer('level').notNull().default(0),
    /** The level being built toward, or null when nothing is under construction. */
    pendingLevel: integer('pending_level'),

    /** Both **game** time (ADR-0026). Null together with `pending_level`. */
    constructionStartedAt: timestamp('construction_started_at', { withTimezone: true }),
    constructionReadyAt: timestamp('construction_ready_at', { withTimezone: true }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('academy_crew_base_key').on(t.crewBaseId),
    index('academy_airline_idx').on(t.airlineId),
    /*
     * The worker's claim: this world's academies whose construction is due.
     * Partial, because the overwhelming majority of rows are finished buildings
     * that the sweep must not have to read past.
     */
    index('academy_due_idx')
      .on(t.worldId, t.constructionReadyAt)
      .where(sql`pending_level IS NOT NULL`),
    check('academy_level_range', sql`${t.level} >= 0 AND ${t.level} <= 5`),
    /*
     * One level at a time, and always the next one. §10.1's ladder is climbed,
     * not jumped: without this a client could commission level 5 directly and
     * pay one level's price for four levels of ceiling.
     */
    check(
      'academy_pending_level_is_next',
      sql`${t.pendingLevel} IS NULL
          OR (${t.pendingLevel} = ${t.level} + 1 AND ${t.pendingLevel} <= 5)`,
    ),
    /*
     * A build is a target and two instants together, or it is not a build. Any
     * half of it would be a row the sweep could neither finish nor recognise —
     * the same shape `airframe_in_check_has_terms` guards for a running check.
     */
    check(
      'academy_construction_terms',
      sql`(${t.pendingLevel} IS NULL
             AND ${t.constructionStartedAt} IS NULL
             AND ${t.constructionReadyAt} IS NULL)
          OR (${t.pendingLevel} IS NOT NULL
             AND ${t.constructionStartedAt} IS NOT NULL
             AND ${t.constructionReadyAt} IS NOT NULL
             AND ${t.constructionReadyAt} > ${t.constructionStartedAt})`,
    ),
  ],
);

/**
 * A module inside an academy (§10.1).
 *
 * *"Modules determine **what** you can train; academy level determines **how
 * far**."* Built independently of each other and of the level, each with its own
 * capital cost, real-week build and monthly upkeep.
 *
 * `family` is set for `full_flight_sim` and null for everything else — §10.1
 * names the full-flight sim *"per aircraft family"* and no other module that
 * way, because a simulator is one aeroplane's cockpit and the rest are rooms.
 * Text rather than a foreign key, for the reason `crew_pool.family` is: a family
 * is a property of several types rather than a table, and an installed simulator
 * must survive a catalogue version that no longer lists the type it was bought
 * for.
 *
 * Uniqueness is two partial indexes rather than one constraint, because
 * PostgreSQL treats NULLs as distinct and a single `(academy, kind, family)`
 * unique would happily allow six CBT suites.
 */
export const academyModule = pgTable(
  'academy_module',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    academyId: uuid('academy_id')
      .notNull()
      .references(() => academy.id, { onDelete: 'cascade' }),

    kind: academyModuleKind('kind').notNull(),
    /** The aircraft family, for `full_flight_sim` only. */
    family: text('family'),

    status: academyBuildStatus('status').notNull().default('under_construction'),

    /** All three **game** time, like the academy's own (ADR-0026). */
    startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
    readyAt: timestamp('ready_at', { withTimezone: true }).notNull(),
    installedAt: timestamp('installed_at', { withTimezone: true }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('academy_module_kind_key')
      .on(t.academyId, t.kind)
      .where(sql`family IS NULL`),
    uniqueIndex('academy_module_family_key')
      .on(t.academyId, t.kind, t.family)
      .where(sql`family IS NOT NULL`),
    // The worker's claim: modules whose fit-out is due.
    index('academy_module_due_idx').on(t.status, t.readyAt),
    check(
      'academy_module_family_matches_kind',
      sql`(${t.kind} = 'full_flight_sim') = (${t.family} IS NOT NULL)`,
    ),
    check('academy_module_ready_after_start', sql`${t.readyAt} > ${t.startedAt}`),
    check(
      'academy_module_installed_matches_status',
      sql`(${t.status} = 'operational' AND ${t.installedAt} IS NOT NULL)
          OR (${t.status} = 'under_construction' AND ${t.installedAt} IS NULL)`,
    ),
  ],
);

export const crewConversionStatus = pgEnum('crew_conversion_status', [
  'in_training',
  'completed',
  'cancelled',
]);

/**
 * Crew being converted from one family rating to another (section 9.2).
 *
 * The mechanical teeth behind fleet commonality. The money matters less than the
 * fortnight: a fleet decision that costs cash is a line in the accounts, and one
 * that takes crew off the roster is felt in the schedule.
 *
 * `completes_at` is **game time**, like `world_event.fire_at` and unlike
 * `aircraft_order.delivery_at`. A conversion is training inside the world, so it
 * should run at the world's speed — a world at 4x trains twice as fast in real
 * time as one at 2x, which is the same rule the used market and maintenance
 * follow. Aircraft deliveries are the deliberate exception, because section 7.2
 * says real weeks for those.
 *
 * The heads are recorded on the row rather than inferred from the pools, so the
 * worker completing a conversion does not have to guess how many of a pool's
 * `unavailable` belonged to which course.
 */
export const crewConversion = pgTable(
  'crew_conversion',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    crewBaseId: uuid('crew_base_id')
      .notNull()
      .references(() => crewBase.id, { onDelete: 'cascade' }),

    fromFamily: text('from_family').notNull(),
    toFamily: text('to_family').notNull(),
    rank: crewRank('rank').notNull(),
    heads: integer('heads').notNull(),

    status: crewConversionStatus('status').notNull().default('in_training'),

    /**
     * The academy that trained this course in-house, or **null for a course
     * bought in** (M9-01, §10.1).
     *
     * One column carrying one fact rather than a boolean beside it: a course is
     * in-house exactly when an academy carried it, and two columns could
     * disagree. It is also the slot ledger — §10.1's finite training slots are
     * `sum(heads)` over the `in_training` rows pointing here, which needs no
     * counter column and therefore nothing for ADR-0005's world reset to forget
     * to clear.
     *
     * Null on every row written before M9-01, which reads correctly as what
     * those courses were: outsourced at the market rate, because there were no
     * academies.
     */
    academyId: uuid('academy_id').references(() => academy.id, { onDelete: 'set null' }),

    /** Both game time. */
    startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
    completesAt: timestamp('completes_at', { withTimezone: true }).notNull(),
    completedAt: timestamp('completed_at', { withTimezone: true }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('crew_conversion_base_idx').on(t.crewBaseId),
    // The slot count: courses running at one academy right now.
    index('crew_conversion_academy_idx').on(t.academyId, t.status),
    // The worker's claim query: due, and not yet dealt with.
    index('crew_conversion_due_idx').on(t.status, t.completesAt),
    check('crew_conversion_heads_positive', sql`${t.heads} > 0`),
    check('crew_conversion_families_differ', sql`${t.fromFamily} <> ${t.toFamily}`),
    check('crew_conversion_completes_after_start', sql`${t.completesAt} > ${t.startedAt}`),
  ],
);

export const crewDutyStatus = pgEnum('crew_duty_status', ['open', 'resting', 'closed']);

/**
 * A duty period: one crew set, one airframe, report to off duty (M5-02, section 9.2).
 *
 * ## What has a duty period, when nobody has a name
 *
 * M5-01's invariant is that the player never touches an individual roster, and
 * this does not break it. The regulation does not constrain *people* either - it
 * constrains **a duty**, which is a span of time with a report and an off-duty
 * and some flying in the middle. So that is the row. Heads are drawn from the
 * pools as a count and returned as a count; which particular cabin crew member
 * worked Tuesday is a question the game still cannot answer, and still does not
 * need to.
 *
 * It hangs off the **airframe** because that is what physically carries the crew
 * from one sector to the next. A crew set exists as long as an aeroplane keeps
 * flying inside one duty period, and a new one opens when the last has rested.
 *
 * ## Game time throughout
 *
 * `report_at`, `off_duty_at` and `rest_until` are game time, like
 * `world_event.fire_at` and `crew_conversion.completes_at` - a duty period
 * happens inside the world, so a world at 4x rests twice as fast in real time as
 * one at 2x. Section 7.2's factory lead time remains the one deliberate
 * exception in the fleet.
 *
 * ## Why `sectors` and `block_minutes` are stored rather than derived
 *
 * They could be summed from the flights pointing at this row. They are stored
 * because the *limit* reads them on the next dispatch, on the hot path, once per
 * departure - and because a flight cancelled after the crew reported still cost
 * the crew their report. The counters are what happened to the crew; the flights
 * are what happened to the passengers, and those are not always the same story.
 */
export const crewDutyPeriod = pgTable(
  'crew_duty_period',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    worldId: uuid('world_id')
      .notNull()
      .references(() => world.id, { onDelete: 'cascade' }),
    airlineId: uuid('airline_id')
      .notNull()
      .references(() => airline.id, { onDelete: 'cascade' }),
    /** No foreign key, for the same reason as `flight.airframe_id`. */
    airframeId: uuid('airframe_id').notNull(),
    crewBaseId: uuid('crew_base_id')
      .notNull()
      .references(() => crewBase.id, { onDelete: 'cascade' }),

    /** The rating the set holds. A duty period cannot change family mid-day. */
    family: text('family').notNull(),
    /** Complement size. Derivable from `complement`, kept for the per-head costs. */
    heads: integer('heads').notNull(),
    /**
     * The rank breakdown actually taken from the pools, as JSON.
     *
     * `[{ "rank": "captain", "count": 2 }, ...]`. Stored rather than recomputed
     * because releasing the heads has to be the **exact inverse** of taking
     * them: the complement depends on the block time of the sector that opened
     * the period, and a set that flew a short sector and then a long one would
     * be credited back more heads than it borrowed if the release recomputed
     * from the wrong leg. JSON text, like `flight.load`; nothing queries inside
     * it.
     */
    complement: text('complement').notNull().default('[]'),
    /**
     * True when this set was called out from the standby designation.
     *
     * Recorded rather than inferred, so that *"reserve crew measurably improve
     * on-time performance"* is a query and not an argument.
     */
    fromReserve: boolean('from_reserve').notNull().default(false),

    status: crewDutyStatus('status').notNull().default('open'),

    /** Game time. */
    reportAt: timestamp('report_at', { withTimezone: true }).notNull(),
    /** Null while the set is still working. */
    offDutyAt: timestamp('off_duty_at', { withTimezone: true }),
    /** Game time the rest ends and the heads return to the pool. */
    restUntil: timestamp('rest_until', { withTimezone: true }),

    /** Operating sectors flown. Deadheads are not counted, per ORO.FTL.205(e). */
    sectors: integer('sectors').notNull().default(0),
    blockMinutes: integer('block_minutes').notNull().default(0),
    /**
     * Game time the last sector was due to land. Null before the first one.
     *
     * What tells an idle crew set from a busy one. A period stays open between
     * sectors because a 45-minute turnaround is not a rest - so something has to
     * decide when the day is simply over, and the answer is *nothing was
     * dispatched before the crew could have gone home*. Without this column that
     * question needs a scan of the flights pointing at the row, once per tick,
     * per open period.
     */
    lastArrivalAt: timestamp('last_arrival_at', { withTimezone: true }),

    /** Where the crew physically are. The positioning question, answered. */
    locationIcao: text('location_icao')
      .notNull()
      .references(() => airport.icaoCode),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    /*
     * The dispatch lookup: the open set for this aeroplane. Partial, because
     * only one duty period per airframe may be open at a time, and the closed
     * ones are history that grows without bound.
     */
    uniqueIndex('crew_duty_period_open_airframe_key')
      .on(t.airframeId)
      .where(sql`status = 'open'`),
    index('crew_duty_period_airline_idx').on(t.airlineId, t.reportAt),
    // The worker's claim: sets whose rest is due to finish.
    index('crew_duty_period_resting_idx').on(t.status, t.restUntil),
    index('crew_duty_period_world_idx').on(t.worldId),
    check('crew_duty_period_heads_positive', sql`${t.heads} > 0`),
    check('crew_duty_period_sectors_nonneg', sql`${t.sectors} >= 0`),
    check('crew_duty_period_block_nonneg', sql`${t.blockMinutes} >= 0`),
    check(
      'crew_duty_period_off_duty_after_report',
      sql`${t.offDutyAt} IS NULL OR ${t.offDutyAt} >= ${t.reportAt}`,
    ),
  ],
);

/**
 * Office hires (M5-04, section 9.1).
 *
 * One row per filled seat: which candidate an airline put in which role, in
 * which world, and the salary the worker bills monthly. `role` is the
 * `@tailfin/shared` `OfficeRole` string; the salary is snapshotted at hire so a
 * later retune of the role catalogue cannot silently re-bill a standing hire.
 *
 * A seat holds one person: `(airline_id, role)` is unique, so hiring a rival
 * into a filled seat is a replace, never a second row. Both foreign keys cascade
 * -- an airline reset or a world reset takes its office with it, which is
 * ADR-0005's requirement, not a convenience.
 */
export const officeHire = pgTable(
  'office_hire',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    worldId: uuid('world_id')
      .notNull()
      .references(() => world.id, { onDelete: 'cascade' }),
    airlineId: uuid('airline_id')
      .notNull()
      .references(() => airline.id, { onDelete: 'cascade' }),
    /**
     * A `@tailfin/shared` `OfficeSeatId` — one of the six roles, or a neutral
     * expansion seat (`neutral-1`..`neutral-4`). The column keeps its name from
     * before expansion existed; the unique index below keys one hire per seat,
     * and a neutral seat's id never collides with a role's.
     */
    role: text('role').notNull(),
    /** Opaque candidate identity, for the client to render whom you hired. */
    candidateId: text('candidate_id').notNull(),
    candidateName: text('candidate_name').notNull(),
    /** Salary per game month, minor units, snapshotted at hire. */
    monthlySalaryMinor: bigint('monthly_salary_minor', { mode: 'number' }).notNull(),
    /**
     * A **game** instant on the airline's world clock (TIME-02).
     *
     * It has to be the same calendar as the game month the salary above is billed
     * in. `defaultNow()` is a wall-clock fallback that no code path reaches --
     * `hireOffice` passes the world's `gameNow` on both the insert and the upsert
     * -- and is kept only because dropping a default is not an expand-safe change.
     */
    hiredAt: timestamp('hired_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('office_hire_airline_role_key').on(table.airlineId, table.role)],
);

export type OfficeHireRow = typeof officeHire.$inferSelect;

/**
 * How far an airline has expanded its headquarters (M5-04, §9.1 "Expand HQ").
 *
 * The presence of a row means the airline has bought at least the first
 * expansion; `neutralSeats` is the cumulative count of neutral offices unlocked
 * (2 or 4). No row means the base six offices and no neutral seats — so the
 * table needs no zero default and a world reset that deletes the row restores
 * the unexpanded state (ADR-0005). The purchase itself is an AIR-06
 * `office_expansion` cash movement; this row records only the structural unlock.
 */
export const officeExpansion = pgTable(
  'office_expansion',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    worldId: uuid('world_id')
      .notNull()
      .references(() => world.id, { onDelete: 'cascade' }),
    airlineId: uuid('airline_id')
      .notNull()
      .references(() => airline.id, { onDelete: 'cascade' }),
    /** Cumulative neutral seats unlocked — 2 or 4. */
    neutralSeats: integer('neutral_seats').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('office_expansion_airline_key').on(table.airlineId)],
);

export type OfficeExpansionRow = typeof officeExpansion.$inferSelect;

/**
 * How far an airline has opened its executive floor (§9.1 follow-up).
 *
 * The presence of a row means the executive floor itself is unlocked;
 * `officesUnlocked` is how many of its ten offices are open (0–10), and they open
 * in order, right to left. Like {@link officeExpansion}, no row is the default —
 * the floor is closed, no offices — so a fresh airline needs no seed and a world
 * reset that deletes the row restores the closed state (ADR-0005). The unlocks
 * themselves are AIR-06 cash movements (`executive_floor` and `executive_office`);
 * this row records only the structural unlock.
 */
export const executiveFloor = pgTable(
  'executive_floor',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    worldId: uuid('world_id')
      .notNull()
      .references(() => world.id, { onDelete: 'cascade' }),
    airlineId: uuid('airline_id')
      .notNull()
      .references(() => airline.id, { onDelete: 'cascade' }),
    /** Executive offices opened so far — 0 to 10, opening right to left. */
    officesUnlocked: integer('offices_unlocked').notNull().default(0),
    unlockedAt: timestamp('unlocked_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('executive_floor_airline_key').on(table.airlineId)],
);

export type ExecutiveFloorRow = typeof executiveFloor.$inferSelect;

/**
 * One C-Suite member staffing one executive office (§9.1 follow-up, Phase 2).
 *
 * Unlike {@link officeHire}, an executive office is **generic**: there is no seat
 * role, so a row records only which candidate an airline employs, and the number
 * of rows an airline may hold is capped at its opened offices
 * ({@link executiveFloor}.officesUnlocked) by the hire logic, not by the schema.
 * `(airline_id, candidate_id)` is unique so a person cannot be hired twice; the
 * salary is snapshotted at hire so a later catalogue retune cannot re-bill a
 * standing executive. Both foreign keys cascade — an airline or world reset takes
 * its C-Suite with it (ADR-0005). The monthly charge is folded into the same
 * AIR-06 `office_salary` movement as the ground-floor staff.
 */
export const executiveHire = pgTable(
  'executive_hire',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    worldId: uuid('world_id')
      .notNull()
      .references(() => world.id, { onDelete: 'cascade' }),
    airlineId: uuid('airline_id')
      .notNull()
      .references(() => airline.id, { onDelete: 'cascade' }),
    /** Opaque candidate identity from the shared EXECUTIVE_CANDIDATES catalogue. */
    candidateId: text('candidate_id').notNull(),
    candidateName: text('candidate_name').notNull(),
    /** Salary per game month, minor units, snapshotted at hire. */
    monthlySalaryMinor: bigint('monthly_salary_minor', { mode: 'number' }).notNull(),
    /**
     * Which executive office (0-based) this hire sits in. Offices are generic, so
     * this is placement, not a role — it just makes the person appear in the office
     * the player clicked. Nullable for rows written before it existed; the hire
     * logic always sets it now, and never to an occupied office.
     */
    officeIndex: integer('office_index'),
    /** A game instant, for the same reason `office_hire.hired_at` is (TIME-02). */
    hiredAt: timestamp('hired_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('executive_hire_airline_candidate_key').on(table.airlineId, table.candidateId),
    // One person per office: a non-null office_index is unique within an airline.
    uniqueIndex('executive_hire_airline_office_key')
      .on(table.airlineId, table.officeIndex)
      .where(sql`${table.officeIndex} is not null`),
  ],
);

export type ExecutiveHireRow = typeof executiveHire.$inferSelect;

/**
 * A month's reputation grant from a hired social media specialist (§9.1, §15).
 *
 * The reputation specialist adds a little to `airline.reputation` once per game
 * month while she is on staff. Something has to make that idempotent: the worker
 * ticks every second and would otherwise apply a month's drip sixty times a
 * minute. This row is the marker — one per `(airline, period)`, inserted
 * `ON CONFLICT DO NOTHING` in the same transaction as the reputation bump, so a
 * replayed or double-ticked sweep grants nothing a second time.
 *
 * It is the used market's idempotency shape (a unique constraint, not a
 * "last granted" column) for the used market's reason: a timestamp column would
 * have to be reset on a world reset (ADR-0005) and forgetting would strand a
 * fresh airline believing it had already been paid. `world_id`/`airline_id`
 * cascade, so a reset takes the markers with the airline and the drip starts
 * clean. `period` is the world's own calendar month, `YYYY-MM`; `amount` records
 * what was applied, because a grant nobody can trace back to a rate is
 * indistinguishable from a bug.
 */
export const socialMediaReputationGrant = pgTable(
  'social_media_reputation_grant',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    worldId: uuid('world_id')
      .notNull()
      .references(() => world.id, { onDelete: 'cascade' }),
    airlineId: uuid('airline_id')
      .notNull()
      .references(() => airline.id, { onDelete: 'cascade' }),
    /** The world's own calendar month the grant covers, `YYYY-MM`. */
    period: text('period').notNull(),
    /** The reputation added, on §15's 0.00–1.00 scale. Recorded, not re-derived. */
    amount: numeric('amount', { precision: 3, scale: 2 }).notNull(),
    grantedAt: timestamp('granted_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('social_media_reputation_grant_airline_period_key').on(
      table.airlineId,
      table.period,
    ),
  ],
);

export type SocialMediaReputationGrantRow = typeof socialMediaReputationGrant.$inferSelect;

/**
 * One airline's automation mode and policy for one system (M5-05, ADR-0023).
 *
 * The ladder is per airline **and per system**, so a player can delegate
 * disruption response while keeping revenue manual. Absence of a row is the
 * default — Manual, no policy — so the default costs no row and a world reset
 * that deletes it restores it (ADR-0005). `policy` is a JSON document stored as
 * text and parsed on the way out against today's schema, exactly as the economy
 * config and the maintenance state are; never a stored expression the worker
 * evaluates. Owner-scoped: the airline is resolved from the session, never
 * accepted from the client.
 */
export const automationSetting = pgTable(
  'automation_setting',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    worldId: uuid('world_id')
      .notNull()
      .references(() => world.id, { onDelete: 'cascade' }),
    airlineId: uuid('airline_id')
      .notNull()
      .references(() => airline.id, { onDelete: 'cascade' }),
    /** The governed system — `'disruption'` first; the set grows as systems land. */
    system: text('system').notNull(),
    /** `'manual' | 'policy' | 'delegated'`. */
    mode: text('mode').notNull(),
    /** The declarative policy document as JSON text, or null when none is written. */
    policy: text('policy'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('automation_setting_airline_system_key').on(table.airlineId, table.system),
  ],
);

export type AutomationSettingRow = typeof automationSetting.$inferSelect;

/**
 * A situation the worker detected but is not authorised to resolve (M5-05, ADR-0023).
 *
 * §3.1's promise is that a decision waits for the player rather than being
 * guessed offline; this is where "waits for you" lives. One open row per
 * situation — a disruption under Manual, or one under Policy/Delegated that no
 * rule covers. The partial unique index keeps a restart or two racing workers
 * from stacking duplicates: one open task per subject, idempotent by constraint
 * like the queue and the used market. Nothing in the worker *acts* on this; the
 * admin health view and the player's surfaces read it. It is to decisions what
 * the AIR-06 ledger is to money — the record of what was deliberately left undone.
 */
export const operationsTask = pgTable(
  'operations_task',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    worldId: uuid('world_id')
      .notNull()
      .references(() => world.id, { onDelete: 'cascade' }),
    airlineId: uuid('airline_id')
      .notNull()
      .references(() => airline.id, { onDelete: 'cascade' }),
    system: text('system').notNull(),
    kind: text('kind').notNull(),
    /** What the task is about — a flight — or null for a base-wide task. */
    subjectType: text('subject_type'),
    subjectId: uuid('subject_id'),
    /** The human sentence the console shows. */
    detail: text('detail').notNull(),
    raisedAt: timestamp('raised_at', { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('operations_task_open_subject_key')
      .on(table.airlineId, table.system, table.subjectId)
      .where(sql`resolved_at is null`),
  ],
);

export type OperationsTaskRow = typeof operationsTask.$inferSelect;

/**
 * An airline's contract with a ground handler at a station (M5-06, §9.3).
 *
 * The vendors themselves are derived, not stored (`@tailfin/sim`'s
 * `stationVendors`); this is the one thing worth persisting — which grade an
 * airline has signed for which service line at which airport. One active contract
 * per `(airline, airport, service_line)`: you use one handler for a line at a
 * station. The `capacity` index counts the active contracts against a vendor's
 * finite slots, which is how §9.3's competing airlines exhaust the good handler.
 *
 * `term_end` is **game time** (the world clock), like a `world_event`'s fire time
 * — a contract lasts a business season, not a real week. Owner-scoped: the airline
 * is resolved from the session, never accepted from the client.
 */
export const groundContract = pgTable(
  'ground_contract',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    worldId: uuid('world_id')
      .notNull()
      .references(() => world.id, { onDelete: 'cascade' }),
    airlineId: uuid('airline_id')
      .notNull()
      .references(() => airline.id, { onDelete: 'cascade' }),
    airportIcao: text('airport_icao').notNull(),
    /** A `@tailfin/shared` `GroundServiceLine`. */
    serviceLine: text('service_line').notNull(),
    /** A `@tailfin/shared` `HandlerGrade`. */
    grade: text('grade').notNull(),
    /** `'active' | 'terminated'`. */
    status: text('status').notNull(),
    /**
     * Game time the term **starts**.
     *
     * Not the same instant as `signed_at`, and the difference is the whole reason
     * this column exists: `signed_at` defaults to `now()` and is therefore wall
     * clock, while `term_end` is the world's own calendar. Pro-rating a penalty
     * or a volume commitment across a term needs both ends measured on the same
     * clock, and mixing the two would have made a term look decades long.
     *
     * **Null means a contract signed before terms were priced** (M5-06 PR5 or
     * earlier). Such a row never expires and never bills, which is the truthful
     * behaviour for a contract nobody agreed a term with.
     */
    termStart: timestamp('term_start', { withTimezone: true }),
    /** Game time the term ends; null for a contract signed before terms existed. */
    termEnd: timestamp('term_end', { withTimezone: true }),
    /**
     * Departures committed over the term (§9.3), fixed at signing.
     *
     * Stored rather than recomputed, because the balance it came from is
     * retunable: a contract must be judged at the end against the commitment it
     * was actually signed under, not against whatever the economy says today.
     */
    volumeCommitment: integer('volume_commitment'),
    /**
     * What breaking the **whole** term would cost, in minor units, fixed at
     * signing for the same reason as the commitment.
     *
     * The charge actually levied is this pro-rated to the unserved part of the
     * term, so leaving on the last day is nearly free.
     */
    penaltyMinor: bigint('penalty_minor', { mode: 'number' }),
    signedAt: timestamp('signed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('ground_contract_active_line_key')
      .on(table.airlineId, table.airportIcao, table.serviceLine)
      .where(sql`status = 'active'`),
    index('ground_contract_capacity_idx').on(
      table.worldId,
      table.airportIcao,
      table.serviceLine,
      table.grade,
      table.status,
    ),
  ],
);

export type GroundContractRow = typeof groundContract.$inferSelect;

/**
 * A service line an airline handles with its own people (M5-06, §9.3).
 *
 * §9.3's *"self-handling as an alternative requiring a station and headcount"*.
 * A separate table from `ground_contract` rather than a flag on it, and the
 * reason is a rollback: a self-handled line has **no grade**, so representing one
 * in `ground_contract` would mean either a null in a column the previous release
 * reads as non-null — breaking its `/api/ground/:icao` response for exactly the
 * airlines that had adopted the feature — or storing a grade that is a lie. The
 * expand rule is that the previous release keeps working against the result, and
 * a table it has never heard of satisfies that completely.
 *
 * ## One handler per line, across two tables
 *
 * The partial unique index below gives this table its own one-active-per-line
 * rule; the cross-table rule — you cannot have a vendor *and* your own people on
 * the same line — is enforced by both writers taking the same
 * `pg_advisory_xact_lock` on `(world, airport, service line)` and closing the
 * other kind inside that lock. A database constraint cannot span two tables, so
 * the lock is the mechanism and `contracts.test.ts` is what proves it.
 *
 * ## Times are game time
 *
 * `opened_at` and `closed_at` are the world's own calendar, like a contract's
 * term and unlike `ground_contract.signed_at`. There is no term: an operation of
 * your own runs until you close it, which is why there is nothing here for the
 * worker to expire.
 */
export const groundSelfHandling = pgTable(
  'ground_self_handling',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    worldId: uuid('world_id')
      .notNull()
      .references(() => world.id, { onDelete: 'cascade' }),
    airlineId: uuid('airline_id')
      .notNull()
      .references(() => airline.id, { onDelete: 'cascade' }),
    airportIcao: text('airport_icao').notNull(),
    /** A `@tailfin/shared` `GroundServiceLine`. */
    serviceLine: text('service_line').notNull(),
    /**
     * Heads employed here. Compared against the station's requirement to give a
     * staffing ratio, which is what decides how well the line is handled.
     */
    headcount: integer('headcount').notNull(),
    /** `'active' | 'closed'`. */
    status: text('status').notNull(),
    /** Game time, so a reset moves it with everything else (ADR-0005). */
    openedAt: timestamp('opened_at', { withTimezone: true }).notNull(),
    closedAt: timestamp('closed_at', { withTimezone: true }),

    /**
     * Game time this operation's payroll has been settled up to.
     *
     * Payroll is an **accrual**, not a monthly snapshot of the headcount: the
     * first version billed the previous month against whoever was on the books
     * when the sweep ran, and staffing is free and instant to change, so running
     * 40 heads and dropping to 1 on the last day of the month billed 1. This is
     * the watermark that makes the reduction itself pay for the period the larger
     * staff worked.
     *
     * **Null means never settled**, and the accrual then starts at `opened_at` —
     * not at the epoch, which would bill an operation for every day of the world
     * before it existed.
     *
     * A "last billed" column is exactly what ADR-0005 warns about, but the
     * objection is to one that outlives a world reset. This lives on the
     * operation's own row, which is world-scoped and cascade-deleted, so a reset
     * takes the row and its watermark together.
     */
    billedThroughAt: timestamp('billed_through_at', { withTimezone: true }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('ground_self_handling_active_line_key')
      .on(table.airlineId, table.airportIcao, table.serviceLine)
      .where(sql`status = 'active'`),
    index('ground_self_handling_payroll_idx').on(table.worldId, table.status),
    // Zero heads is not a staffing level, it is a closed operation.
    check('ground_self_handling_headcount_positive', sql`${table.headcount} > 0`),
  ],
);

export type GroundSelfHandlingRow = typeof groundSelfHandling.$inferSelect;

/* ---- Service packages and route groups (M8-03, App. D) -------------------- */

/**
 * A named service package: what the airline serves, per cabin (App. D.6).
 *
 * `content` is a `ServicePackageContent` — the per-cabin tier selection and the
 * one commercial-intensity dial. JSON rather than a row per selected item for
 * the same reason `route.fares` is JSON: it is read and written whole, always by
 * its owner, and never joined against or aggregated. A `service_package_item`
 * table would add twenty-eight rows per package and a join to every read,
 * to support a query nothing asks.
 *
 * Mutable, deliberately, and unlike `economy_config` or `aircraft_type`. A
 * package is the player's own working document, not a versioned balance
 * artefact — and what a flight was actually served will be recorded on the
 * flight when M8-04 settles one, which is where an immutable record belongs.
 */
export const servicePackage = pgTable(
  'service_package',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    worldId: uuid('world_id')
      .notNull()
      .references(() => world.id, { onDelete: 'cascade' }),
    airlineId: uuid('airline_id')
      .notNull()
      .references(() => airline.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** A `@tailfin/shared` `ServicePackageContent`. */
    content: jsonb('content').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // One name per airline: the name is how a player picks a package out of a
    // list, so two of them is a list that cannot be used.
    unique('service_package_airline_name_key').on(t.airlineId, t.name),
    index('service_package_airline_id_idx').on(t.airlineId),
    index('service_package_world_id_idx').on(t.worldId),
  ],
);

export type ServicePackageRow = typeof servicePackage.$inferSelect;

/**
 * A named set of routes sharing one package (App. D.5).
 *
 * App. D.5 says packages are assigned *"per route group, not per aircraft"* and
 * never says what a route group is; `shared/service.ts` records the definition
 * chosen and why. Here it is a name, an owner, and an optional package.
 *
 * `service_package_id` is `set null` rather than `restrict`. The API refuses to
 * delete a package while a group holds it — a 409 that names the groups, which
 * is a better answer than a foreign-key violation — but the *database* must not
 * refuse, because deleting an airline cascades into both tables at once and a
 * restrict would turn an ordinary airline deletion into a constraint error.
 */
export const routeGroup = pgTable(
  'route_group',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    worldId: uuid('world_id')
      .notNull()
      .references(() => world.id, { onDelete: 'cascade' }),
    airlineId: uuid('airline_id')
      .notNull()
      .references(() => airline.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    servicePackageId: uuid('service_package_id').references(() => servicePackage.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('route_group_airline_name_key').on(t.airlineId, t.name),
    index('route_group_airline_id_idx').on(t.airlineId),
    index('route_group_world_id_idx').on(t.worldId),
  ],
);

export type RouteGroupRow = typeof routeGroup.$inferSelect;

/**
 * Which routes are in which group.
 *
 * `route_id` is **unique across the table**, not merely unique within a group:
 * a route belongs to at most one group. That is what makes "which package does
 * this flight fly under?" a question with one answer, and it is enforced here
 * rather than in the writer, because the alternative is a flight whose service
 * depends on which row a query happened to return first.
 */
export const routeGroupMember = pgTable(
  'route_group_member',
  {
    routeGroupId: uuid('route_group_id')
      .notNull()
      .references(() => routeGroup.id, { onDelete: 'cascade' }),
    routeId: uuid('route_id')
      .notNull()
      .references(() => route.id, { onDelete: 'cascade' }),
  },
  (t) => [
    primaryKey({ columns: [t.routeGroupId, t.routeId] }),
    unique('route_group_member_route_key').on(t.routeId),
    index('route_group_member_group_idx').on(t.routeGroupId),
  ],
);

export type RouteGroupMemberRow = typeof routeGroupMember.$inferSelect;

/* ---- Loans and credit standing (M8-06, §13) ------------------------------- */

/**
 * One drawn loan.
 *
 * Immutable in its terms and mutable in what is left: `annual_rate_bps`,
 * `term_months` and `tier_at_draw` are the price the airline was quoted and keep
 * it for the life of the loan, because a rating that falls must not silently
 * reprice money already lent. `outstanding_minor` is what M8-07 will amortise.
 *
 * `drawn_at` is **game time**, like every other in-world instant since
 * ADR-0026 — a twelve-month term is twelve months of the world, and a world at
 * 4× reaches maturity in a quarter of the real time.
 */
export const loan = pgTable(
  'loan',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    worldId: uuid('world_id')
      .notNull()
      .references(() => world.id, { onDelete: 'cascade' }),
    airlineId: uuid('airline_id')
      .notNull()
      .references(() => airline.id, { onDelete: 'cascade' }),
    /** A `@tailfin/shared` `LoanInstrument`. */
    instrument: text('instrument').notNull(),
    principalMinor: bigint('principal_minor', { mode: 'number' }).notNull(),
    outstandingMinor: bigint('outstanding_minor', { mode: 'number' }).notNull(),
    annualRateBps: integer('annual_rate_bps').notNull(),
    termMonths: integer('term_months').notNull(),
    /** A `@tailfin/shared` `CreditTier` — the rating the loan was written at. */
    tierAtDraw: text('tier_at_draw').notNull(),
    /** `'active' | 'repaid' | 'defaulted'`. */
    status: text('status').notNull().default('active'),
    /**
     * The airframe a secured loan can be taken against.
     *
     * No foreign key, for the same reason `schedule.airframe_id` has none: an
     * airframe can leave the fleet, and a loan is a financial record that must
     * survive the asset it was written against rather than vanishing with it.
     */
    securedAirframeId: uuid('secured_airframe_id'),
    drawnAt: timestamp('drawn_at', { withTimezone: true }).notNull(),
    /**
     * The game day interest has been charged up to — the accrual watermark
     * (M8-07, §13.4).
     *
     * **Nullable means never accrued**, not accrued to the epoch: a loan drawn a
     * moment ago has had no sweep reach it yet, and reading a null as "owes
     * interest since 1970" would bill a new borrower for decades on the first
     * tick. The sweep treats a null as `drawn_at`, which is the only reading
     * that charges for the time the money has actually been held.
     *
     * A watermark rather than a remembered "last run", so the sweep is
     * idempotent: it charges whole game days between the mark and now, and
     * running twice in one day charges nothing the second time.
     */
    interestAccruedThroughAt: timestamp('interest_accrued_through_at', { withTimezone: true }),
    /**
     * Interest the airline could not pay, still owed (§13.5's "missed payment").
     *
     * Kept apart from `outstanding_minor` on purpose. Arrears are what the
     * default ladder watches and what curing clears; rolling them into the
     * principal would compound a missed payment into the debt and quietly make
     * the ladder unescapable.
     */
    arrearsMinor: bigint('arrears_minor', { mode: 'number' }).notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('loan_airline_id_idx').on(t.airlineId),
    index('loan_world_id_idx').on(t.worldId),
    // What is owed is summed on every capacity read, so the active rows are the
    // ones worth indexing for.
    index('loan_airline_status_idx').on(t.airlineId, t.status),
    check('loan_principal_positive', sql`${t.principalMinor} > 0`),
    check('loan_outstanding_nonnegative', sql`${t.outstandingMinor} >= 0`),
    check('loan_term_positive', sql`${t.termMonths} > 0`),
    check('loan_arrears_nonnegative', sql`${t.arrearsMinor} >= 0`),
  ],
);

export type LoanRow = typeof loan.$inferSelect;

/**
 * An airline's credit rating between reviews.
 *
 * The rating needs **state**, which is the whole reason this table exists rather
 * than the tier being computed on demand: §13.2's *"one bad quarter costs a
 * tier; recovering it takes two good ones"* is a claim about history, and a pure
 * function of today's trading could not express it. `good_reviews` is the streak
 * of consecutive reviews that earned better than the tier held.
 *
 * `last_reviewed_at` is **game time**, and null means never reviewed — which,
 * exactly like `crew_base.morale`, is not the same as reviewed and found
 * wanting. A brand-new airline holds `startup` because that is where everyone
 * starts, not because it failed an assessment.
 */
export const creditStanding = pgTable(
  'credit_standing',
  {
    airlineId: uuid('airline_id')
      .primaryKey()
      .references(() => airline.id, { onDelete: 'cascade' }),
    worldId: uuid('world_id')
      .notNull()
      .references(() => world.id, { onDelete: 'cascade' }),
    /** A `@tailfin/shared` `CreditTier`. */
    tier: text('tier').notNull().default('startup'),
    goodReviews: integer('good_reviews').notNull().default(0),
    lastReviewedAt: timestamp('last_reviewed_at', { withTimezone: true }),
    /**
     * Where the airline sits on §13.5's ladder — a `@tailfin/shared`
     * `DefaultStage`, `'none'` for an airline in good standing.
     */
    defaultStage: text('default_stage').notNull().default('none'),
    /** Game time the current stage began. Null while the stage is `none`. */
    stageEnteredAt: timestamp('stage_entered_at', { withTimezone: true }),
    /**
     * Game time by which arrears must be cleared to avoid the next stage.
     *
     * §13.5 gives the warning "7 in-game days to cure", and every later stage
     * gets its own window from the economy config. Null while nothing is owed.
     */
    cureByAt: timestamp('cure_by_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('credit_standing_world_id_idx').on(t.worldId),
    check('credit_standing_good_reviews_nonnegative', sql`${t.goodReviews} >= 0`),
  ],
);

export type CreditStandingRow = typeof creditStanding.$inferSelect;

// ---------------------------------------------------------------------------
// alert / alert_state — §14.5's alerts and §3.2's offline digest (M8-13)
// ---------------------------------------------------------------------------

/**
 * One raised alert (M8-13, §14.5).
 *
 * ## Why alerts are rows rather than a computed list
 *
 * The tempting implementation recomputes the eight conditions on every read, and
 * it cannot satisfy either criterion that matters. *"Alerts are deduplicated,
 * not repeated every tick"* needs to know whether this alert has already been
 * raised, which is a memory. *"The digest covers the exact period since last
 * seen"* needs to know **when** each one was raised, which is the same memory
 * with a timestamp on it. So the worker raises rows and every read projects
 * them.
 *
 * ## The deduplication is the database's, not the sweep's
 *
 * The partial unique index is the same pattern `operations_task` uses and for
 * the same reason: one open alert per subject, idempotent by constraint rather
 * than by application logic that has to be right on every restart and through
 * every handover between two racing workers.
 *
 * It is keyed on `subject_key` rather than on a nullable `subject_id`, and that
 * is deliberate. A unique index treats NULLs as distinct, so an airline-wide
 * alert — a cash runway, a coverage ratio — would stack a new row every tick
 * behind an index that looks like it prevents exactly that. `subject_key` is
 * `NOT NULL` for every rule, so there is no null case to get wrong.
 *
 * ## `raised_at` and `resolved_at` are game time
 *
 * Everything an alert is about is measured on the world's clock (ADR-0026), and
 * a digest window that mixed the two calendars would select a set that depended
 * on which world speed the player left running. `created_at` stays real, like
 * everywhere else — *when did this row appear* is a different question from
 * *when did this happen in the world*.
 */
export const alert = pgTable(
  'alert',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    worldId: uuid('world_id')
      .notNull()
      .references(() => world.id, { onDelete: 'cascade' }),
    airlineId: uuid('airline_id')
      .notNull()
      .references(() => airline.id, { onDelete: 'cascade' }),

    /** A `@tailfin/shared` `AlertKind`. */
    kind: text('kind').notNull(),
    /** A `@tailfin/shared` `AlertSeverity`. */
    severity: text('severity').notNull(),

    /** A `@tailfin/shared` `AlertSubjectType` — `airline` for a whole-airline alert. */
    subjectType: text('subject_type').notNull(),
    /**
     * What the alert links to: a route, airframe, base or contract id, an ICAO,
     * or the airline's own id. Text rather than `uuid` because a station is
     * addressed by its ICAO code and a column that only sometimes held a uuid
     * would make every reader guess which case it had.
     */
    subjectId: text('subject_id').notNull(),
    /** What to call the subject on screen — a route label, a registration, an ICAO. */
    subjectLabel: text('subject_label').notNull(),

    /**
     * The deduplication identity, usually equal to `subject_id`.
     *
     * Two rules need it finer. A crew shortfall is per rank on a family and the
     * airline is the only thing to link to; a rival entry is per rival and the
     * route is the only thing to link to. Folding either into `subject_id` would
     * lose the link or lose the distinction.
     */
    subjectKey: text('subject_key').notNull(),

    title: text('title').notNull(),
    detail: text('detail').notNull(),
    /** A `@tailfin/shared` `AlertScreen` — where the player can act on it. */
    screen: text('screen').notNull(),

    /** Game time the rule first fired. */
    raisedAt: timestamp('raised_at', { withTimezone: true }).notNull(),
    /** Game time the condition stopped being true. Null while open. */
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('alert_open_subject_key')
      .on(t.airlineId, t.kind, t.subjectKey)
      .where(sql`resolved_at is null`),
    // `GET /api/alerts` is "open alerts for this airline, worst first".
    index('alert_airline_open_idx').on(t.airlineId, t.resolvedAt),
    // The digest asks for the alerts raised or resolved inside a game-time window.
    index('alert_airline_raised_idx').on(t.airlineId, t.raisedAt),
    index('alert_world_idx').on(t.worldId),
    check(
      'alert_resolved_after_raised',
      sql`${t.resolvedAt} IS NULL OR ${t.resolvedAt} >= ${t.raisedAt}`,
    ),
  ],
);

export type AlertRow = typeof alert.$inferSelect;

/**
 * One airline's alerting state: the sweep's watermark and the digest's (M8-13).
 *
 * ## Why the digest watermark is not `session.last_seen_at`
 *
 * It is the obvious column and it cannot do the job. `findSessionPlayer` touches
 * it on **every authenticated request**, so by the time a digest handler runs it
 * already reads *now* and the window is empty. It is also per **device** — a
 * player with a phone and a laptop has two — and every row is deleted when a
 * privilege change rotates session authority (ADR-0015), which would silently
 * erase the fact that the player had ever been here.
 *
 * So *"last seen"* means *last digest the player acknowledged*, and only
 * `POST /api/digest/read` moves it. `GET /api/digest` deliberately does not: a
 * page refresh must show the same feed rather than an empty one, and a read that
 * changed state would also make the endpoint an unsafe `GET` under ADR-0025.
 *
 * ## Why the sweep has a watermark at all
 *
 * The rules are cheap to decide and expensive to read — a runway projection and
 * a credit assessment per airline. Every tick would spend the world's budget
 * asking whether a seven-day trend had changed since a second ago. Both columns
 * are **game time** and **nullable, meaning never**: null `swept_at` is what
 * lets `GET /api/alerts` say *nothing has run* rather than *nothing is wrong*,
 * which on a node with no worker is the difference between a missing process and
 * a healthy airline.
 */
export const alertState = pgTable(
  'alert_state',
  {
    airlineId: uuid('airline_id')
      .primaryKey()
      .references(() => airline.id, { onDelete: 'cascade' }),
    worldId: uuid('world_id')
      .notNull()
      .references(() => world.id, { onDelete: 'cascade' }),

    /** Game time the rules were last evaluated. Null means never. */
    sweptAt: timestamp('swept_at', { withTimezone: true }),

    /** Game time the last acknowledged digest covered through. Null means never. */
    digestCoveredThroughAt: timestamp('digest_covered_through_at', { withTimezone: true }),
    /** Wall clock of that acknowledgement — *when did the player read it*. */
    digestReadAt: timestamp('digest_read_at', { withTimezone: true }),

    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // The sweep claims the airlines whose watermark is oldest, per world.
    index('alert_state_world_swept_idx').on(t.worldId, t.sweptAt),
  ],
);

export type AlertStateRow = typeof alertState.$inferSelect;
