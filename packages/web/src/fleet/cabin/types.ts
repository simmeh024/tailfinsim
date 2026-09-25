/**
 * View-model types for the cabin configurator (M6-08, §6.1).
 *
 * §6's cabin builder has **no server endpoints yet** — nothing writes
 * `airframe.cabin_config_id` (see `@tailfin/shared`'s `AirframeDetailResponse`).
 * So, exactly like the route planner (`network/planner/types.ts`), these types
 * describe the shape a future `CabinConfig` payload would take and everything on
 * screen is computed from a client-side model seeded by `presets.ts`. When the
 * backend arrives, swapping the seed for a `fetch` is a data-source change, not a
 * component rewrite.
 *
 * The unit of the model is the **element**: an ordered list of seat rows and
 * cabin monuments (galleys, lavatories, dividers …) laid nose-to-tail. Class
 * *sections* — "Business, rows 1–3" in the mockup — are **derived** by grouping
 * consecutive seat rows of one class, never stored, so changing a row's class
 * re-groups the cabin with no bookkeeping. Row numbers are likewise derived:
 * monuments do not take one.
 */

import type { Planform } from './planform';

/** The five cabin classes, cheapest-last-forward per §6.2. */
export type CabinClass = 'first' | 'business' | 'premium' | 'comfort' | 'economy';

export const CABIN_CLASSES: readonly CabinClass[] = [
  'first',
  'business',
  'premium',
  'comfort',
  'economy',
];

/** Display label and the single-letter code the summary chips use (F/J/W/Y). */
export const CABIN_CLASS_META: Record<CabinClass, { label: string; code: string }> = {
  first: { label: 'First', code: 'F' },
  business: { label: 'Business', code: 'J' },
  premium: { label: 'Premium Economy', code: 'W' },
  comfort: { label: 'Comfort Economy', code: 'C' },
  economy: { label: 'Economy', code: 'Y' },
};

/** The insertable monument kinds — the left rail's MODULES, minus Seats. */
export type MonumentKind = 'galley' | 'lavatory' | 'closet' | 'divider' | 'lounge';

export const MONUMENT_KINDS: readonly MonumentKind[] = [
  'galley',
  'lavatory',
  'closet',
  'divider',
  'lounge',
];

/** A row of seats — the thing that carries a class, a product and a row number. */
export interface SeatRow {
  kind: 'seats';
  id: string;
  cabinClass: CabinClass;
  /** Which seat product is fitted; keys `SEAT_PRODUCTS`. */
  productId: string;
  /**
   * Aisle layout as text, e.g. `3-3`, `1-2-1`. The sum of the groups is the
   * seat count of the row, so the model keeps the string and derives the number.
   */
  seatLayout: string;
  /** Seat pitch in inches. Defaults from the product; the inspector may override. */
  pitchIn: number;
  /** An exit row carries a hard minimum pitch and a clear-access constraint. */
  isExitRow: boolean;
}

/** A non-seating cabin monument occupying floor length. */
export interface Monument {
  kind: MonumentKind;
  id: string;
}

export type CabinElement = SeatRow | Monument;

export function isSeatRow(element: CabinElement): element is SeatRow {
  return element.kind === 'seats';
}

/** The editable cabin document. */
export interface CabinConfig {
  typeDesignation: string;
  /** Monotonic; the header's "Current configuration · v3". Bumped on save. */
  version: number;
  elements: CabinElement[];
}

/** An aisle layout: groups of seats between aisles, `3-3`, `1-2-1`. */
const SEAT_LAYOUT = /^\d+(-\d+)*$/;

function isCabinElement(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const element = value as Record<string, unknown>;
  if (typeof element.id !== 'string' || element.id === '') return false;
  if (element.kind !== 'seats') return MONUMENT_KINDS.includes(element.kind as MonumentKind);
  return (
    CABIN_CLASSES.includes(element.cabinClass as CabinClass) &&
    typeof element.productId === 'string' &&
    typeof element.seatLayout === 'string' &&
    SEAT_LAYOUT.test(element.seatLayout) &&
    typeof element.pitchIn === 'number' &&
    Number.isFinite(element.pitchIn) &&
    element.pitchIn > 0 &&
    typeof element.isExitRow === 'boolean'
  );
}

/**
 * Whether stored JSON is a cabin this build can draw.
 *
 * A draft lives in `localStorage` across deploys — including a preview branch's
 * that knew a monument or class this build does not — and the page indexes its
 * tables by `kind` and `cabinClass` and splits `seatLayout` unguarded. One
 * unknown value therefore threw during render; with no error boundary that
 * blanked the whole app, and because the draft stayed stored, on every visit.
 */
export function isCabinConfig(value: unknown): value is CabinConfig {
  if (typeof value !== 'object' || value === null) return false;
  const config = value as Record<string, unknown>;
  if (typeof config.typeDesignation !== 'string') return false;
  if (typeof config.version !== 'number' || !Number.isFinite(config.version)) return false;
  return Array.isArray(config.elements) && config.elements.every(isCabinElement);
}

/**
 * The immutable facts about the airframe the cabin is fitted to. Supplied by the
 * preset (a stand-in for the type spec + catalogue) and never edited here.
 */
export interface CabinFrame {
  typeDesignation: string;
  label: string;
  family: string;
  /** The type's certified seat ceiling (§6.1's hard constraint). */
  certifiedMaxSeats: number;
  /** Usable cabin length, in metres, for laying elements and the length check. */
  cabinLengthM: number;
  /** Whether the ruler and dimensions read in metres or feet (ATR uses feet). */
  lengthUnit: 'm' | 'ft';
  /** Seats abreast the widest economy layout supports — sizes the drawing. */
  maxAbreast: number;
  /** Baselines the summary compares against ("vs standard layout"). */
  standard: {
    seats: number;
    rangeNm: number;
    turnaroundMin: number;
    /** Cabin weight of the type's standard fit, kg — the range/CG datum. */
    cabinWeightKg: number;
  };
  /** Centre-of-gravity envelope, in %MAC. */
  cg: { minMac: number; maxMac: number; emptyMac: number };
  /** The top-down silhouette drawn behind the cabin. Defaulted from cabin width
   *  when absent, so every type has a plane without per-type data. */
  planform?: Planform;
}
