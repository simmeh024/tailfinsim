import { and, eq, inArray, or } from 'drizzle-orm';

import {
  CABIN_ORDER,
  FareTable,
  type CabinClass,
  type ServicePaybackRequest,
  type ServicePaybackResponse,
} from '@tailfin/shared';
import {
  packageEconomics,
  productScoreForPackage,
  servicePayback,
  weightedNetPerPaxMinor,
} from '@tailfin/sim';

import { demandPool, route, routeGroup, routeGroupMember, world } from '../db/schema';
import { loadEconomyConfig } from '../economy/loader';
import { canonicalPair } from '../network/economics';

import { resolveProductScore } from './product-score';

import type { ResolvedPlayerAirline } from '../airline/context';
import type { Database } from '../db/client';

/**
 * The payback table (M8-05, App. D.4).
 *
 * > Service spending only earns its money through the `ProductScore` term in
 * > Appendix A. That is fully calculable, so the game should just tell the player.
 *
 * ## Why this is an endpoint rather than client arithmetic
 *
 * App. D.4 wants the table live *"as you toggle options"*, which sounds like a
 * job for the browser. It is not one here, and the reason is structural:
 * `packages/web` **does not depend on `@tailfin/sim`** and must not start —
 * that is the package graph CONTRIBUTING.md enforces. A client computing its own
 * payback would be a second implementation of App. A.3's utility, and M8-05's
 * third acceptance criterion is that this *"uses the same sim code as demand
 * resolution"*.
 *
 * So the draft package comes here and the table goes back. Live means a request
 * per toggle, which is cheap: two indexed reads and some arithmetic, no writes.
 *
 * ## What it is priced against
 *
 * The **airline's own routes** — a route group's if one is named, otherwise the
 * whole network — because the appendix is explicit that the table is computed
 * *"against the actual segment mix of the routes the aircraft flies"*. A package
 * is a good idea or a bad one depending entirely on who is in the cabin, and a
 * table computed against an imaginary average would hide exactly the decision it
 * exists to inform.
 *
 * The **segment mix** is the real one, from `demand_pool`'s per-pair shares,
 * weighted by each pair's daily passengers so a thin route does not count as
 * much as a dense one.
 *
 * The **average fare** is the airline's own mean economy fare across those
 * routes. `PriceRel` in App. A.3 divides by the *market* average, and these
 * coincide only for an airline priced at market — but the market average needs
 * every competitor's fares on every pair, which is a query per route for a
 * denominator the player is themselves choosing. Their own fare level is the
 * honest, cheap answer, and the response says which routes it came from so the
 * number is inspectable rather than mysterious.
 */

/** The baseline a package is measured against: nothing configured at all. */
const BASELINE = { perClass: {}, commercialIntensity: 0 } as const;

interface PricedRoutes {
  routeIds: string[];
  averageFareMinor: number;
  share: { business: number; leisure: number; vfr: number };
  /** The route whose product score stands for the group — the first, by pair. */
  sample: { routeId: string; originIcao: string } | null;
}

/** The airline's routes, their fare level and the mix of who flies them. */
async function priceableRoutes(
  db: Database,
  own: ResolvedPlayerAirline,
  routeGroupId: string | undefined,
): Promise<PricedRoutes> {
  const rows = await db
    .select({
      id: route.id,
      originIcao: route.originIcao,
      destinationIcao: route.destinationIcao,
      fares: route.fares,
    })
    .from(route)
    .where(
      routeGroupId === undefined
        ? and(eq(route.airlineId, own.id), eq(route.active, true))
        : and(
            eq(route.airlineId, own.id),
            inArray(
              route.id,
              db
                .select({ id: routeGroupMember.routeId })
                .from(routeGroupMember)
                .where(eq(routeGroupMember.routeGroupId, routeGroupId)),
            ),
          ),
    )
    .orderBy(route.originIcao, route.destinationIcao);

  if (rows.length === 0) {
    return {
      routeIds: [],
      averageFareMinor: 0,
      share: { business: 0, leisure: 0, vfr: 0 },
      sample: null,
    };
  }

  let fareTotal = 0;
  let fareCount = 0;
  for (const row of rows) {
    const parsed = FareTable.safeParse(JSON.parse(row.fares) as unknown);
    // A malformed fare table skips that route rather than failing the preview:
    // one unreadable row must not take a whole configurator down.
    if (!parsed.success) continue;
    const economy = parsed.data.economy;
    if (economy === undefined || economy <= 0) continue;
    fareTotal += economy;
    fareCount += 1;
  }

  // Every pair the airline flies, in `demand_pool`'s canonical order.
  const pairs = rows.map((row) => canonicalPair(row.originIcao, row.destinationIcao));
  const pools = await db
    .select({
      dailyPassengers: demandPool.dailyPassengers,
      businessShare: demandPool.businessShare,
      leisureShare: demandPool.leisureShare,
      vfrShare: demandPool.vfrShare,
    })
    .from(demandPool)
    .where(
      and(
        eq(demandPool.worldId, own.worldId),
        or(
          ...pairs.map(([a, b]) =>
            and(eq(demandPool.originIcao, a), eq(demandPool.destinationIcao, b)),
          ),
        ),
      ),
    );

  let business = 0;
  let leisure = 0;
  let vfr = 0;
  let pax = 0;
  for (const pool of pools) {
    // `numeric` is a string at the driver boundary — the trap CLAUDE.md records.
    const daily = Number(pool.dailyPassengers);
    if (!Number.isFinite(daily) || daily <= 0) continue;
    business += Number(pool.businessShare) * daily;
    leisure += Number(pool.leisureShare) * daily;
    vfr += Number(pool.vfrShare) * daily;
    pax += daily;
  }

  const first = rows[0];
  return {
    routeIds: rows.map((row) => row.id),
    averageFareMinor: fareCount === 0 ? 0 : Math.round(fareTotal / fareCount),
    // A world with no demand pools generated yet gives no mix. Zeroes rather
    // than an invented even split: the weighting then declines to answer, which
    // is the truth about a world `demand:generate` has not run against.
    share:
      pax <= 0
        ? { business: 0, leisure: 0, vfr: 0 }
        : { business: business / pax, leisure: leisure / pax, vfr: vfr / pax },
    sample: first === undefined ? null : { routeId: first.id, originIcao: first.originIcao },
  };
}

/** Price a draft package against the airline's own network. */
export async function previewPayback(
  db: Database,
  own: ResolvedPlayerAirline,
  request: ServicePaybackRequest,
): Promise<ServicePaybackResponse> {
  const economy = await loadEconomyConfig(db, await economyVersionOf(db, own.worldId));
  const priced = await priceableRoutes(db, own, request.routeGroupId);

  /*
   * The execution behind the score. Read from the sample route's origin so the
   * crew and caterer are this airline's real ones — the same resolver the
   * demand model uses, so the configurator cannot disagree with the allocator.
   * Without a route there is nothing to read and the configured reference stands.
   */
  const resolved =
    priced.sample === null
      ? null
      : await resolveProductScore(db, {
          airlineId: own.id,
          routeId: priced.sample.routeId,
          originIcao: priced.sample.originIcao,
          economy,
          seatsByCabin: {},
        });
  const execution = resolved?.execution ?? {
    execution: economy.service.execution.fallback,
    factors: [],
    absent: [],
    fromFallback: true,
  };

  const cabin: CabinClass = request.cabin ?? 'economy';
  const cabins = CABIN_ORDER.filter((entry) => request.content.perClass[entry] !== undefined).map(
    (entry) => {
      const economics = packageEconomics(economy.service, request.content, entry);
      const withPackage = productScoreForPackage(economy.service, {
        content: request.content,
        cabin: entry,
        execution: execution.execution,
        seat: null,
      }).score;
      const baseline = productScoreForPackage(economy.service, {
        content: BASELINE,
        cabin: entry,
        execution: execution.execution,
        seat: null,
      }).score;
      return {
        cabin: entry,
        costPerPaxMinor: economics.costPerPaxMinor,
        revenuePerPaxMinor: economics.revenuePerPaxMinor,
        netPerPaxMinor: economics.netPerPaxMinor,
        turnaroundDeltaMinutes: economics.turnaroundDeltaMinutes,
        productScore: withPackage,
        productDelta: withPackage - baseline,
      };
    },
  );

  const priced_ = cabins.find((entry) => entry.cabin === cabin);
  const economics = packageEconomics(economy.service, request.content, cabin);
  const productDelta = priced_?.productDelta ?? 0;

  const rows = servicePayback(
    {
      productDelta,
      costPerPaxMinor: economics.costPerPaxMinor,
      revenuePerPaxMinor: economics.revenuePerPaxMinor,
      averageFareMinor: priced.averageFareMinor,
    },
    economy.demand.logit,
  );

  const groupName =
    request.routeGroupId === undefined
      ? null
      : ((
          await db
            .select({ name: routeGroup.name })
            .from(routeGroup)
            .where(and(eq(routeGroup.id, request.routeGroupId), eq(routeGroup.airlineId, own.id)))
            .limit(1)
        )[0]?.name ?? null);

  return {
    context: {
      routes: priced.routeIds.length,
      averageFareMinor: priced.averageFareMinor,
      routeGroupName: groupName,
    },
    cabins,
    segments: rows.map((row) => ({ ...row, share: priced.share[row.segment] })),
    weightedNetPerPaxMinor: weightedNetPerPaxMinor(rows, priced.share),
    execution: {
      value: execution.execution,
      weakest: execution.factors.filter((factor) => factor.weakest).map((factor) => factor.input),
      absent: [...execution.absent],
      fromFallback: execution.fromFallback,
    },
  };
}

/** The world's pinned economy version. */
async function economyVersionOf(db: Database, worldId: string): Promise<string> {
  const [row] = await db
    .select({ version: world.economyConfigVersion })
    .from(world)
    .where(eq(world.id, worldId))
    .limit(1);
  if (row === undefined) throw new Error(`no world ${worldId}`);
  return row.version;
}
