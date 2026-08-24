import {
  type AircraftAcquisitionMethod,
  type AircraftEraDates,
  type AircraftRestriction,
  ECONOMY_CONFIG_V1,
  type EconomyConfig,
} from '@tailfin/shared';

/**
 * Whether a type exists yet, and what may be done with it (M4-01, §7.2b).
 *
 * §7.2b is unambiguous about the strength of this:
 *
 * > *"An aircraft simply **does not exist** in a world whose clock hasn't
 * > reached it."*
 *
 * Not "is hidden", not "is greyed out" — does not exist. That is why this
 * returns a state rather than a boolean: the four era dates carve the timeline
 * into five spans, and each one means something different to a player.
 *
 * ## The five states
 *
 * | State | Between | What a player can do |
 * |---|---|---|
 * | `unannounced` | before `first_flight` | nothing; the type is not in the world |
 * | `prototype` | first flight → EIS | see it; §7.2c's launch-customer play, Post-MVP |
 * | `orderable` | EIS → production end | order new, lease, buy used |
 * | `used_only` | after production end | lease or buy used; no new-build |
 * | `retired` | after `out_of_service` | nothing; may not be operated at all |
 *
 * ## Why this is a pure function of dates
 *
 * It takes the era dates and an instant, and nothing else. No world, no
 * database, no player. That keeps §7.2b's promise cheap to honour everywhere —
 * the used market (M4-05), the order flow (M4-04) and the fleet list (M4-07)
 * all ask the same question of the same function and cannot disagree.
 *
 * M4-02 owns *applying* this across the game. M4-01 owns the rule.
 */

export type AircraftAvailability =
  'unannounced' | 'prototype' | 'orderable' | 'used_only' | 'retired';

/** Every state, in timeline order — for display, and so a test can prove each is reachable. */
export const AIRCRAFT_AVAILABILITY_STATES: readonly AircraftAvailability[] = [
  'unannounced',
  'prototype',
  'orderable',
  'used_only',
  'retired',
];

/**
 * Dates in the catalogue are calendar days, and the clock is an instant.
 *
 * Compared as UTC days rather than as instants: an aircraft entering service on
 * 11 November is available on 11 November, not from midnight UTC of a day that
 * is already the 11th somewhere. The game's calendar is the world's, and the
 * world's is UTC (`world.epoch` is `timestamptz`).
 */
function onOrAfter(date: string | null, at: Date): boolean {
  if (date === null) return false;
  return at.getTime() >= Date.parse(`${date}T00:00:00.000Z`);
}

/**
 * What a world's clock says about this type.
 *
 * Evaluated newest-first, because the states are cumulative: a retired type is
 * also past its production end and its EIS, and only the last gate reached is
 * the answer.
 */
export function availabilityOf(era: AircraftEraDates, at: Date): AircraftAvailability {
  if (onOrAfter(era.outOfService, at)) return 'retired';
  if (onOrAfter(era.productionEnd, at)) return 'used_only';
  if (onOrAfter(era.entryIntoService, at)) return 'orderable';
  if (onOrAfter(era.firstFlight, at)) return 'prototype';
  return 'unannounced';
}

/**
 * Commercial paths a type may expose in this era.
 *
 * This is shared by the catalogue projection and acquisition enforcement so a
 * client never has to translate an availability label back into permissions.
 * Used means the type may participate; a physical, live listing is still
 * required for an actual purchase.
 */
export function aircraftAcquisitionMethods(
  availability: AircraftAvailability,
  terms: { listPrice: number | null; monthlyLeaseRate: number | null },
): readonly AircraftAcquisitionMethod[] {
  if (availability !== 'orderable' && availability !== 'used_only') return [];

  const methods: AircraftAcquisitionMethod[] = [];
  if (availability === 'orderable' && terms.listPrice !== null) methods.push('new');
  if (terms.monthlyLeaseRate !== null) methods.push('lease');
  methods.push('used');
  return methods;
}

/**
 * Whether a *new* aircraft of this type may be ordered.
 *
 * Only in `orderable`. A prototype cannot be ordered — that is §7.2c's
 * launch-customer commitment, which is Post-MVP and deliberately not a normal
 * order — and a type past its production end has no factory left to build one.
 */
export function isOrderableNew(era: AircraftEraDates, at: Date): boolean {
  return availabilityOf(era, at) === 'orderable';
}

/**
 * Whether the type may be flown at all.
 *
 * True from first flight until the out-of-service date. A used-only type is
 * perfectly flyable — C.2 has three of them, and "you can still fly it, you
 * just cannot buy a new one" is most of what makes the used market interesting.
 */
export function isOperable(era: AircraftEraDates, at: Date): boolean {
  const state = availabilityOf(era, at);
  return state === 'prototype' || state === 'orderable' || state === 'used_only';
}

/**
 * Whether the type exists in the world at all — §7.2b's literal sense.
 *
 * A type before its first flight is not hidden; it is absent. Nothing should
 * list it, price it or mention it.
 */
export function existsInWorld(era: AircraftEraDates, at: Date): boolean {
  return availabilityOf(era, at) !== 'unannounced';
}

/**
 * The restrictions in force on this type at this date, oldest first.
 *
 * §7.2b's slow squeeze: *"noise regulations, emissions rules, and fuel price
 * shocks progressively strangle old types rather than deleting them. Your
 * beloved fleet becomes uneconomic before it becomes illegal."* Separate from
 * availability because a restricted type is still perfectly legal to operate —
 * it is just worse to own, which is the point.
 */
export function restrictionsInForce(
  era: AircraftEraDates,
  at: Date,
): readonly AircraftRestriction[] {
  return era.restrictionDates
    .filter((restriction) => onOrAfter(restriction.at, at))
    .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
}

// ---------------------------------------------------------------------------
// What a restriction costs (M4-02)
// ---------------------------------------------------------------------------

export type RestrictionBalance = EconomyConfig['costs']['restrictions'];

/**
 * The shipped restriction rates. A slice of the seed, like every other default.
 */
export const DEFAULT_RESTRICTIONS: RestrictionBalance = ECONOMY_CONFIG_V1.costs.restrictions;

/** One restriction, and what it adds to a departure. */
export interface RestrictionCharge {
  kind: AircraftRestriction['kind'];
  /** The date it came into force, so a cost line can say when this started. */
  since: string;
  amountMinor: number;
  /** The server's sentence, so a player is told why they are paying it. */
  note: string;
}

export interface RestrictionCost {
  totalMinor: number;
  /** One line per restriction in force. Empty for an unrestricted type. */
  charges: readonly RestrictionCharge[];
}

/**
 * What flying a restricted type costs, per departure.
 *
 * §7.2b's mechanism, priced. The point is that this is **not** a hard removal:
 * *"Retirement pressure is real too… Your beloved fleet becomes uneconomic
 * before it becomes illegal."* An operator can keep flying a restricted type
 * for as long as the numbers work, and the numbers get worse.
 *
 * Emissions scale with MTOW because a heavier aircraft burns more; noise and
 * curfew charges are per movement because that is what an airport counts.
 *
 * Returns the lines as well as the total, because a cost a player cannot
 * attribute is one they will assume is a bug (invariant 4).
 */
export function restrictionCost(
  era: AircraftEraDates,
  at: Date,
  mtowTonnes: number,
  config: RestrictionBalance = DEFAULT_RESTRICTIONS,
): RestrictionCost {
  const charges: RestrictionCharge[] = [];

  for (const restriction of restrictionsInForce(era, at)) {
    const amountMinor =
      restriction.kind === 'noise_quota'
        ? config.noiseQuotaPerDepartureMinor
        : restriction.kind === 'emissions_charge'
          ? Math.round(config.emissionsChargePerTonneMinor * mtowTonnes)
          : config.curfewExclusionPerDepartureMinor;

    if (amountMinor > 0) {
      charges.push({
        kind: restriction.kind,
        since: restriction.at,
        amountMinor,
        note: restriction.note,
      });
    }
  }

  return {
    totalMinor: charges.reduce((sum, charge) => sum + charge.amountMinor, 0),
    charges,
  };
}
