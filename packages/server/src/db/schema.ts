import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  doublePrecision,
  index,
  integer,
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
  ],
);

// ---------------------------------------------------------------------------
// cash_movement — the authoritative explanation for airline.cash_minor (AIR-06)
// ---------------------------------------------------------------------------

/**
 * Deliberately narrow. M8-01 adds P&L categories and entity dimensions; these
 * are the balance-changing causes that exist now and can therefore be honest.
 */
export const cashMovementCause = pgEnum('cash_movement_cause', [
  'airline_founding',
  'flight_settlement',
  'migration_opening_balance',
]);
export type CashMovementCause = (typeof cashMovementCause.enumValues)[number];

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

    /** Game time for simulation causes; founding time for the opening grant. */
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
 * Founding grants the first hub; M7-04 later adds paid hubs and facilities.
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
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('airline_hub_airline_id_airport_id_key').on(t.airlineId, t.airportId),
    index('airline_hub_airline_id_idx').on(t.airlineId),
    index('airline_hub_airport_id_idx').on(t.airportId),
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

export const worldEventStatus = pgEnum('world_event_status', ['pending', 'done', 'failed']);

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
      sql`(${t.status} = 'pending') = (${t.processedAt} IS NULL)`,
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
export const adminGrant = pgTable('admin_grant', {
  playerId: uuid('player_id')
    .primaryKey()
    .references(() => player.id, { onDelete: 'cascade' }),
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

    /** All four are **game-time** instants, like `world_event.fire_at`. */
    scheduledDeparture: timestamp('scheduled_departure', { withTimezone: true }).notNull(),
    actualDeparture: timestamp('actual_departure', { withTimezone: true }),
    estimatedArrival: timestamp('estimated_arrival', { withTimezone: true }).notNull(),
    actualArrival: timestamp('actual_arrival', { withTimezone: true }),

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
