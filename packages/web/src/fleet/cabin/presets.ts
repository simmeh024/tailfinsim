/**
 * Starting cabins for the three types the mockups show (M6-08).
 *
 * A preset is the stand-in for `GET /api/fleet/cabin/:airframeId` — the frame
 * facts plus a plausible fitted cabin. Each is built by the same small helpers so
 * the ids are deterministic (a row keeps its id across a render, which the React
 * keys and the selection depend on) and the totals are honest: the analysis
 * recomputes everything from these rows, so a preset cannot claim a seat count it
 * does not contain.
 */

import { seatsInLayout } from './catalogue';

import type {
  CabinClass,
  CabinConfig,
  CabinElement,
  CabinFrame,
  MonumentKind,
  SeatRow,
} from './types';

interface RowSpec {
  cabinClass: CabinClass;
  productId: string;
  layout: string;
  pitchIn: number;
  /** How many identical rows to lay. */
  count: number;
  /** Row offsets within this block that are exit rows (0-based). */
  exitAt?: readonly number[];
}

/** A tiny builder so a preset reads as a sequence of blocks and monuments. */
class CabinBuilder {
  private readonly elements: CabinElement[] = [];
  private seq = 0;

  constructor(private readonly type: string) {}

  rows(spec: RowSpec): this {
    const exit = new Set(spec.exitAt ?? []);
    for (let i = 0; i < spec.count; i += 1) {
      const row: SeatRow = {
        kind: 'seats',
        id: `${this.type}-r${String(this.seq)}`,
        cabinClass: spec.cabinClass,
        productId: spec.productId,
        seatLayout: spec.layout,
        pitchIn: spec.pitchIn,
        isExitRow: exit.has(i),
      };
      this.elements.push(row);
      this.seq += 1;
    }
    return this;
  }

  monument(...kinds: readonly MonumentKind[]): this {
    for (const kind of kinds) {
      this.elements.push({ kind, id: `${this.type}-m${String(this.seq)}` });
      this.seq += 1;
    }
    return this;
  }

  build(version: number): CabinConfig {
    return { typeDesignation: this.type, version, elements: this.elements };
  }
}

export interface CabinPreset {
  frame: CabinFrame;
  config: CabinConfig;
}

function a320neo(): CabinPreset {
  const frame: CabinFrame = {
    typeDesignation: 'A320neo',
    label: 'A320neo',
    family: 'A320neo family',
    certifiedMaxSeats: 186,
    cabinLengthM: 34,
    lengthUnit: 'm',
    maxAbreast: 6,
    // A lean all-economy fit is the "standard layout" the summary compares to,
    // so a premium-heavy build reads as heavier and shorter-legged than it.
    standard: { seats: 180, rangeNm: 3400, turnaroundMin: 39, cabinWeightKg: 3800 },
    cg: { minMac: 15, maxMac: 35, emptyMac: 25 },
  };
  const config = new CabinBuilder('A320neo')
    .monument('galley', 'lavatory')
    .rows({ cabinClass: 'business', productId: 'biz-angled', layout: '2-2', pitchIn: 46, count: 3 })
    .monument('galley', 'lavatory')
    .rows({ cabinClass: 'premium', productId: 'pe-recliner', layout: '3-3', pitchIn: 34, count: 4 })
    .rows({
      cabinClass: 'economy',
      productId: 'eco-standard',
      layout: '3-3',
      pitchIn: 31,
      count: 23,
      // Over-wing pair, counted from the first economy row (rows 12–13).
      exitAt: [4, 5],
    })
    .monument('galley', 'lavatory', 'lavatory')
    .build(3);
  return { frame, config };
}

function atr72(): CabinPreset {
  const frame: CabinFrame = {
    typeDesignation: 'ATR 72',
    label: 'ATR 72',
    family: 'ATR 72-600',
    certifiedMaxSeats: 74,
    cabinLengthM: 20,
    lengthUnit: 'ft',
    maxAbreast: 4,
    standard: { seats: 72, rangeNm: 825, turnaroundMin: 27, cabinWeightKg: 1500 },
    cg: { minMac: 20, maxMac: 28, emptyMac: 24 },
  };
  const config = new CabinBuilder('ATR72')
    .monument('galley', 'lavatory')
    .rows({ cabinClass: 'business', productId: 'biz-angled', layout: '2-2', pitchIn: 34, count: 2 })
    .rows({ cabinClass: 'comfort', productId: 'eco-extra', layout: '2-2', pitchIn: 32, count: 4 })
    .rows({
      cabinClass: 'economy',
      productId: 'eco-standard',
      layout: '2-2',
      pitchIn: 30,
      count: 12,
      exitAt: [2],
    })
    .monument('lavatory')
    .build(2);
  return { frame, config };
}

function a350ulr(): CabinPreset {
  const frame: CabinFrame = {
    typeDesignation: 'A350-900ULR',
    label: 'A350-900ULR',
    family: 'A350 XWB',
    certifiedMaxSeats: 325,
    cabinLengthM: 54,
    lengthUnit: 'm',
    maxAbreast: 9,
    standard: { seats: 300, rangeNm: 9700, turnaroundMin: 62, cabinWeightKg: 6300 },
    cg: { minMac: 20, maxMac: 35, emptyMac: 26 },
  };
  const config = new CabinBuilder('A350ULR')
    .monument('galley', 'lavatory', 'lavatory')
    .rows({
      cabinClass: 'first',
      productId: 'first-suite-door',
      layout: '1-2-1',
      pitchIn: 115,
      count: 8,
    })
    .monument('lounge', 'galley')
    .rows({
      cabinClass: 'business',
      productId: 'biz-herringbone',
      layout: '1-2-1',
      pitchIn: 45,
      count: 14,
    })
    .monument('galley', 'lavatory', 'lavatory')
    .build(5);
  return { frame, config };
}

export const CABIN_PRESETS: readonly CabinPreset[] = [a320neo(), atr72(), a350ulr()];

export function presetFor(typeDesignation: string): CabinPreset {
  return (
    CABIN_PRESETS.find(
      (preset) => preset.frame.typeDesignation.toLowerCase() === typeDesignation.toLowerCase(),
    ) ?? CABIN_PRESETS[0]!
  );
}

/** A fresh, independent copy — the editor mutates history, never the preset. */
export function cloneConfig(config: CabinConfig): CabinConfig {
  return {
    typeDesignation: config.typeDesignation,
    version: config.version,
    elements: config.elements.map((element) => ({ ...element })),
  };
}

// Referenced by the analysis to keep the "seats in row" derivation in one place.
export { seatsInLayout };
