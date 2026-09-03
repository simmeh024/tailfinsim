/**
 * The cabin's numbers (§6.1, §6.4) — pure, deterministic, tested.
 *
 * Every readout on screen comes from here: the live summary, the constraint
 * panel, the centre-of-gravity bar. Keeping it a pure module means the same
 * config always yields the same figures and the tests can assert the trade §6.4
 * describes — more seats up, comfort and range down — without a DOM.
 *
 * The formulas are decision-support stand-ins, not the economy config: they are
 * internally consistent (the summary can never claim a seat the rows do not hold)
 * and directionally honest (a heavier, fuller cabin flies less far), which is
 * what a player needs while dragging a row around. The authoritative economy
 * lives in `@tailfin/sim`, which `packages/web` may not import (§21) — so these
 * are the client's own honest mirror, exactly like the route planner's.
 */

import { MONUMENT_SPECS, seatProduct, seatsInLayout } from './catalogue';
import { isSeatRow } from './types';

import type { CabinClass, CabinConfig, CabinElement, CabinFrame, SeatRow } from './types';

/** Assumed passenger + bag mass per occupied seat, kg. */
const PAX_KG = 95;
/** One galley (or lounge) is expected to serve at most this many seats. */
const SEATS_PER_GALLEY = 80;
/** One lavatory is expected to serve at most this many seats. */
const SEATS_PER_LAV = 60;
/** Hard floor for any exit-row seat pitch, inches (§6.1). */
export const EXIT_ROW_MIN_PITCH_IN = 30;

export function rowSeatCount(row: SeatRow): number {
  return seatsInLayout(row.seatLayout);
}

/** Floor length an element occupies, metres. */
export function elementLengthM(element: CabinElement): number {
  if (isSeatRow(element)) return element.pitchIn * 0.0254;
  return MONUMENT_SPECS[element.kind].lengthM;
}

/** Installed weight of an element (fixtures only, no passengers), kg. */
function elementWeightKg(element: CabinElement): number {
  if (!isSeatRow(element)) return MONUMENT_SPECS[element.kind].weightKg;
  const product = seatProduct(element.productId);
  return rowSeatCount(element) * (product?.weightKgPerSeat ?? 12);
}

export interface ClassBreakdown {
  cabinClass: CabinClass;
  seats: number;
  share: number;
}

export interface CabinSummary {
  totalSeats: number;
  byClass: ClassBreakdown[];
  crewRecommended: number;
  cabinWeightKg: number;
  configCostUsd: number;
  turnaroundMin: number;
  rangeNm: number;
  /** 0–100, the seat-comfort part of §6.4's product score. */
  productScore: number;
  usedLengthM: number;
  seatsVsStandard: number;
  weightVsStandardKg: number;
  turnaroundVsStandardMin: number;
  rangeVsStandardNm: number;
}

const CLASS_ORDER: readonly CabinClass[] = ['first', 'business', 'premium', 'comfort', 'economy'];
/** Cabin crew one seat of each class is expected to share. */
const SERVICE_DIVISOR: Record<CabinClass, number> = {
  first: 8,
  business: 14,
  premium: 28,
  comfort: 36,
  economy: 50,
};

export function summarise(config: CabinConfig, frame: CabinFrame): CabinSummary {
  const seatsByClass = new Map<CabinClass, number>();
  let totalSeats = 0;
  let comfortWeighted = 0;
  let cabinWeightKg = 0;
  let configCostUsd = 0;
  let usedLengthM = 0;

  for (const element of config.elements) {
    cabinWeightKg += elementWeightKg(element);
    usedLengthM += elementLengthM(element);
    if (isSeatRow(element)) {
      const seats = rowSeatCount(element);
      const product = seatProduct(element.productId);
      totalSeats += seats;
      comfortWeighted += seats * (product?.comfort ?? 3);
      configCostUsd += seats * (product?.unitCostUsd ?? 3000);
      seatsByClass.set(element.cabinClass, (seatsByClass.get(element.cabinClass) ?? 0) + seats);
    } else {
      configCostUsd += MONUMENT_SPECS[element.kind].costUsd;
    }
  }

  const byClass: ClassBreakdown[] = CLASS_ORDER.filter((cabinClass) =>
    seatsByClass.has(cabinClass),
  ).map((cabinClass) => {
    const seats = seatsByClass.get(cabinClass) ?? 0;
    return { cabinClass, seats, share: totalSeats === 0 ? 0 : seats / totalSeats };
  });

  // Crew: the greater of the safety floor and the sum of each class's service need.
  const safetyCrew = Math.ceil(totalSeats / 50);
  const serviceCrew = [...seatsByClass.entries()].reduce(
    (sum, [cabinClass, seats]) => sum + Math.ceil(seats / SERVICE_DIVISOR[cabinClass]),
    0,
  );
  const crewRecommended = Math.max(safetyCrew, serviceCrew, totalSeats > 0 ? 1 : 0);

  // Turnaround eases off the type's standard by seat count and monument service.
  const monumentTurn = config.elements.reduce(
    (sum, element) =>
      isSeatRow(element) ? sum : sum + MONUMENT_SPECS[element.kind].turnaroundDeltaMin,
    0,
  );
  const premiumSeats = (seatsByClass.get('first') ?? 0) + (seatsByClass.get('business') ?? 0);
  const turnaroundMin = Math.round(
    frame.standard.turnaroundMin +
      (totalSeats - frame.standard.seats) * 0.05 +
      monumentTurn +
      premiumSeats * 0.06,
  );

  // Range falls as the cabin (fixtures + passengers) grows heavier — a crude but
  // monotonic stand-in for the payload/range curve. Inverse to total mass.
  const standardMass = frame.standard.cabinWeightKg + frame.standard.seats * PAX_KG;
  const actualMass = cabinWeightKg + totalSeats * PAX_KG;
  const rangeNm = Math.round((frame.standard.rangeNm * standardMass) / Math.max(actualMass, 1));

  const productScore = totalSeats === 0 ? 0 : Math.round((comfortWeighted / totalSeats / 5) * 100);

  return {
    totalSeats,
    byClass,
    crewRecommended,
    cabinWeightKg,
    configCostUsd,
    turnaroundMin,
    rangeNm,
    productScore,
    usedLengthM,
    seatsVsStandard: totalSeats - frame.standard.seats,
    weightVsStandardKg: cabinWeightKg - frame.standard.cabinWeightKg,
    turnaroundVsStandardMin: turnaroundMin - frame.standard.turnaroundMin,
    rangeVsStandardNm: rangeNm - frame.standard.rangeNm,
  };
}

export interface CgEstimate {
  mac: number;
  minMac: number;
  maxMac: number;
  withinLimits: boolean;
}

/**
 * A longitudinal CG estimate, in %MAC.
 *
 * Elements are laid nose-to-tail; each contributes its fixtures-plus-passengers
 * mass at its own centre. The mass-weighted mean position, relative to the cabin
 * mid-point, shifts the empty-cabin MAC across most of the envelope — so loading
 * the front (a first cabin) pulls CG forward and a rear galley bank pushes it aft,
 * which is exactly the feedback the constraint is there to give.
 */
export function estimateCg(config: CabinConfig, frame: CabinFrame): CgEstimate {
  const mid = frame.cabinLengthM / 2;
  let cursor = 0;
  let massMoment = 0;
  let massTotal = 0;

  for (const element of config.elements) {
    const length = elementLengthM(element);
    const centre = cursor + length / 2;
    cursor += length;
    const paxMass = isSeatRow(element) ? rowSeatCount(element) * PAX_KG : 0;
    const mass = elementWeightKg(element) + paxMass;
    massMoment += mass * centre;
    massTotal += mass;
  }

  const meanPos = massTotal === 0 ? mid : massMoment / massTotal;
  const span = (frame.cg.maxMac - frame.cg.minMac) * 0.9;
  const raw = frame.cg.emptyMac + ((meanPos - mid) / frame.cabinLengthM) * span;
  const mac = Math.round(raw * 10) / 10;

  return {
    mac,
    minMac: frame.cg.minMac,
    maxMac: frame.cg.maxMac,
    withinLimits: mac >= frame.cg.minMac && mac <= frame.cg.maxMac,
  };
}

export type ConstraintStatus = 'ok' | 'warn' | 'error';

export interface Constraint {
  id: string;
  label: string;
  status: ConstraintStatus;
  detail: string;
}

/** Galleys and lavatories, counting a lounge as a galley (§6.3). */
export function serviceCounts(config: CabinConfig): { galleys: number; lavatories: number } {
  return config.elements.reduce(
    (counts, element) => {
      if (isSeatRow(element)) return counts;
      const spec = MONUMENT_SPECS[element.kind];
      return {
        galleys: counts.galleys + spec.counts.galley,
        lavatories: counts.lavatories + spec.counts.lavatory,
      };
    },
    { galleys: 0, lavatories: 0 },
  );
}

/**
 * Every §6.1 hard/soft constraint, evaluated. A hard breach is `error` (illegal
 * to fly); a soft one at its floor is `warn` (legal, but the mockup's amber dot).
 */
export function evaluateConstraints(config: CabinConfig, frame: CabinFrame): Constraint[] {
  const summary = summarise(config, frame);
  const cg = estimateCg(config, frame);
  const { galleys, lavatories } = serviceCounts(config);
  const exitRows = config.elements.filter((element) => isSeatRow(element) && element.isExitRow);
  const badExit = exitRows.filter(
    (row) => isSeatRow(row) && row.pitchIn < EXIT_ROW_MIN_PITCH_IN,
  ).length;

  const requiredGalleys =
    summary.totalSeats === 0 ? 0 : Math.ceil(summary.totalSeats / SEATS_PER_GALLEY);
  const requiredLav = summary.totalSeats === 0 ? 0 : Math.ceil(summary.totalSeats / SEATS_PER_LAV);
  const premiumSeats = summary.byClass
    .filter((row) => row.cabinClass === 'first' || row.cabinClass === 'business')
    .reduce((sum, row) => sum + row.seats, 0);

  const constraints: Constraint[] = [
    {
      id: 'max-seats',
      label: 'Certified seat limit',
      status: summary.totalSeats > frame.certifiedMaxSeats ? 'error' : 'ok',
      detail:
        summary.totalSeats > frame.certifiedMaxSeats
          ? `${String(summary.totalSeats)} seats exceeds the certified ${String(frame.certifiedMaxSeats)}`
          : `${String(summary.totalSeats)} of ${String(frame.certifiedMaxSeats)} certified`,
    },
    {
      id: 'exit-clearance',
      label: 'Exit clearance',
      status: exitRows.length === 0 ? 'warn' : badExit > 0 ? 'error' : 'ok',
      detail:
        exitRows.length === 0
          ? 'No exit row is marked'
          : badExit > 0
            ? `${String(badExit)} exit row below ${String(EXIT_ROW_MIN_PITCH_IN)} in pitch`
            : `${String(exitRows.length)} exit rows clear at ≥ ${String(EXIT_ROW_MIN_PITCH_IN)} in`,
    },
    {
      id: 'galley-minimum',
      label: 'Galley minimum',
      status: galleys < requiredGalleys ? 'error' : galleys === requiredGalleys ? 'warn' : 'ok',
      detail:
        galleys < requiredGalleys
          ? `${String(galleys)} galleys, ${String(requiredGalleys)} required`
          : galleys === requiredGalleys
            ? 'At minimum — consider one more'
            : `${String(galleys)} galleys for ${String(summary.totalSeats)} seats`,
    },
    {
      id: 'lavatory-minimum',
      label: 'Lavatory minimum',
      status: lavatories < requiredLav ? 'error' : lavatories === requiredLav ? 'warn' : 'ok',
      detail:
        lavatories < requiredLav
          ? `${String(lavatories)} lavatories, ${String(requiredLav)} required`
          : `${String(lavatories)} lavatories for ${String(summary.totalSeats)} seats`,
    },
    {
      id: 'premium-service',
      label: 'Premium service load',
      status: premiumSeats > 0 && galleys > 0 && premiumSeats / galleys > 40 ? 'warn' : 'ok',
      detail:
        premiumSeats > 0 && galleys > 0 && premiumSeats / galleys > 40
          ? 'Premium cabins may need more galley support'
          : 'Service load within range',
    },
    {
      id: 'cabin-length',
      label: 'Cabin length',
      status: summary.usedLengthM > frame.cabinLengthM ? 'error' : 'ok',
      detail:
        summary.usedLengthM > frame.cabinLengthM
          ? `Fitted ${summary.usedLengthM.toFixed(1)} m over ${String(frame.cabinLengthM)} m usable`
          : `${summary.usedLengthM.toFixed(1)} m of ${String(frame.cabinLengthM)} m used`,
    },
    {
      id: 'balance',
      label: 'Weight & balance',
      status: cg.withinLimits ? 'ok' : 'error',
      detail: cg.withinLimits
        ? `${cg.mac.toFixed(1)}% MAC, within ${String(cg.minMac)}–${String(cg.maxMac)}%`
        : `${cg.mac.toFixed(1)}% MAC is outside ${String(cg.minMac)}–${String(cg.maxMac)}%`,
    },
  ];

  return constraints;
}

/** The worst status across a set of constraints — the header badge's colour. */
export function worstStatus(constraints: readonly Constraint[]): ConstraintStatus {
  if (constraints.some((constraint) => constraint.status === 'error')) return 'error';
  if (constraints.some((constraint) => constraint.status === 'warn')) return 'warn';
  return 'ok';
}
