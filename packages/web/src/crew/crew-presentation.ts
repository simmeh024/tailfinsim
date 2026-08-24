import type { CrewRank, CrewResponse } from '@tailfin/shared';

/**
 * Presentation folds over the crew payload — and nothing else (§21).
 *
 * ## The line this file is on the safe side of
 *
 * Every value here is a **regrouping, a count or a ratio of figures the server
 * already decided**. Nothing works out how many crew an aeroplane needs, whether
 * a head is qualified, what a hire costs or when a course ends. Those answers
 * arrive from `/api/crew` and this file may not second-guess them, because a
 * second implementation of a rule is a second answer, and the browser's would be
 * the one nobody could audit.
 *
 * The test for whether something belongs here: *could the server change its mind
 * and this code still be right?* Summing four `headcount` values survives that.
 * Deciding that a 180-seat aeroplane needs four cabin crew does not.
 *
 * ## Why the folds are here rather than inline in the components
 *
 * Because they are the part worth pinning. A table that renders `row.delta` is
 * hard to get wrong; a coverage percentage that quietly divides by zero on a new
 * airline is easy to, and it renders as `NaN%` in the largest text on the page.
 */

export interface CoverageSummary {
  /**
   * How much of the **minimum requirement** is met, 0–1.
   *
   * Not "of today's flights". The requirement is one departure per aeroplane
   * owned — a floor — and the wording everywhere this appears has to keep saying
   * so until duty-aware rostering exists to say something stronger.
   */
  ratio: number;
  /** `null` when there is nothing to cover, which is not the same as 0%. */
  percent: number | null;
  covered: boolean;
  /** Rank/family combinations that are short. The count the KPI strip shows. */
  shortages: number;
  totalRequired: number;
  metRequired: number;
}

/**
 * Coverage, from the server's own fold.
 *
 * `metRequired` exists because totals hide a per-rank shortage: an airline with
 * a surplus of cabin crew and no captains sums to "enough people" and can fly
 * nothing. The server computes it; this only turns it into a ratio, and refuses
 * to invent one when there is nothing to cover.
 */
export function coverageSummary(crew: CrewResponse): CoverageSummary {
  const { totalRequired, metRequired, covered, rows } = crew.demand;
  const shortages = rows.filter((row) => row.delta < 0).length;

  if (totalRequired <= 0) {
    /*
     * Nothing required. An empty airline is not 0% ready and it is not 100%
     * either — it has nothing to be ready for, and both numbers would be a
     * claim. `null` makes the caller say so in words.
     */
    return { ratio: 1, percent: null, covered: true, shortages, totalRequired, metRequired };
  }

  const ratio = Math.min(1, metRequired / totalRequired);
  return {
    ratio,
    percent: Math.round(ratio * 100),
    covered,
    shortages,
    totalRequired,
    metRequired,
  };
}

export interface HeadcountSummary {
  onStrength: number;
  available: number;
  inTraining: number;
  onDuty: number;
  reserve: number;
  openBases: number;
}

/** Straight sums over the pools. The KPI strip's inventory half. */
export function headcountSummary(crew: CrewResponse): HeadcountSummary {
  const pools = crew.bases.flatMap((base) => base.pools);
  return {
    onStrength: pools.reduce((total, pool) => total + pool.headcount, 0),
    // The server's own figure, not a re-derivation: `available` is its rule.
    available: crew.fragmentation.totalAvailable,
    inTraining: pools.reduce((total, pool) => total + pool.unavailable, 0),
    onDuty: pools.reduce((total, pool) => total + pool.onDuty, 0),
    reserve: pools.reduce((total, pool) => total + pool.reserve, 0),
    openBases: crew.bases.filter((base) => base.status === 'open').length,
  };
}

export interface CommonalityBar {
  family: string;
  available: number;
  /** Share of `totalAvailable`, 0–1. Bar width, nothing else. */
  share: number;
  /** The family with the most available crew. */
  largest: boolean;
}

export interface CommonalitySummary {
  bars: readonly CommonalityBar[];
  totalAvailable: number;
  largestFamilyAvailable: number;
  strandedHeads: number;
  /** `largestFamilyAvailable / totalAvailable`, 0–1. `null` with no crew. */
  ratio: number | null;
  /** One word for how mixed the fleet is. */
  verdict: 'single' | 'focused' | 'moderate' | 'fragmented' | 'none';
}

/**
 * Crew by family, largest first.
 *
 * **There is no commonality score.** The percentage is `largest ÷ total` and
 * nothing else — a description of where the crew are, not a rating of the fleet.
 * §9.2's disadvantage is already real and needs no coefficient: crew rated on one
 * family are simply not in another's pool, so an airline flying two needs two
 * sets of captains to cover the same departures. Inventing a score on top would
 * charge twice for one effect and would invite *"how do I avoid the penalty?"*
 * when the answer is "fly one family".
 *
 * `verdict` is a label for that same ratio, not a second judgement.
 */
export function commonalitySummary(crew: CrewResponse): CommonalitySummary {
  const byFamily = new Map<string, number>();
  for (const base of crew.bases) {
    if (base.status !== 'open') continue;
    for (const pool of base.pools) {
      byFamily.set(pool.family, (byFamily.get(pool.family) ?? 0) + pool.available);
    }
  }

  const totalAvailable = crew.fragmentation.totalAvailable;
  const largest = crew.fragmentation.largestFamilyAvailable;

  const bars = [...byFamily]
    .map(([family, available]) => ({
      family,
      available,
      share: totalAvailable === 0 ? 0 : available / totalAvailable,
      largest: available === largest && largest > 0,
    }))
    .sort((a, b) => b.available - a.available || a.family.localeCompare(b.family));

  const ratio = totalAvailable === 0 ? null : largest / totalAvailable;
  return {
    bars,
    totalAvailable,
    largestFamilyAvailable: largest,
    strandedHeads: crew.fragmentation.strandedHeads,
    ratio,
    /*
     * The family count comes from the server's own list, not from the bars built
     * above. Both should agree and one is authoritative; counting the bars made
     * the verdict disagree with the ratio beside it the moment they were derived
     * from different halves of the payload, which a test caught.
     */
    verdict: verdictFor(crew.fragmentation.families.length, ratio),
  };
}

function verdictFor(families: number, ratio: number | null): CommonalitySummary['verdict'] {
  if (families === 0 || ratio === null) return 'none';
  if (families === 1) return 'single';
  if (ratio >= 0.75) return 'focused';
  if (ratio >= 0.5) return 'moderate';
  return 'fragmented';
}

/**
 * Which role the banner should lead with (M5-02).
 *
 * Ordering only. Nothing downstream of this touches simulation state — see
 * `CrewRoleBanner`, which says the same thing at more length because it is the
 * component somebody would be tempted to make clever.
 *
 * Shortages first, worst first, because that is the rank the player has a reason
 * to be looking at. Then ranks currently in a conversion, because a course
 * finishing is the other thing worth noticing. Ties broken by the rank's own
 * order rather than by map iteration, so the same state always produces the same
 * banner — a page that showed a different picture on every refresh would read as
 * random even though it is not.
 */
export function bannerPriorityRanks(crew: CrewResponse): readonly CrewRank[] {
  const short = crew.demand.rows
    .filter((row) => row.delta < 0)
    .sort((a, b) => a.delta - b.delta || a.rank.localeCompare(b.rank))
    .map((row) => row.rank);

  const training = crew.bases
    .flatMap((base) => base.conversions)
    .map((conversion) => conversion.rank)
    .sort((a, b) => a.localeCompare(b));

  return [...new Set([...short, ...training])];
}

export interface FamilyCoverageRow {
  rank: CrewRank;
  required: number;
  available: number;
  inTraining: number;
  delta: number;
  status: 'short' | 'exact' | 'surplus';
}

export interface FamilyCoverage {
  family: string;
  rows: readonly FamilyCoverageRow[];
  /** True when any rank in the family is short. Drives the group's heading. */
  short: boolean;
}

/**
 * The demand fold, regrouped by family for display.
 *
 * `delta` is the server's. `status` is the same number in three words, so the
 * table never leans on colour alone (App. H.7) — a red cell and a green cell are
 * the same cell to a good proportion of players.
 *
 * `inTraining` is joined in from the pools rather than requested separately: it
 * is the difference between *"hire someone"* and *"wait a fortnight"*, and a
 * coverage table that cannot tell those apart sends the player to the wrong
 * control.
 */
export function familyCoverage(crew: CrewResponse): readonly FamilyCoverage[] {
  const training = new Map<string, number>();
  for (const base of crew.bases) {
    for (const pool of base.pools) {
      const key = `${pool.family} ${pool.rank}`;
      training.set(key, (training.get(key) ?? 0) + pool.unavailable);
    }
  }

  const byFamily = new Map<string, FamilyCoverageRow[]>();
  for (const row of crew.demand.rows) {
    const rows = byFamily.get(row.family) ?? [];
    rows.push({
      rank: row.rank,
      required: row.required,
      available: row.available,
      inTraining: training.get(`${row.family} ${row.rank}`) ?? 0,
      delta: row.delta,
      status: row.delta < 0 ? 'short' : row.delta === 0 ? 'exact' : 'surplus',
    });
    byFamily.set(row.family, rows);
  }

  return (
    [...byFamily]
      .map(([family, rows]) => ({
        family,
        rows: rows.sort((a, b) => rankOrder(a.rank) - rankOrder(b.rank)),
        short: rows.some((row) => row.status === 'short'),
      }))
      // Families with a problem first; then alphabetical, so the order is stable.
      .sort((a, b) => Number(b.short) - Number(a.short) || a.family.localeCompare(b.family))
  );
}

/**
 * The full ladder, in promotion order (§9.2).
 *
 * Nine, not the three the page used to show. `crew_rank` already holds Cadet
 * through Training Captain and Cabin Crew through Cabin Service Manager, so a
 * component that assumes Captain / First Officer / Cabin Crew is already wrong
 * about the data it is given.
 */
export const RANK_ORDER: readonly CrewRank[] = [
  'training_captain',
  'captain',
  'senior_first_officer',
  'first_officer',
  'cadet',
  'cabin_service_manager',
  'purser',
  'senior_cabin_crew',
  'cabin_crew',
];

function rankOrder(rank: CrewRank): number {
  const index = RANK_ORDER.indexOf(rank);
  // An unknown rank sorts last rather than first: it is more likely to be
  // something new than something important.
  return index < 0 ? RANK_ORDER.length : index;
}

export interface FamilyCompositionRow {
  rank: CrewRank;
  headcount: number;
  available: number;
  inTraining: number;
  onDuty: number;
  reserve: number;
  /** From the demand fold. `null` when the fleet asks nothing of this rank. */
  required: number | null;
  delta: number | null;
}

export interface FamilyComposition {
  family: string;
  rows: readonly FamilyCompositionRow[];
  /** ICAO codes of the bases holding crew rated on this family. */
  bases: readonly string[];
  totals: {
    headcount: number;
    available: number;
    inTraining: number;
    onDuty: number;
    reserve: number;
    required: number;
  };
  /** True when any rank on this family is below its minimum. */
  short: boolean;
}

/**
 * Everything the airline holds for one aircraft family, by rank.
 *
 * The answer to *"what have I actually got rated on this thing"*, which neither
 * table above gives whole: the coverage table shows only ranks the fleet asks
 * for, and the base table splits the family across however many bases hold it.
 * A family with four captains at Schiphol and two at Heathrow reads as two
 * unrelated rows in one and does not appear at all in the other if nothing
 * requires it.
 *
 * ## Ranks with no requirement are still listed
 *
 * `required` is `null` rather than `0` for a rank the fleet does not ask for,
 * because the two mean different things: *"you need none of these"* and *"the
 * demand fold has nothing to say about them"*. Crew rated on a family the
 * airline no longer flies are the clearest case — they exist, they are paid, and
 * a composition that silently dropped them would hide a bill.
 *
 * Pools with no heads at all are dropped, because a rank nobody was ever hired
 * into is not a fact about the airline.
 */
export function familyComposition(crew: CrewResponse, family: string): FamilyComposition {
  const byRank = new Map<CrewRank, FamilyCompositionRow>();
  const bases = new Set<string>();

  for (const base of crew.bases) {
    for (const pool of base.pools) {
      if (pool.family !== family) continue;
      bases.add(base.airportIcao);

      const row = byRank.get(pool.rank) ?? {
        rank: pool.rank,
        headcount: 0,
        available: 0,
        inTraining: 0,
        onDuty: 0,
        reserve: 0,
        required: null,
        delta: null,
      };
      row.headcount += pool.headcount;
      row.available += pool.available;
      row.inTraining += pool.unavailable;
      row.onDuty += pool.onDuty;
      row.reserve += pool.reserve;
      byRank.set(pool.rank, row);
    }
  }

  // The demand fold's figures, joined in rather than recomputed.
  for (const demand of crew.demand.rows) {
    if (demand.family !== family) continue;
    const row = byRank.get(demand.rank) ?? {
      rank: demand.rank,
      headcount: 0,
      available: 0,
      inTraining: 0,
      onDuty: 0,
      reserve: 0,
      required: null,
      delta: null,
    };
    row.required = demand.required;
    row.delta = demand.delta;
    byRank.set(demand.rank, row);
  }

  const rows = [...byRank.values()]
    .filter((row) => row.headcount > 0 || (row.required ?? 0) > 0)
    .sort((a, b) => rankOrder(a.rank) - rankOrder(b.rank));

  return {
    family,
    rows,
    bases: [...bases].sort((a, b) => a.localeCompare(b)),
    totals: {
      headcount: rows.reduce((n, row) => n + row.headcount, 0),
      available: rows.reduce((n, row) => n + row.available, 0),
      inTraining: rows.reduce((n, row) => n + row.inTraining, 0),
      onDuty: rows.reduce((n, row) => n + row.onDuty, 0),
      reserve: rows.reduce((n, row) => n + row.reserve, 0),
      required: rows.reduce((n, row) => n + (row.required ?? 0), 0),
    },
    short: rows.some((row) => (row.delta ?? 0) < 0),
  };
}
