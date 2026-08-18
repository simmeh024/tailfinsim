import { type ReferenceLists } from './reference';

/**
 * Assigning tiers (M1-02, App. B.3).
 *
 * A pure function of one airport's facts, so the whole classification is
 * reproducible, testable without a database, and explainable per airport.
 *
 * ## The ladder, and why the numbers are what they are
 *
 * Rules fire in order; the first match wins.
 *
 *   1. **flagship / large** — seeded from the reference list. Not derivable:
 *      see `reference.ts`.
 *   2. **regional** — short runway, unknown runway, or an upstream `type` that
 *      already says "this is small". B.3 describes the tier as islands, remote
 *      fields and turboprop-only strips.
 *   3. **medium** — a real jet airport with more than one strip.
 *   4. **small** — everything else with scheduled service.
 *
 * The two thresholds were **calibrated against the imported dataset**, not
 * guessed: several ladders were measured against the 4,359 scheduled-service
 * airports and this is the one that lands every tier inside B.3's counts. The
 * measured result is in `tier.test.ts` as a distribution assertion, so a change
 * to either number fails loudly rather than quietly reshaping the world.
 *
 *   tier      computed   B.3 target
 *   flagship        25           25
 *   large          116          120
 *   medium         488          500
 *   small        1,343        1,200
 *   regional     2,387        2,200
 *
 * 7,500 ft is also roughly where a loaded narrowbody stops being payload-limited
 * on a warm day, so the regional line is a physical one as well as a fitted one.
 * 8,000 ft with two runways is a plausible floor for somewhere that handles
 * simultaneous jet movements.
 */

export const REGIONAL_MAX_RUNWAY_FT = 7_500;
export const MEDIUM_MIN_RUNWAY_FT = 8_000;
export const MEDIUM_MIN_RUNWAYS = 2;

export type AirportTier = 'flagship' | 'large' | 'medium' | 'small' | 'regional';

/** Upstream types that are never more than regional, whatever their tarmac. */
const ALWAYS_REGIONAL_KINDS = new Set(['small_airport', 'heliport', 'seaplane_base']);

export interface ClassifiableAirport {
  ident: string;
  iataCode: string | null;
  isoCountry: string;
  kind: string;
  scheduledService: boolean;
  /** Longest **open** runway. Closed strips cannot be planned onto. */
  longestRunwayFt: number | null;
  /** Count of open runways. */
  openRunways: number;
}

export interface Classification {
  tier: AirportTier | null;
  slotLevel: number | null;
  /** The audit trail M1-02 requires — the rule that fired and what it fired on. */
  basis: {
    rule: string;
    longestRunwayFt: number | null;
    openRunways: number;
    kind: string;
    seeded: boolean;
    slotRule: string;
  };
}

/**
 * Slot level from tier, per B.3's own mapping.
 *
 * `null` means no coordination at all, which is where regional sits.
 */
function slotLevelForTier(tier: AirportTier): number | null {
  switch (tier) {
    case 'flagship':
    case 'large':
      return 3;
    case 'medium':
      return 2;
    case 'small':
      return 1;
    case 'regional':
      return null;
  }
}

export function classifyAirport(
  airport: ClassifiableAirport,
  reference: ReferenceLists,
): Classification {
  const { kind, longestRunwayFt, openRunways, iataCode } = airport;

  // No scheduled service, no demand pool, no tier. B.3's five counts sum to
  // ~4,045 — the playable subset, not all 86,000 aerodromes.
  if (!airport.scheduledService || kind === 'closed') {
    return {
      tier: null,
      slotLevel: null,
      basis: {
        rule: 'no scheduled service',
        longestRunwayFt,
        openRunways,
        kind,
        seeded: false,
        slotRule: 'no tier',
      },
    };
  }

  const seeded = iataCode === null ? undefined : reference.tiers.get(iataCode);

  let tier: AirportTier;
  let rule: string;

  if (seeded !== undefined) {
    tier = seeded;
    rule = `seeded ${seeded} from airport-tiers.csv`;
  } else if (ALWAYS_REGIONAL_KINDS.has(kind)) {
    tier = 'regional';
    rule = `upstream kind ${kind}`;
  } else if (longestRunwayFt === null || longestRunwayFt < REGIONAL_MAX_RUNWAY_FT) {
    tier = 'regional';
    rule =
      longestRunwayFt === null
        ? 'no open runway of known length'
        : `longest open runway ${String(longestRunwayFt)} ft < ${String(REGIONAL_MAX_RUNWAY_FT)}`;
  } else if (longestRunwayFt >= MEDIUM_MIN_RUNWAY_FT && openRunways >= MEDIUM_MIN_RUNWAYS) {
    tier = 'medium';
    rule = `${String(longestRunwayFt)} ft and ${String(openRunways)} open runways`;
  } else {
    tier = 'small';
    rule = `${String(longestRunwayFt)} ft, ${String(openRunways)} open runway(s)`;
  }

  // The slot override exists mainly for the United States, which does not run
  // IATA Level 3 coordination at most of its airports — see slot-levels.csv.
  const override = iataCode === null ? undefined : reference.slotLevels.get(iataCode);
  const slotLevel = override ?? slotLevelForTier(tier);
  const slotRule =
    override === undefined ? `derived from tier ${tier}` : 'slot-levels.csv override';

  return {
    tier,
    slotLevel,
    basis: { rule, longestRunwayFt, openRunways, kind, seeded: seeded !== undefined, slotRule },
  };
}
