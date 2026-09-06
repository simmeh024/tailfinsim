import { and, eq } from 'drizzle-orm';

import { CABIN_ORDER, HandlerGrade, type CabinClass, type EconomyConfig } from '@tailfin/shared';
import {
  handlerProfile,
  productScoreForPackage,
  serviceExecution as moraleToExecution,
  serviceExecutionMultiplier,
  type ExecutionResult,
} from '@tailfin/sim';

import { crewBase, groundContract } from '../db/schema';

import { servicePackageForRoutes } from './store';

import type { Database } from '../db/client';

/**
 * The one place a real `ProductScore` is assembled (M8-04, App. D.6, App. A.3).
 *
 * M8-04's second acceptance criterion is that *"ProductScore feeds the demand
 * model and nothing else computes it separately"*. Before this, two constants
 * did: `REFERENCE_SELF.productScore` and `PLAYER_ASSUMPTION.productScore`, both
 * `0.6`, both honest placeholders for a system that did not exist. This is the
 * system, and `product-score-source.test.ts` is the guard that keeps it the only
 * one — it scans the repository for another module deriving a product score.
 *
 * ## What it reads, and what it cannot
 *
 * The four App. D.1 execution levers, resolved from real state where real state
 * exists:
 *
 * | Lever | Source | Today |
 * | --- | --- | --- |
 * | crew morale | `crew_base.morale` at the origin, through M5-03's own curve | **read** |
 * | catering vendor quality | the origin's ground contract grade (§9.3) | **read** |
 * | crew service skill | §10.2's training academy | absent (M10) |
 * | crew-to-passenger ratio | a flight's carried load against its cabin crew | absent here |
 *
 * The last is absent *at this altitude* rather than unbuilt: a route's economics
 * are computed before any particular flight, so there is no load and no roster
 * to divide. A settlement resolving service for one flight has both and passes
 * them; see {@link ProductScoreInputsOverride}.
 *
 * An absent lever is left out of the weakest-link rather than scored zero —
 * `sim/service/execution.ts` says why at length, and the short version is that
 * an unbuilt system must not move the number.
 *
 * ## Per cabin, then blended
 *
 * App. D.6's weights differ by cabin, so the score does too, and
 * {@link ResolvedProductScore.byCabin} carries each. `overall` is the
 * seat-weighted blend across the cabins the aircraft actually has — the single
 * number `RouteEconomics.self.productScore` has always been, now meaning
 * something. Weighting by seats rather than averaging the cabins is the
 * difference between describing an aeroplane and describing a brochure: a
 * 12-seat business cabin should not count equally with 150 seats of economy.
 *
 * ## No package is not an empty package
 *
 * A route in no group, or in a group with no package, has **no** service
 * configuration — and that is not the same as one configured to nothing. It
 * scores the world's baseline: every category at tier 0, which is what the
 * catalogue says an airline serving nothing serves. The difference matters only
 * in what it costs (nothing either way) and in what the UI should say, but
 * conflating them would let "I have not configured this yet" read as a decision.
 */

/** What one airline's product comes to on one route. */
export interface ResolvedProductScore {
  /** Seat-weighted across the cabins on offer. The number App. A.3 multiplies. */
  overall: number;
  /** Each cabin's own score, for the per-cabin offer the allocator can take. */
  byCabin: Partial<Record<CabinClass, number>>;
  /** The execution behind it, so a payback table can name the weakest lever. */
  execution: ExecutionResult;
  /** True when no route group supplied a package and the baseline was scored. */
  baseline: boolean;
}

/**
 * Levers a caller knows and this module cannot read for itself.
 *
 * Settlement has a flight: its carried passengers and the crew actually rostered
 * onto it, which is the only place App. D.1's crew-to-passenger ratio is a real
 * quantity rather than a plan.
 */
export interface ProductScoreInputsOverride {
  crewToPaxRatio?: number | null;
  crewServiceSkill?: number | null;
}

/** The origin base's morale, or null when there is no base or it was never reviewed. */
async function moraleAt(
  db: Database,
  airlineId: string,
  originIcao: string,
): Promise<number | null> {
  const [row] = await db
    .select({ morale: crewBase.morale })
    .from(crewBase)
    .where(
      and(
        eq(crewBase.airlineId, airlineId),
        eq(crewBase.airportIcao, originIcao),
        eq(crewBase.status, 'open'),
      ),
    )
    .limit(1);
  // Null means never reviewed, which CLAUDE.md is emphatic is not zero. A base
  // that has not had a morale review has nothing to say about service yet.
  return row?.morale ?? null;
}

/**
 * The quality of the handler doing the airline's cabin service at the origin.
 *
 * §9.3's `quality` on the contracted grade — the lever `sim/ground/vendor.ts`
 * has carried since M5-06 saying its consumer *"is not built"*. This is that
 * consumer. Walk-up handling has no contract and no grade, so it reads as null
 * and drops out of the weakest link rather than being scored as a bad vendor:
 * an airline that never signed anything has not chosen a bad caterer.
 */
async function vendorQualityAt(
  db: Database,
  airlineId: string,
  originIcao: string,
): Promise<number | null> {
  const [row] = await db
    .select({ grade: groundContract.grade })
    .from(groundContract)
    .where(
      and(
        eq(groundContract.airlineId, airlineId),
        eq(groundContract.airportIcao, originIcao),
        eq(groundContract.serviceLine, 'catering'),
        eq(groundContract.status, 'active'),
      ),
    )
    .limit(1);
  if (row === undefined) return null;
  // `grade` is a text column, so narrow it rather than assert: a row written by
  // a build that knew a grade this one does not is unreadable, not a bad vendor.
  const grade = HandlerGrade.safeParse(row.grade);
  if (!grade.success) return null;
  // The grade profiles are `packages/sim`'s, not the economy payload's — M5-06
  // put four of §9.3's five numbers there deliberately.
  return handlerProfile(grade.data).quality;
}

/**
 * Assemble the score for an airline on a route.
 *
 * One database round trip per lever and one for the package, run together. The
 * economics provider calls this once per route, so the cost is a route's cost
 * rather than a flight's.
 */
export async function resolveProductScore(
  db: Database,
  args: {
    airlineId: string;
    routeId: string;
    originIcao: string;
    economy: EconomyConfig;
    /** Seats per cabin the aircraft actually offers — the blend's weights. */
    seatsByCabin: Partial<Record<CabinClass, number>>;
    overrides?: ProductScoreInputsOverride;
  },
): Promise<ResolvedProductScore> {
  const [packages, morale, vendorQuality] = await Promise.all([
    servicePackageForRoutes(db, args.airlineId, [args.routeId]),
    moraleAt(db, args.airlineId, args.originIcao),
    vendorQualityAt(db, args.airlineId, args.originIcao),
  ]);

  const execution = serviceExecutionMultiplier(args.economy.service.execution, {
    // Through M5-03's curve, never raw — see `sim/service/execution.ts`.
    crewMorale: morale === null ? null : moraleToExecution(morale, args.economy.crew.morale),
    vendorQuality,
    crewServiceSkill: args.overrides?.crewServiceSkill ?? null,
    crewToPaxRatio: args.overrides?.crewToPaxRatio ?? null,
  });

  const resolved = packages.get(args.routeId);
  const content = resolved?.content ?? { perClass: {}, commercialIntensity: 0 };

  const byCabin: Partial<Record<CabinClass, number>> = {};
  let weighted = 0;
  let seats = 0;
  for (const cabin of CABIN_ORDER) {
    const cabinSeats = args.seatsByCabin[cabin] ?? 0;
    if (cabinSeats <= 0) continue;
    const score = productScoreForPackage(args.economy.service, {
      content,
      cabin,
      execution: execution.execution,
      // §6.4's comfort score is M6-09's; until then the term is renormalised
      // away rather than scored zero.
      seat: null,
    }).score;
    byCabin[cabin] = score;
    weighted += score * cabinSeats;
    seats += cabinSeats;
  }

  return {
    // No seats at all is not a product of zero, it is no aeroplane. Score the
    // economy cabin so a caller previewing a route without a fleet still gets a
    // number that means what the package says.
    overall:
      seats > 0
        ? weighted / seats
        : productScoreForPackage(args.economy.service, {
            content,
            cabin: 'economy',
            execution: execution.execution,
            seat: null,
          }).score,
    byCabin,
    execution,
    baseline: resolved === undefined,
  };
}
