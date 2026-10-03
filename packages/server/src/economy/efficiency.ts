import {
  EFFICIENCY_QUANTITIES,
  type EconomyConfig,
  type EfficiencyQuantityReadout,
} from '@tailfin/shared';
import { resolveEfficiencyBoosts, type CrewBoostSources, type ResolvedBoosts } from '@tailfin/sim';

import { airlineSkillBoosts } from '../crew/roster';
import { airlineDoctrine } from '../research/doctrine';

import type { Database } from '../db/client';

/**
 * Every source of §10.4 efficiency an airline holds, resolved once (M9-06).
 *
 * > *"Hard caps. Stacking academy + research + personal skill + Training
 * > Captain never exceeds the ceiling."*
 *
 * The one place the server gathers the sources — named crew's skill points,
 * Training Captains at their reduced line value, and completed research at its
 * current doctrine strength — and hands them to `resolveEfficiencyBoosts`
 * together, against the world's own ceilings. Every consumer reads its quantity
 * from here, so no consumer can stack a source the others do not see, and none
 * can apply a boost the ceiling has not already clamped:
 *
 * | Quantity        | Consumer                                                    |
 * | --------------- | ----------------------------------------------------------- |
 * | fuel burn       | `settleArrivedFlight` → `computeFuelBurn`                   |
 * | block time      | `settleArrivedFlight` and the schedule plan (`placeLegs`)   |
 * | maintenance     | the settlement reserve, and a check's price at booking      |
 * | incident rate   | the departure disruption roll                               |
 * | turnaround      | the schedule plan's turns (`turnaroundResolver`)            |
 * | service cost    | App. D's per-passenger cost in the service configurator     |
 *
 * The academy is not a source, by §10's own core rule — *"Academy level gates
 * the ceiling. It does not grant the boost"* — see `BoostSource`.
 *
 * And nothing here reaches the demand model: `economy/boost-isolation.test.ts`
 * walks the source and fails if a module that feeds it can even name this
 * function.
 */

export interface AirlineEfficiency {
  /** Every quantity, all sources stacked once and clamped at the world's ceiling. */
  resolved: ResolvedBoosts;
  /**
   * Crew Development doctrine's XP bonus at its current strength. Not a §10.4
   * quantity: it goes to `trainingXpMultiplier`, which caps it together with
   * Training Captains under `crew.trainingCaptain.maxXpBonus`.
   */
  doctrineCrewXp: number;
  /** How many named members put something into each skill-reachable quantity, per source. */
  crewContributors: CrewBoostSources['contributors'];
}

/**
 * Resolve an airline's efficiency at a game instant.
 *
 * `at` is game time, and it matters only for doctrine: a lapsing node is worth
 * less next week than this one, so a settlement passes its arrival and a
 * disruption roll its departure, and a replay reads the strength it had then.
 * Skills and Training Captains are read as they stand, for the reason
 * `settleArrivedFlight` gives about skill points.
 *
 * Reads run one after another, not together: a caller inside a transaction holds
 * one connection, and concurrent queries on it are queued with a warning by the
 * driver rather than parallelised.
 */
export async function resolveAirlineEfficiency(
  db: Database,
  own: { worldId: string; airlineId: string },
  at: Date,
  economy: Pick<EconomyConfig, 'boosts' | 'research'>,
): Promise<AirlineEfficiency> {
  const crew = await airlineSkillBoosts(db, own);
  const doctrine = await airlineDoctrine(db, own.airlineId, at, economy.research);
  return {
    resolved: resolveEfficiencyBoosts(
      {
        skills: crew.skills,
        trainingCaptains: crew.trainingCaptains,
        doctrine: doctrine.efficiency,
      },
      economy.boosts.ceilings,
    ),
    doctrineCrewXp: doctrine.crewXp,
    crewContributors: crew.contributors,
  };
}

/** The six quantities in the wire shape the research page draws. */
export function efficiencyReadout(resolved: ResolvedBoosts): EfficiencyQuantityReadout[] {
  return EFFICIENCY_QUANTITIES.map((quantity) => {
    const row = resolved[quantity];
    return {
      quantity,
      ceiling: row.ceiling,
      uncapped: row.uncapped,
      fraction: row.fraction,
      capped: row.capped,
      bySource: { ...row.bySource },
    };
  });
}
