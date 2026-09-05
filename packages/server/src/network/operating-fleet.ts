import { and, eq, inArray } from 'drizzle-orm';

import { AircraftSpec, type CabinClass } from '@tailfin/shared';
import { type FareFloorAircraft } from '@tailfin/sim';

import { settlementAirframeOf } from '../aircraft/performance';
import { airframe, schedule, scheduleLeg } from '../db/schema';

import type { Database } from '../db/client';

/**
 * What the airline actually flies on a route (IMPROVE-02).
 *
 * Every fare floor and every fare preview in the game was drawn against
 * `REFERENCE_AIRFRAME` — a hand-authored 79-tonne narrowbody with 174 seats —
 * whatever the airline owned. A player flying ATRs was quoted a floor for an
 * A320 and an allocation for 174 seats they did not have, so the decision the
 * fleet page exists to support did not reach the one screen where fares are set.
 *
 * The settlement half of IMPROVE-02 fixed the *bill*; this fixes the *estimate*,
 * and the two now read the same catalogue through the same
 * `settlementAirframeOf`.
 *
 * ## The basis is the schedule, not the flights
 *
 * A `flight` row exists only where a worker has materialised one, and production
 * has no worker (OPS-12). A `schedule` is the airline's own stated plan and
 * exists the moment they publish, everywhere. So *"what do you fly on this
 * route?"* is answered from the rotations that touch it.
 *
 * ## Mixed and unassigned are answers, not fallbacks
 *
 * The issue is explicit that neither may be papered over with an arbitrary
 * reference aircraft:
 *
 *   - **`single`** — one type operates the route. The obvious case.
 *   - **`mixed`** — several. Seats and identity come from the type making the
 *     most departures, because that is the aeroplane a player would name if
 *     asked; the *floor* is drawn over every type (see {@link OperatingType}),
 *     because a floor is a guard and a guard has to hold for the dearest
 *     departure rather than the commonest one.
 *   - **`unassigned`** — no rotation touches the route. There is no operating
 *     aircraft to base anything on, so the reference is used and the basis
 *     **says so**. A player pricing a route they do not yet fly is asking a
 *     hypothetical, and the honest answer names its assumption.
 *
 * ## The seat split is a stand-in, and a smaller one than before
 *
 * `AircraftSpec.seatsTwoClass` is what App. C.2 says a normal airline fits in
 * two classes; it does not say how many of those are business. M6-08's cabin
 * configurator is UI-only so far — no `airframe.cabin_config_id` is ever
 * populated — so the split is derived from one documented share below.
 *
 * That is still a stand-in. It is a much smaller one than a fixed 174-seat
 * aeroplane for every route in the game, and it goes away when a cabin config
 * is persisted: the airframe already has the column.
 */

/**
 * Business-class share of a two-class layout.
 *
 * 7% — twelve seats of a hundred and seventy-four, which is what
 * `REFERENCE_AIRFRAME` carried and is a normal short-haul European split. Kept
 * as that exact ratio so the change from the reference aircraft moves the
 * *aeroplane* and not, silently, the cabin mix as well: a diff that changes two
 * things is a diff nobody can attribute.
 */
const BUSINESS_SHARE = 12 / 174;

/** Split a two-class seat count into cabins. */
export function seatsByCabin(seatsTwoClass: number): Partial<Record<CabinClass, number>> {
  if (seatsTwoClass <= 0) return {};
  const business = Math.round(seatsTwoClass * BUSINESS_SHARE);
  const economy = seatsTwoClass - business;
  // A freighter or a tiny type can round to no business cabin at all, which is a
  // real answer: `selfAsOperator` sells only the cabins with seats in them.
  return business > 0 ? { business, economy } : { economy: seatsTwoClass };
}

/** One type operating a route, and how much of it that type does. */
export interface OperatingType {
  typeDesignation: string;
  /** §22.5's pin, so an estimate can be explained under the catalogue that produced it. */
  catalogueVersion: string;
  /** Legs on this route, in this direction, across every rotation. */
  departures: number;
  aircraft: FareFloorAircraft;
}

export interface OperatingBasis {
  kind: 'single' | 'mixed' | 'unassigned';
  /**
   * Every type on the route, busiest first. Empty when `unassigned`.
   *
   * The floor is drawn over all of them; the preview's seats come from the first.
   */
  types: OperatingType[];
  /** What to describe the basis as, in one phrase the client can render. */
  label: string;
}

/**
 * A `FareFloorAircraft` from a stored effective spec.
 *
 * Deliberately the *same* derivation the settlement bills on, from the same
 * stored spec and with the same default `FuelBurnConfig` — so a floor and the
 * bill that follows it cannot disagree about the aeroplane. Sharing
 * `settlementAirframeOf` is what makes that a property of the call graph rather
 * than of two files staying in step.
 */
function fareFloorAircraftOf(spec: AircraftSpec): FareFloorAircraft {
  return {
    ...settlementAirframeOf(spec),
    seatsByCabin: seatsByCabin(spec.seatsTwoClass),
  };
}

/**
 * Which types the airline schedules over this pair, busiest first.
 *
 * Directional, matching `route`: a rotation AMS→LEBL→AMS operates the AMS→LEBL
 * route once, not twice, and the LEBL→AMS route once. Counting both against one
 * route would double every frequency.
 *
 * Only `active` schedules count. A paused rotation is not flying, so basing a
 * fare estimate on it would quote for capacity the airline is not offering.
 */
export async function loadOperatingBasis(
  db: Database,
  input: { worldId: string; airlineId: string; originIcao: string; destinationIcao: string },
): Promise<OperatingBasis> {
  const legs = await db
    .select({ airframeId: schedule.airframeId })
    .from(scheduleLeg)
    .innerJoin(schedule, eq(scheduleLeg.scheduleId, schedule.id))
    .where(
      and(
        eq(schedule.worldId, input.worldId),
        eq(schedule.airlineId, input.airlineId),
        eq(schedule.active, true),
        eq(scheduleLeg.originIcao, input.originIcao),
        eq(scheduleLeg.destinationIcao, input.destinationIcao),
      ),
    );

  if (legs.length === 0) {
    return { kind: 'unassigned', types: [], label: 'no aircraft scheduled on this route' };
  }

  const departuresByAirframe = new Map<string, number>();
  for (const leg of legs) {
    departuresByAirframe.set(leg.airframeId, (departuresByAirframe.get(leg.airframeId) ?? 0) + 1);
  }

  const rows = await db
    .select({
      id: airframe.id,
      typeDesignation: airframe.typeDesignation,
      catalogueVersion: airframe.catalogueVersion,
      effectiveSpec: airframe.effectiveSpec,
    })
    .from(airframe)
    .where(
      and(
        eq(airframe.worldId, input.worldId),
        inArray(airframe.id, [...departuresByAirframe.keys()]),
      ),
    );

  /*
   * Grouped by **type**, not by airframe.
   *
   * Two A320neos with the same options cost the same to fly, and a floor quoted
   * per tail would be the same number twice. Options are already folded into
   * `effective_spec`, so two tails of one type with different options land in
   * the same group and the busier one's spec wins — a difference of a few per
   * cent in burn, against the alternative of listing every registration on a
   * pricing screen.
   */
  const byType = new Map<string, OperatingType>();
  for (const row of rows) {
    const parsed = AircraftSpec.safeParse(JSON.parse(row.effectiveSpec) as unknown);
    // A spec this build cannot read is skipped rather than fatal: a fare preview
    // that refuses to load is worse than one drawn on the rest of the fleet, and
    // the settlement is where an unreadable spec must stop the world.
    if (!parsed.success) continue;

    const departures = departuresByAirframe.get(row.id) ?? 0;
    const existing = byType.get(row.typeDesignation);
    if (existing) {
      existing.departures += departures;
      continue;
    }
    byType.set(row.typeDesignation, {
      typeDesignation: row.typeDesignation,
      catalogueVersion: row.catalogueVersion,
      departures,
      aircraft: fareFloorAircraftOf(parsed.data),
    });
  }

  const types = [...byType.values()].sort(
    (a, b) => b.departures - a.departures || a.typeDesignation.localeCompare(b.typeDesignation),
  );

  if (types.length === 0) {
    return {
      kind: 'unassigned',
      types: [],
      label: 'the scheduled aircraft could not be read',
    };
  }

  if (types.length === 1) {
    return { kind: 'single', types, label: types[0]!.typeDesignation };
  }

  return {
    kind: 'mixed',
    types,
    label: `mixed fleet — ${types.map((t) => t.typeDesignation).join(', ')}`,
  };
}
