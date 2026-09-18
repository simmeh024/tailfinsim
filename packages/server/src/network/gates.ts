/**
 * Holding and resolving airport stands (M7-06, App. B.6).
 *
 * The database half of the gate model. `@tailfin/sim` owns the pure facts — how
 * many stands a day of turns needs (`gateRequirement`), which stand each turn
 * lands on (`assignStands`), and what a lease costs (`standAnnualFee`) — and this
 * owns everything about *holding* one: what stands an airport has, who holds
 * what, leasing and releasing, and the resolver that tells a departing flight
 * which stand it is working from.
 *
 * ## Two scarce resources, deliberately separate
 *
 * App. B.8 sets slots and gates side by side and the differences are load
 * bearing, so this module is **not** `slots.ts` with different nouns:
 *
 *   - A slot exists only at a Level 3 airport. A stand exists **everywhere** —
 *     B.8's scarcity row is *"anywhere popular"*, and an airport with one apron
 *     has few stands rather than no stands.
 *   - A slot holding is free and standing. A lease is **billed monthly** and can
 *     be **lost to a utilisation floor**, which is why this subsystem has a
 *     worker story and slots do not.
 *   - A slot is held per *band*. A stand is held per *position*, because App. B.7
 *     wants a player to see whose aeroplanes are on which pier.
 *
 * ## The airport's stands are computed, not stored
 *
 * {@link standInventory} derives an airport's apron from its tier. That is the
 * same call `slots.ts` makes about per-band capacity and for the same reasons: it
 * prices nothing, so it is not an `EconomyConfig` coefficient; and a hundred
 * thousand rows of stand reference data would be a reference dataset nobody could
 * ever check, for airports most worlds never touch. A stand's *label* is
 * therefore stable for an airport of a given tier, which is all a lease needs to
 * address one.
 *
 * ## What is not built
 *
 * **Bumping.** App. B.6 says a common-use stand is *"first come, and you can be
 * bumped at peak"*. Bumping a specific aeroplane off a specific stand is a
 * dispatch mechanic and would need the gate allocator App. B.7 files under
 * post-MVP. What is modelled is the consequence a player actually feels:
 * {@link resolveStand} gives a walk-up a contact gate while the airport has spare
 * ones and puts it on a **remote stand** once the leases have taken them all —
 * which costs App. B.6's +10–12 minutes and is exactly what being bumped means.
 * Leasing at a contested airport is therefore worth something operationally as
 * well as financially, and that is the whole point of the contract table.
 */

import { and, eq, gte, inArray, lt, sql } from 'drizzle-orm';

import type {
  AirportGatesResponse,
  AirportStand,
  AirportTier,
  GateContract,
  StandHolder,
  StandKind,
  StandRequirement,
} from '@tailfin/shared';
import { STAND_KINDS } from '@tailfin/shared';
import {
  belowUtilisationFloor,
  commonUseTurnFee,
  gateRequirement,
  leaseBreakevenTurnsPerMonth,
  standAnnualFee,
  standOccupancies,
  standUtilisation,
  type StandOccupancy,
} from '@tailfin/sim';

import { airline, airport, flight, gateHolding } from '../db/schema';
import { loadWorldEconomyConfig } from '../economy/loader';
import { worldGameNow } from '../world/game-now';

import type { ResolvedPlayerAirline } from '../airline/context';
import type { Database } from '../db/client';

/* -- What stands an airport has ---------------------------------------------- */

/**
 * How many of each stand an airport of a given tier has.
 *
 * Structural scarcity, like `slotCapacityPerHour` — a property of the airport
 * rather than of the economy, so it is a documented constant and not a balance
 * coefficient. The shape is App. B.6's: a flagship has piers of jet bridges and a
 * large remote apron; a regional field has two gates, a bit of concrete and
 * somewhere to leave an aeroplane overnight.
 *
 * The contact-gate counts are sized against App. B.6's own growth table — 32
 * gates for a rolling operation of 120 aircraft, 171 for a banked one — so a
 * flagship has to hold several large airlines at once and still be contestable.
 * Forty-eight is deliberately **not** enough for two banked mega-hubs, because a
 * flagship where everyone fits is not a flagship anybody fights over.
 */
const INVENTORY_BY_TIER: Record<AirportTier, Record<StandKind, number>> = {
  flagship: {
    contact_gate: 48,
    remote_stand: 20,
    overnight_parking: 30,
    cargo_stand: 8,
    maintenance_stand: 4,
  },
  large: {
    contact_gate: 24,
    remote_stand: 12,
    overnight_parking: 16,
    cargo_stand: 4,
    maintenance_stand: 3,
  },
  medium: {
    contact_gate: 12,
    remote_stand: 8,
    overnight_parking: 10,
    cargo_stand: 2,
    maintenance_stand: 2,
  },
  small: {
    contact_gate: 6,
    remote_stand: 4,
    overnight_parking: 6,
    cargo_stand: 1,
    maintenance_stand: 1,
  },
  regional: {
    contact_gate: 2,
    remote_stand: 3,
    overnight_parking: 4,
    cargo_stand: 1,
    maintenance_stand: 1,
  },
};

/** An airport with no tier yet — classification has not run — is treated as the smallest. */
const DEFAULT_TIER: AirportTier = 'regional';

/** How many contact gates sit on one pier before the next letter starts. */
const GATES_PER_PIER = 12;

const PREFIX: Record<StandKind, string> = {
  contact_gate: '', // piers are lettered — see below
  remote_stand: 'R',
  overnight_parking: 'P',
  cargo_stand: 'C',
  maintenance_stand: 'M',
};

/**
 * Every stand at an airport of this tier, in order, labelled.
 *
 * Contact gates are lettered by pier (`A1`–`A12`, `B1`–`B12`, …) because that is
 * how an airport numbers them and because App. B.7's map draws piers. Everything
 * else is a flat run with a prefix, since a remote apron has no piers to draw.
 */
export function standInventory(tier: AirportTier | null): { position: string; kind: StandKind }[] {
  const counts = INVENTORY_BY_TIER[tier ?? DEFAULT_TIER];
  const stands: { position: string; kind: StandKind }[] = [];
  for (const kind of STAND_KINDS) {
    const total = counts[kind];
    for (let i = 0; i < total; i += 1) {
      stands.push({ position: positionOf(kind, i), kind });
    }
  }
  return stands;
}

function positionOf(kind: StandKind, index: number): string {
  if (kind !== 'contact_gate') return `${PREFIX[kind]}${String(index + 1)}`;
  const pier = String.fromCharCode('A'.charCodeAt(0) + Math.floor(index / GATES_PER_PIER));
  return `${pier}${String((index % GATES_PER_PIER) + 1)}`;
}

/** The kind a position belongs to, or null if this airport has no such stand. */
function kindOfPosition(tier: AirportTier | null, position: string): StandKind | null {
  return standInventory(tier).find((stand) => stand.position === position)?.kind ?? null;
}

/* -- Reading an airport ------------------------------------------------------ */

interface AirportRow {
  icao: string;
  name: string;
  tier: AirportTier | null;
  utcOffsetMinutes: number | null;
}

async function loadAirport(db: Database, icao: string): Promise<AirportRow | null> {
  const [row] = await db
    .select({
      icao: airport.icaoCode,
      name: airport.name,
      tier: airport.tier,
      utcOffsetMinutes: airport.utcOffsetMinutes,
    })
    .from(airport)
    .where(eq(airport.icaoCode, icao))
    .limit(1);
  if (row?.icao == null) return null;
  return {
    icao: row.icao,
    name: row.name,
    tier: row.tier,
    utcOffsetMinutes: row.utcOffsetMinutes,
  };
}

interface HoldingRow {
  id: string;
  airlineId: string;
  name: string;
  iataCode: string | null;
  position: string;
  kind: StandKind;
  contract: GateContract;
  annualFeeMinor: number;
}

/** Every lease at this airport in this world, with the holder named. */
async function holdingsAt(db: Database, worldId: string, icao: string): Promise<HoldingRow[]> {
  /*
   * One grouped join rather than a correlated subquery in the select list, which
   * came back empty against real Postgres once and is in CLAUDE.md's traps.
   */
  return db
    .select({
      id: gateHolding.id,
      airlineId: gateHolding.airlineId,
      name: airline.name,
      iataCode: airline.iataCode,
      position: gateHolding.position,
      kind: gateHolding.kind,
      contract: gateHolding.contract,
      annualFeeMinor: gateHolding.annualFeeMinor,
    })
    .from(gateHolding)
    .innerJoin(airline, eq(airline.id, gateHolding.airlineId))
    .where(and(eq(gateHolding.worldId, worldId), eq(gateHolding.airportIcao, icao)));
}

/* -- What the airline's own schedule asks of this airport -------------------- */

/** How far ahead the requirement is read. */
const SAMPLE_WINDOW_MINUTES = 24 * 60;
const MINUTES_PER_DAY = 1_440;

/**
 * One airline's on-stand intervals at one airport over the next game day.
 *
 * **Forward**, not backward, and that is the useful direction: a requirement is a
 * decision about what to lease, so it has to be read off the schedule the airline
 * is about to fly rather than off the one it already flew. Schedules are
 * materialised on a 14-game-day horizon (M2-03), so the window is always
 * populated on a world whose worker is running — and empty on one whose is not,
 * which is what `sampledGameDate` exists to say out loud.
 *
 * Local minutes of the day at the airport, because a stand is a physical place
 * and its operating day is the local one. `standOccupancies` pairs each arrival
 * with the next departure and carries the last one past midnight, so an aeroplane
 * left overnight is one interval rather than two or none.
 */
async function occupanciesAt(
  db: Database,
  worldId: string,
  airlineId: string,
  air: AirportRow,
  from: Date,
): Promise<StandOccupancy[]> {
  const until = new Date(from.getTime() + SAMPLE_WINDOW_MINUTES * 60_000);
  const offset = air.utcOffsetMinutes ?? 0;

  const rows = await db
    .select({
      airframeId: flight.airframeId,
      originIcao: flight.originIcao,
      destinationIcao: flight.destinationIcao,
      departure: sql<Date>`coalesce(${flight.actualDeparture}, ${flight.scheduledDeparture})`,
      arrival: sql<Date>`coalesce(${flight.actualArrival}, ${flight.estimatedArrival})`,
    })
    .from(flight)
    .where(
      and(
        eq(flight.worldId, worldId),
        eq(flight.airlineId, airlineId),
        gte(flight.scheduledDeparture, new Date(from.getTime() - MINUTES_PER_DAY * 60_000)),
        lt(flight.scheduledDeparture, until),
      ),
    );

  /** Local minute of the day, 0–1439. The driver may hand back a string. */
  const localMinute = (at: Date | string): number => {
    const ms = at instanceof Date ? at.getTime() : Date.parse(String(at));
    const minutes = Math.floor(ms / 60_000) + offset;
    return ((minutes % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  };

  const arrivals = new Map<string, number[]>();
  const departures = new Map<string, number[]>();
  for (const row of rows) {
    if (row.destinationIcao === air.icao) {
      arrivals.set(row.airframeId, [
        ...(arrivals.get(row.airframeId) ?? []),
        localMinute(row.arrival),
      ]);
    }
    if (row.originIcao === air.icao) {
      departures.set(row.airframeId, [
        ...(departures.get(row.airframeId) ?? []),
        localMinute(row.departure),
      ]);
    }
  }

  const occupancies: StandOccupancy[] = [];
  for (const airframeId of new Set([...arrivals.keys(), ...departures.keys()])) {
    occupancies.push(
      ...standOccupancies(arrivals.get(airframeId) ?? [], departures.get(airframeId) ?? []),
    );
  }
  return occupancies;
}

/* -- The airport picture ----------------------------------------------------- */

async function pictureOf(
  db: Database,
  own: ResolvedPlayerAirline,
  air: AirportRow,
): Promise<AirportGatesResponse> {
  const economy = await loadWorldEconomyConfig(db, own.worldId);
  const gates = economy.gates;
  const tier = air.tier ?? DEFAULT_TIER;

  const [held, gameNow] = await Promise.all([
    holdingsAt(db, own.worldId, air.icao),
    worldGameNow(db, own.worldId),
  ]);
  const occupancies = await occupanciesAt(db, own.worldId, own.id, air, gameNow);

  const holdersByPosition = new Map<string, StandHolder[]>();
  for (const row of held) {
    const list = holdersByPosition.get(row.position) ?? [];
    list.push({
      airlineId: row.airlineId,
      name: row.name,
      iataCode: row.iataCode,
      contract: row.contract,
      isYou: row.airlineId === own.id,
    });
    holdersByPosition.set(row.position, list);
  }

  /*
   * The airline's own contact gates and remote stands, with a turn placed on
   * each. `standUtilisation` assigns greedily, so gate 1 carries the work and the
   * last one is visibly idle — which is the reading a player needs before giving
   * one back, and the reason a total spread evenly would be useless.
   */
  const ownTurnStands = held
    .filter((row) => row.airlineId === own.id)
    .filter((row) => row.kind === 'contact_gate' || row.kind === 'remote_stand')
    .map((row) => row.position)
    .sort();
  const utilisation = standUtilisation(occupancies, ownTurnStands.length);
  const utilisationByPosition = new Map(
    ownTurnStands.map((position, index) => [position, utilisation[index]]),
  );

  const stands: AirportStand[] = standInventory(tier).map(({ position, kind }) => {
    const holders = holdersByPosition.get(position) ?? [];
    const yours = holders.find((holder) => holder.isYou) ?? null;
    const exclusive = holders.find((holder) => holder.contract === 'exclusive') ?? null;
    const row = utilisationByPosition.get(position);
    return {
      position,
      kind,
      holders,
      yourContract: yours?.contract ?? null,
      exclusivelyHeld: exclusive !== null,
      // Exclusively held by somebody else is the one refusal a stand carries on
      // its face. Everything else is refused by the handler with a reason.
      available: exclusive === null || exclusive.isYou,
      utilisation:
        row === undefined || yours === null
          ? null
          : {
              turns: row.turns,
              occupiedMinutes: Math.round(row.occupiedMinutes),
              fraction: row.fraction,
              belowFloor: belowUtilisationFloor(kind, row.fraction),
            },
      annualFeeMinor: {
        common_use: standAnnualFee(kind, 'common_use', tier, gates),
        preferential: standAnnualFee(kind, 'preferential', tier, gates),
        exclusive: standAnnualFee(kind, 'exclusive', tier, gates),
      },
      commonUseTurnFeeMinor: commonUseTurnFee(kind, tier, gates),
    };
  });

  const yourHoldings = held.filter((row) => row.airlineId === own.id);
  const requirement = requirementOf(occupancies, yourHoldings, gameNow);

  return {
    icao: air.icao,
    name: air.name,
    tier,
    stands,
    requirement,
    // From the pinned fee on each row, not from today's price: a lease is billed
    // at what it was sold at, which is what makes a retune safe.
    monthlyFeeMinor: yourHoldings.reduce(
      (total, row) => total + Math.round(row.annualFeeMinor / 12),
      0,
    ),
    leaseBreakevenTurnsPerMonth: leaseBreakevenTurnsPerMonth(
      'contact_gate',
      'preferential',
      tier,
      gates,
    ),
  };
}

/** App. B.6's formula against this airline's own day, plus what it already holds. */
function requirementOf(
  occupancies: readonly StandOccupancy[],
  holdings: readonly { kind: StandKind }[],
  gameNow: Date,
): StandRequirement {
  const computed = gateRequirement(occupancies);
  return {
    contactGates: computed.contactGates,
    contactGatesHeld: holdings.filter((row) => row.kind === 'contact_gate').length,
    overnightPositions: computed.overnightPositions,
    overnightPositionsHeld: holdings.filter((row) => row.kind === 'overnight_parking').length,
    percentileConcurrency: computed.percentileConcurrency,
    peakConcurrency: computed.peakConcurrency,
    turns: computed.turns,
    // Null when nothing flew in the window — which on a node with no worker is
    // always, and is a different fact from "this airline needs no gates".
    sampledGameDate: computed.turns === 0 ? null : gameNow.toISOString(),
  };
}

/** One airport's stand picture for this airline, or null if no such airport. */
export async function readAirportGates(
  db: Database,
  own: ResolvedPlayerAirline,
  icao: string,
): Promise<AirportGatesResponse | null> {
  const air = await loadAirport(db, icao);
  if (air === null) return null;
  return pictureOf(db, own, air);
}

/* -- Leasing and releasing --------------------------------------------------- */

export type GateMutation =
  | { ok: true; gates: AirportGatesResponse }
  | {
      ok: false;
      problem:
        | 'unknown_airport'
        | 'unknown_stand'
        | 'exclusively_held'
        | 'contested'
        | 'not_leasable'
        | 'fee_changed';
    };

/**
 * Take a stand, or say why not.
 *
 * Idempotent in the useful direction: an airline that already holds the stand on
 * the same contract succeeds without a second row. Changing contract on a stand
 * you already hold updates it — which is how a preferential lease is upgraded to
 * an exclusive one, and it is charged at the new price from the month it changes.
 *
 * ## App. B.6's exclusivity, enforced twice
 *
 * The rule is *"guaranteed, always yours — denies it to everyone else"*, and it
 * cuts both ways: you cannot take a stand somebody else holds exclusively, and
 * you cannot take one exclusively while somebody else is on it. Both are checked
 * inside one transaction against the same snapshot the insert writes into, so two
 * racing leases cannot both pass a stale read. The partial unique index in the
 * schema is the backstop for the narrowest race of all.
 */
export async function leaseStand(
  db: Database,
  own: ResolvedPlayerAirline,
  icao: string,
  request: { position: string; contract: GateContract; expectedAnnualFeeMinor: number },
): Promise<GateMutation> {
  const air = await loadAirport(db, icao);
  if (air === null) return { ok: false, problem: 'unknown_airport' };

  const tier = air.tier ?? DEFAULT_TIER;
  const kind = kindOfPosition(air.tier, request.position);
  if (kind === null) return { ok: false, problem: 'unknown_stand' };

  // A common-use stand is not leased at all — it is paid a turn at a time. The
  // schema refuses such a row too; this is the reason the player is given.
  if (request.contract === 'common_use') return { ok: false, problem: 'not_leasable' };

  const economy = await loadWorldEconomyConfig(db, own.worldId);
  const annualFeeMinor = standAnnualFee(kind, request.contract, tier, economy.gates);
  if (annualFeeMinor !== request.expectedAnnualFeeMinor) {
    return { ok: false, problem: 'fee_changed' };
  }

  const leasedAt = await worldGameNow(db, own.worldId);

  const refusal = await db.transaction(async (tx) => {
    const others = await tx
      .select({ airlineId: gateHolding.airlineId, contract: gateHolding.contract })
      .from(gateHolding)
      .where(
        and(
          eq(gateHolding.worldId, own.worldId),
          eq(gateHolding.airportIcao, air.icao),
          eq(gateHolding.position, request.position),
        ),
      );

    const rivals = others.filter((row) => row.airlineId !== own.id);
    if (rivals.some((row) => row.contract === 'exclusive')) return 'exclusively_held' as const;
    if (request.contract === 'exclusive' && rivals.length > 0) return 'contested' as const;

    const mine = others.find((row) => row.airlineId === own.id);
    if (mine !== undefined) {
      // Already held. Re-price it only if the contract is actually changing;
      // re-leasing on the same terms must not reset the utilisation floor's
      // grace period, which would make hoarding a matter of clicking.
      if (mine.contract === request.contract) return null;
      await tx
        .update(gateHolding)
        .set({ contract: request.contract, annualFeeMinor, leasedAt })
        .where(
          and(
            eq(gateHolding.worldId, own.worldId),
            eq(gateHolding.airlineId, own.id),
            eq(gateHolding.airportIcao, air.icao),
            eq(gateHolding.position, request.position),
          ),
        );
      return null;
    }

    await tx.insert(gateHolding).values({
      worldId: own.worldId,
      airlineId: own.id,
      airportIcao: air.icao,
      position: request.position,
      kind,
      contract: request.contract,
      annualFeeMinor,
      leasedAt,
    });
    return null;
  });

  if (refusal !== null) return { ok: false, problem: refusal };
  return { ok: true, gates: await pictureOf(db, own, air) };
}

/**
 * Give a stand back. Idempotent — releasing one you do not hold changes nothing
 * and still returns the current picture, so a double-tap is not an error.
 *
 * No penalty, deliberately. §9.3's ground contracts charge one for breaking a
 * term early and App. B.6 says nothing of the kind about a lease; inventing one
 * would make the utilisation floor punish twice, once by taking the stand and
 * again for having let it go.
 */
export async function releaseStand(
  db: Database,
  own: ResolvedPlayerAirline,
  icao: string,
  position: string,
): Promise<GateMutation> {
  const air = await loadAirport(db, icao);
  if (air === null) return { ok: false, problem: 'unknown_airport' };
  if (kindOfPosition(air.tier, position) === null) {
    return { ok: false, problem: 'unknown_stand' };
  }

  await db
    .delete(gateHolding)
    .where(
      and(
        eq(gateHolding.worldId, own.worldId),
        eq(gateHolding.airlineId, own.id),
        eq(gateHolding.airportIcao, air.icao),
        eq(gateHolding.position, position),
      ),
    );

  return { ok: true, gates: await pictureOf(db, own, air) };
}

/* -- What stand a flight actually works from --------------------------------- */

/**
 * Where one airline's aeroplane parks at one station, and what that turn costs.
 *
 * The seam between a holding and the rest of the game. Two consumers today —
 * `schedule/authoring.ts`, which needs the stand to compute a turn's length, and
 * `flight/settle.ts`, which needs the fee — and both were passing a hard-coded
 * `contact` and nothing before this existed.
 *
 * The ladder, and why it is this way round:
 *
 *   1. **A contact gate you lease.** Baseline turn, no per-turn fee. You have
 *      already paid for it monthly.
 *   2. **A remote stand you lease.** App. B.6's +10–12 minutes, no per-turn fee.
 *   3. **A spare contact gate.** Baseline turn, and a walk-up fee. This is the
 *      common case at a quiet airport and is why a regional field does not
 *      suddenly cost every airline eleven minutes a turn.
 *   4. **Nothing spare.** A remote stand and a walk-up fee — App. B.6's *"first
 *      come, and you can be bumped at peak"*, felt as the bussing time rather
 *      than modelled as a dispatch fight over a particular gate.
 *
 * Step 3 is what makes an exclusive lease bite on a rival who never reads the
 * gates page: every exclusive lease shrinks the spare pool, and when it empties
 * everyone without a lease starts turning eleven minutes slower.
 */
export interface ResolvedStand {
  kind: StandKind;
  /** What `computeTurnaround` should be told. */
  standType: 'contact' | 'remote';
  /** Zero when the airline leases this stand; the walk-up fee otherwise. */
  turnFeeMinor: number;
  /** True when the airline holds a lease covering this turn. */
  leased: boolean;
}

/**
 * Resolve the stand for each of several stations at once.
 *
 * Batched because both callers have a rotation rather than a leg: two queries
 * however many stations there are, which is the same discipline `resolveLegSlots`
 * keeps.
 */
export async function resolveStands(
  db: Database,
  /*
   * Only the owner and the world, not a whole `ResolvedPlayerAirline`. The other
   * caller is `settleArrivedFlight`, which holds a `flight` row rather than a
   * session — and making it invent a status to satisfy a type would be a lie
   * about where the value came from.
   */
  own: { id: string; worldId: string },
  icaos: readonly string[],
  economyGates: Parameters<typeof standAnnualFee>[3],
): Promise<Map<string, ResolvedStand>> {
  const stations = [...new Set(icaos)];
  const resolved = new Map<string, ResolvedStand>();
  if (stations.length === 0) return resolved;

  const [airports, leases, rivalLeases] = await Promise.all([
    db
      .select({ icao: airport.icaoCode, tier: airport.tier })
      .from(airport)
      .where(inArray(airport.icaoCode, stations)),
    db
      .select({ icao: gateHolding.airportIcao, kind: gateHolding.kind })
      .from(gateHolding)
      .where(
        and(
          eq(gateHolding.worldId, own.worldId),
          eq(gateHolding.airlineId, own.id),
          inArray(gateHolding.airportIcao, stations),
        ),
      ),
    db
      .select({
        icao: gateHolding.airportIcao,
        leased: sql<number>`count(*)::int`,
      })
      .from(gateHolding)
      .where(
        and(
          eq(gateHolding.worldId, own.worldId),
          eq(gateHolding.kind, 'contact_gate'),
          inArray(gateHolding.airportIcao, stations),
        ),
      )
      .groupBy(gateHolding.airportIcao),
  ]);

  const tierOf = new Map(airports.map((row) => [row.icao, row.tier]));
  const contactGatesLeased = new Map(rivalLeases.map((row) => [row.icao, row.leased]));
  const ownKinds = new Map<string, Set<StandKind>>();
  for (const row of leases) {
    const set = ownKinds.get(row.icao) ?? new Set<StandKind>();
    set.add(row.kind);
    ownKinds.set(row.icao, set);
  }

  for (const icao of stations) {
    const tier = tierOf.get(icao) ?? DEFAULT_TIER;
    const mine = ownKinds.get(icao) ?? new Set<StandKind>();

    if (mine.has('contact_gate')) {
      resolved.set(icao, {
        kind: 'contact_gate',
        standType: 'contact',
        turnFeeMinor: 0,
        leased: true,
      });
      continue;
    }
    if (mine.has('remote_stand')) {
      resolved.set(icao, {
        kind: 'remote_stand',
        standType: 'remote',
        turnFeeMinor: 0,
        leased: true,
      });
      continue;
    }

    const total = INVENTORY_BY_TIER[tier].contact_gate;
    const spare = total - (contactGatesLeased.get(icao) ?? 0);
    const kind: StandKind = spare > 0 ? 'contact_gate' : 'remote_stand';
    resolved.set(icao, {
      kind,
      standType: spare > 0 ? 'contact' : 'remote',
      turnFeeMinor: commonUseTurnFee(kind, tier, economyGates),
      leased: false,
    });
  }

  return resolved;
}

/** One station, for a caller that genuinely has only one. */
export async function resolveStand(
  db: Database,
  own: { id: string; worldId: string },
  icao: string,
  economyGates: Parameters<typeof standAnnualFee>[3],
): Promise<ResolvedStand> {
  const resolved = await resolveStands(db, own, [icao], economyGates);
  const stand = resolved.get(icao);
  if (stand === undefined) {
    throw new Error(`resolveStands did not answer for ${icao}`);
  }
  return stand;
}

/* -- Shared with the worker -------------------------------------------------- */

/**
 * One airline's monthly bill for the stands it leases, from the **pinned** fees.
 *
 * A twelfth of each row's own `annual_fee_minor`, rounded per stand rather than
 * on the total, so the figure on the gates page is the sum of the figures beside
 * each stand — a bill that does not add up to its own lines is worse than no
 * breakdown, for the reason `computeTurnaround` gives about its contributions.
 */
export function monthlyLeaseBill(holdings: readonly { annualFeeMinor: number }[]): number {
  return holdings.reduce((total, row) => total + Math.round(row.annualFeeMinor / 12), 0);
}
