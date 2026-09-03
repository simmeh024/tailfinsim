/**
 * The seat-product and monument catalogue (§6.2, §6.3).
 *
 * Every product carries the six numbers §6.2 requires — pitch, width, weight,
 * unit cost, comfort, recline — plus which classes and layouts it is legal in.
 * These are the client's mirror of what the economy config and product catalogue
 * will one day supply; they live here as constants for the same reason the route
 * planner's stand-in numbers do, and are the single place a figure is authored so
 * the analysis and the inspector never disagree.
 *
 * No colour literals: the class accent comes from `theme/tokens.css` via
 * `CABIN_CLASS_ACCENT`, which is a CSS-variable name, not a value.
 */

import type { CabinClass, MonumentKind } from './types';

export interface SeatProduct {
  id: string;
  label: string;
  classes: readonly CabinClass[];
  /** Default seat pitch in inches; a row may override within limits. */
  pitchIn: number;
  /** Seat width in inches. */
  widthIn: number;
  /** Recline travel in inches (a flat bed reads its bed length elsewhere). */
  reclineIn: number;
  /** Installed weight per seat, kg. */
  weightKgPerSeat: number;
  /** One-time fit cost per seat, USD. */
  unitCostUsd: number;
  /** Comfort score 1–5, feeding §6.4's product score. */
  comfort: number;
  /** Aisle layouts this product is offered in. */
  layouts: readonly string[];
}

export const SEAT_PRODUCTS: readonly SeatProduct[] = [
  // Economy
  {
    id: 'eco-slimline',
    label: 'Slimline high-density',
    classes: ['economy'],
    pitchIn: 28,
    widthIn: 17,
    reclineIn: 2,
    weightKgPerSeat: 9,
    unitCostUsd: 2200,
    comfort: 2,
    layouts: ['3-3', '2-2', '3-3-3', '2-4-2'],
  },
  {
    id: 'eco-standard',
    label: 'Standard economy',
    classes: ['economy'],
    pitchIn: 31,
    widthIn: 17.3,
    reclineIn: 3,
    weightKgPerSeat: 11,
    unitCostUsd: 3100,
    comfort: 3,
    layouts: ['3-3', '2-2', '3-3-3', '2-4-2'],
  },
  {
    id: 'eco-extra',
    label: 'Extra-legroom economy',
    classes: ['economy', 'comfort'],
    pitchIn: 34,
    widthIn: 17.5,
    reclineIn: 4,
    weightKgPerSeat: 12,
    unitCostUsd: 3800,
    comfort: 3.5,
    layouts: ['3-3', '2-2', '3-3-3', '2-4-2'],
  },
  // Comfort / premium economy
  {
    id: 'pe-recliner',
    label: 'Premium recliner',
    classes: ['comfort', 'premium'],
    pitchIn: 38,
    widthIn: 18.5,
    reclineIn: 6,
    weightKgPerSeat: 18,
    unitCostUsd: 9500,
    comfort: 4,
    layouts: ['3-3', '2-2', '2-3-2', '2-4-2'],
  },
  {
    id: 'pe-wide',
    label: 'Wide recliner',
    classes: ['premium'],
    pitchIn: 40,
    widthIn: 19.5,
    reclineIn: 8,
    weightKgPerSeat: 22,
    unitCostUsd: 12500,
    comfort: 4.3,
    layouts: ['2-3-2', '2-4-2'],
  },
  // Business
  {
    id: 'biz-angled',
    label: 'Angled lie-flat',
    classes: ['business'],
    pitchIn: 46,
    widthIn: 20,
    reclineIn: 60,
    weightKgPerSeat: 55,
    unitCostUsd: 45000,
    comfort: 4,
    layouts: ['2-2', '2-2-2'],
  },
  {
    id: 'biz-flat-222',
    label: 'Full-flat 2-2-2',
    classes: ['business'],
    pitchIn: 52,
    widthIn: 21,
    reclineIn: 76,
    weightKgPerSeat: 78,
    unitCostUsd: 78000,
    comfort: 4.4,
    layouts: ['2-2-2', '2-2'],
  },
  {
    id: 'biz-flat-121',
    label: 'Full-flat 1-2-1 direct aisle',
    classes: ['business'],
    pitchIn: 44,
    widthIn: 22,
    reclineIn: 78,
    weightKgPerSeat: 92,
    unitCostUsd: 118000,
    comfort: 4.7,
    layouts: ['1-2-1'],
  },
  {
    id: 'biz-herringbone',
    label: 'Reverse herringbone',
    classes: ['business'],
    pitchIn: 45,
    widthIn: 22,
    reclineIn: 79,
    weightKgPerSeat: 98,
    unitCostUsd: 132000,
    comfort: 4.9,
    layouts: ['1-2-1'],
  },
  // First
  {
    id: 'first-suite',
    label: 'Enclosed suite',
    classes: ['first'],
    pitchIn: 82,
    widthIn: 24,
    reclineIn: 80,
    weightKgPerSeat: 260,
    unitCostUsd: 340000,
    comfort: 4.9,
    layouts: ['1-2-1', '1-1'],
  },
  {
    id: 'first-suite-door',
    label: 'Suite with door',
    classes: ['first'],
    pitchIn: 115,
    widthIn: 25,
    reclineIn: 82,
    weightKgPerSeat: 480,
    unitCostUsd: 420000,
    comfort: 5,
    layouts: ['1-2-1', '1-1'],
  },
];

export function seatProduct(id: string): SeatProduct | undefined {
  return SEAT_PRODUCTS.find((product) => product.id === id);
}

export function productsForClass(cabinClass: CabinClass): readonly SeatProduct[] {
  return SEAT_PRODUCTS.filter((product) => product.classes.includes(cabinClass));
}

/** Seats in a layout string like `3-3` or `1-2-1`. */
export function seatsInLayout(layout: string): number {
  return layout
    .split('-')
    .map((group) => Number.parseInt(group, 10))
    .filter((value) => Number.isFinite(value))
    .reduce((sum, value) => sum + value, 0);
}

export interface MonumentSpec {
  kind: MonumentKind;
  label: string;
  /** Floor length consumed, metres. A divider is a thin partition. */
  lengthM: number;
  weightKg: number;
  costUsd: number;
  /** Minutes this monument adds to (or removes from) turnaround. */
  turnaroundDeltaMin: number;
  /** A galley/lounge counts toward the service minimums; a divider does not. */
  counts: { galley: number; lavatory: number };
}

export const MONUMENT_SPECS: Record<MonumentKind, MonumentSpec> = {
  galley: {
    kind: 'galley',
    label: 'Galley',
    lengthM: 0.9,
    weightKg: 420,
    costUsd: 180000,
    turnaroundDeltaMin: 1.5,
    counts: { galley: 1, lavatory: 0 },
  },
  lavatory: {
    kind: 'lavatory',
    label: 'Lavatory',
    lengthM: 1.0,
    weightKg: 180,
    costUsd: 60000,
    turnaroundDeltaMin: 0,
    counts: { galley: 0, lavatory: 1 },
  },
  closet: {
    kind: 'closet',
    label: 'Closet',
    lengthM: 0.5,
    weightKg: 70,
    costUsd: 22000,
    turnaroundDeltaMin: 0,
    counts: { galley: 0, lavatory: 0 },
  },
  divider: {
    kind: 'divider',
    label: 'Divider',
    lengthM: 0.15,
    weightKg: 40,
    costUsd: 9000,
    turnaroundDeltaMin: 0,
    counts: { galley: 0, lavatory: 0 },
  },
  lounge: {
    kind: 'lounge',
    label: 'Lounge',
    lengthM: 3.4,
    weightKg: 1600,
    costUsd: 1250000,
    turnaroundDeltaMin: 2.5,
    counts: { galley: 1, lavatory: 0 },
  },
};

/** CSS-variable name for a class accent — a token reference, never a colour. */
export const CABIN_CLASS_ACCENT: Record<CabinClass, string> = {
  first: 'var(--cabin-first)',
  business: 'var(--cabin-business)',
  premium: 'var(--cabin-premium)',
  comfort: 'var(--cabin-comfort)',
  economy: 'var(--cabin-economy)',
};
