import { describe, expect, it } from 'vitest';

import { estimateCg, evaluateConstraints, serviceCounts, summarise, worstStatus } from './analysis';
import { presetFor } from './presets';

import type { CabinConfig, CabinFrame, SeatRow } from './types';

/**
 * The cabin's numbers, proved rather than asserted (§6.1/§6.4).
 *
 * The point of the analysis is §6.4's trade — seats up, comfort and range down —
 * so the tests build two cabins that differ by one choice and check the trade
 * moves in the right direction, plus the hard constraints that make a cabin
 * illegal. The exact figures are stand-ins; the relationships are the contract.
 */

const frame: CabinFrame = {
  typeDesignation: 'TEST',
  label: 'Test',
  family: 'Test',
  certifiedMaxSeats: 60,
  cabinLengthM: 20,
  lengthUnit: 'm',
  maxAbreast: 6,
  standard: { seats: 48, rangeNm: 3000, turnaroundMin: 40, cabinWeightKg: 5000 },
  cg: { minMac: 15, maxMac: 35, emptyMac: 25 },
};

function ecoRow(id: string, productId: string, pitchIn = 31): SeatRow {
  return {
    kind: 'seats',
    id,
    cabinClass: 'economy',
    productId,
    seatLayout: '3-3',
    pitchIn,
    isExitRow: false,
  };
}

function config(elements: CabinConfig['elements']): CabinConfig {
  return { typeDesignation: 'TEST', version: 1, elements };
}

describe('summarise', () => {
  it('counts seats from the rows, never claiming one they do not hold', () => {
    const cfg = config([ecoRow('a', 'eco-standard'), ecoRow('b', 'eco-standard')]);
    expect(summarise(cfg, frame).totalSeats).toBe(12);
  });

  it('groups seats by class and shares sum to one', () => {
    const cfg = config([
      { ...ecoRow('a', 'eco-standard'), cabinClass: 'business', seatLayout: '2-2' },
      ecoRow('b', 'eco-standard'),
    ]);
    const summary = summarise(cfg, frame);
    const total = summary.byClass.reduce((sum, row) => sum + row.share, 0);
    expect(total).toBeCloseTo(1);
    expect(summary.byClass.map((row) => row.cabinClass)).toEqual(['business', 'economy']);
  });

  it('trades density for comfort and range (§6.4)', () => {
    const standard = config([ecoRow('a', 'eco-standard'), ecoRow('b', 'eco-standard')]);
    const dense = config([
      ecoRow('a', 'eco-slimline', 28),
      ecoRow('b', 'eco-slimline', 28),
      ecoRow('c', 'eco-slimline', 28),
    ]);
    const s = summarise(standard, frame);
    const d = summarise(dense, frame);
    expect(d.totalSeats).toBeGreaterThan(s.totalSeats);
    expect(d.productScore).toBeLessThan(s.productScore);
    // More passengers aboard → heavier → less range.
    expect(d.rangeNm).toBeLessThan(s.rangeNm);
  });

  it('reports deltas against the type standard', () => {
    const cfg = config([ecoRow('a', 'eco-standard')]);
    const summary = summarise(cfg, frame);
    expect(summary.seatsVsStandard).toBe(6 - frame.standard.seats);
    expect(summary.turnaroundVsStandardMin).toBe(
      summary.turnaroundMin - frame.standard.turnaroundMin,
    );
  });
});

describe('estimateCg', () => {
  it('shifts forward when mass is loaded toward the nose', () => {
    const front = config([
      ecoRow('a', 'eco-standard'),
      { kind: 'galley', id: 'g' },
      { kind: 'galley', id: 'h' },
      { kind: 'galley', id: 'i' },
    ]);
    const rear = config([
      { kind: 'galley', id: 'g' },
      { kind: 'galley', id: 'h' },
      { kind: 'galley', id: 'i' },
      ecoRow('a', 'eco-standard'),
    ]);
    expect(estimateCg(front, frame).mac).toBeLessThan(estimateCg(rear, frame).mac);
  });

  it('flags a CG outside the envelope', () => {
    const noseHeavy = config([
      { kind: 'lounge', id: 'l' },
      { kind: 'galley', id: 'g' },
      ecoRow('a', 'eco-standard'),
    ]);
    const cg = estimateCg(noseHeavy, frame);
    expect(cg.withinLimits).toBe(cg.mac >= cg.minMac && cg.mac <= cg.maxMac);
  });
});

describe('evaluateConstraints', () => {
  it('errors when an exit row is below the minimum pitch', () => {
    const cfg = config([{ ...ecoRow('a', 'eco-standard', 27), isExitRow: true }]);
    const exit = evaluateConstraints(cfg, frame).find((c) => c.id === 'exit-clearance');
    expect(exit?.status).toBe('error');
  });

  it('errors when the certified seat ceiling is exceeded', () => {
    const rows = Array.from({ length: 12 }, (_, i) => ecoRow(`r${String(i)}`, 'eco-standard'));
    const seatCap = evaluateConstraints(config(rows), frame).find((c) => c.id === 'max-seats');
    expect(seatCap?.status).toBe('error');
  });

  it('warns at the galley floor and is OK above it', () => {
    const bare = config([ecoRow('a', 'eco-standard')]);
    const galley = evaluateConstraints(bare, frame).find((c) => c.id === 'galley-minimum');
    // One row, no galley → below the floor.
    expect(galley?.status).toBe('error');

    const served = config([ecoRow('a', 'eco-standard'), { kind: 'galley', id: 'g' }]);
    const served2 = config([
      ecoRow('a', 'eco-standard'),
      { kind: 'galley', id: 'g' },
      { kind: 'galley', id: 'h' },
    ]);
    expect(evaluateConstraints(served, frame).find((c) => c.id === 'galley-minimum')?.status).toBe(
      'warn',
    );
    expect(evaluateConstraints(served2, frame).find((c) => c.id === 'galley-minimum')?.status).toBe(
      'ok',
    );
  });

  it('counts a lounge as a galley (§6.3)', () => {
    const cfg = config([
      { kind: 'lounge', id: 'l' },
      { kind: 'lavatory', id: 'v' },
    ]);
    expect(serviceCounts(cfg)).toEqual({ galleys: 1, lavatories: 1 });
  });
});

describe('worstStatus', () => {
  it('surfaces the most severe status', () => {
    expect(worstStatus([{ id: 'a', label: '', status: 'ok', detail: '' }])).toBe('ok');
    expect(
      worstStatus([
        { id: 'a', label: '', status: 'ok', detail: '' },
        { id: 'b', label: '', status: 'warn', detail: '' },
      ]),
    ).toBe('warn');
    expect(
      worstStatus([
        { id: 'a', label: '', status: 'warn', detail: '' },
        { id: 'b', label: '', status: 'error', detail: '' },
      ]),
    ).toBe('error');
  });
});

describe('presets are internally consistent', () => {
  it('every preset fits within its certified ceiling and is buildable', () => {
    for (const type of ['A320neo', 'ATR 72', 'A350-900ULR']) {
      const { frame: presetFrame, config: presetConfig } = presetFor(type);
      const summary = summarise(presetConfig, presetFrame);
      expect(summary.totalSeats).toBeGreaterThan(0);
      expect(summary.totalSeats).toBeLessThanOrEqual(presetFrame.certifiedMaxSeats);
    }
  });
});
