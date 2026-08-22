import { eq } from 'drizzle-orm';

import type {
  AircraftAvailabilityState,
  CatalogueEntry,
  FleetCatalogueResponse,
} from '@tailfin/shared';
import { availabilityOf, gameTime, restrictionCost, type WorldClock } from '@tailfin/sim';

import { type Database } from '../db/client';
import { world } from '../db/schema';
import { loadEconomyConfig } from '../economy/loader';

import { loadCatalogue } from './catalogue';

/**
 * The catalogue as one world sees it, on its own clock (M4-02, §7.2b).
 *
 * ## The clock is the world's, not the server's
 *
 * A world runs at its own speed multiplier from its own epoch, so "today" for
 * the flagship world in October 2024 is a different date from the wall clock
 * and moves at twice the rate. Every availability decision here is made against
 * `gameTime(clock, now)` for that reason, and the answer is computed on the
 * server so a browser cannot reach a different one (§21).
 *
 * ## Absent, not locked
 *
 * §7.2b is stronger than "hidden": *"An aircraft simply **does not exist** in a
 * world whose clock hasn't reached it."* So a type before its first flight is
 * left out of the response entirely. A 1950s world showing a greyed-out A350
 * with "arrives 2015" would be telling a player about a future their world does
 * not have — and would leak the catalogue's contents into an era that should
 * not know them.
 *
 * A type that has *flown* but is not yet in service is a different case, and is
 * listed: that is the prototype window, it is real, and §7.2c eventually makes
 * it playable.
 */

function clockOf(row: { epoch: Date; launchDate: Date; speedMultiplier: string }): WorldClock {
  return {
    epoch: row.epoch,
    launchDate: row.launchDate,
    speedMultiplier: Number(row.speedMultiplier),
  };
}

/** One sentence per state, in the vocabulary a player thinks in. */
function detailFor(
  state: AircraftAvailabilityState,
  arrivesOn: string | null,
  productionEnd: string | null,
): string {
  switch (state) {
    case 'orderable':
      return 'Available to order new, lease, or buy used.';
    case 'prototype':
      return arrivesOn === null
        ? 'Flying as a prototype. No entry into service has been announced, so it cannot be ordered.'
        : `Flying as a prototype. Enters service on ${arrivesOn}, and can be ordered from then.`;
    case 'used_only':
      return productionEnd === null
        ? 'Out of production. Available on the used market and by lease only.'
        : `Out of production since ${productionEnd}. Available on the used market and by lease only.`;
    case 'retired':
      return 'Withdrawn from service. This type may no longer be operated.';
    case 'unannounced':
      // Not reachable through `fleetCatalogue`, which filters these out. Kept
      // total so the switch cannot silently gain a hole.
      return 'Not yet flying.';
  }
}

export async function fleetCatalogue(
  db: Database,
  worldId: string,
  now: Date = new Date(),
): Promise<FleetCatalogueResponse> {
  const rows = await db
    .select({
      epoch: world.epoch,
      launchDate: world.launchDate,
      speedMultiplier: world.speedMultiplier,
      catalogueVersion: world.aircraftCatalogueVersion,
      economyConfigVersion: world.economyConfigVersion,
    })
    .from(world)
    .where(eq(world.id, worldId))
    .limit(1);

  const row = rows[0];
  if (!row) throw new Error(`No world ${worldId}`);

  const inGameDate = gameTime(clockOf(row), now);
  const [catalogue, economy] = await Promise.all([
    loadCatalogue(db, row.catalogueVersion),
    loadEconomyConfig(db, row.economyConfigVersion),
  ]);

  const types: CatalogueEntry[] = [];

  for (const type of catalogue.values()) {
    const state = availabilityOf(type.eraDates, inGameDate);
    // §7.2b: it does not exist yet. Not listed, not greyed out, not mentioned.
    if (state === 'unannounced') continue;

    const cost = restrictionCost(
      type.eraDates,
      inGameDate,
      type.baseSpec.mtowTonnes,
      economy.costs.restrictions,
    );

    types.push({
      designation: type.designation,
      family: type.family,
      manufacturer: type.manufacturer,
      class: type.class,

      availability: state,
      detail: detailFor(state, type.eraDates.entryIntoService, type.eraDates.productionEnd),
      // Only forward-looking. A type already in service has no arrival left to
      // announce, and putting its historical EIS here would read as a countdown.
      arrivesOn: state === 'prototype' ? type.eraDates.entryIntoService : null,

      seatsTwoClass: type.baseSpec.seatsTwoClass,
      maxSeats: type.baseSpec.maxSeats,
      rangeNm: type.baseSpec.rangeNm,
      mtowTonnes: type.baseSpec.mtowTonnes,
      runwayRequirementM: type.baseSpec.runwayRequirementM,
      wingspanCode: type.baseSpec.wingspanCode,

      listPrice: type.listPrice,
      monthlyLeaseRate: type.monthlyLeaseRate,

      restrictions: cost.charges.map((charge) => ({
        kind: charge.kind,
        since: charge.since,
        amountMinor: charge.amountMinor,
        note: charge.note,
      })),
      restrictionCostPerDepartureMinor: cost.totalMinor,
    });
  }

  return {
    inGameDate: inGameDate.toISOString(),
    catalogueVersion: row.catalogueVersion,
    types,
  };
}
