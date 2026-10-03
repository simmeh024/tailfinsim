import { describe, expect, it } from 'vitest';

import { AIRCRAFT_CATALOGUE_V1 } from '@tailfin/shared';

import {
  APRON_PARKED_AFTER_MINUTES,
  apronAircraftSize,
  assignApronStands,
  isHelipadIdentifier,
  isParkedOnApron,
  runwayHeadingDegrees,
  type ApronOccupantFacts,
  type ApronStandFacts,
} from './apron';

/**
 * The airport map's display rule (M7-07, App. B.7).
 *
 * The game stores no gate assignment, so these tests are about the picture being
 * **deterministic** and **agreeing with the model it illustrates**: an airline's
 * aeroplanes on its own stands, a walk-up only on a stand nobody holds, holders
 * before walk-ups, parked aeroplanes off the contact gates.
 */

const NOW = Date.UTC(2031, 3, 14, 12, 0);
const MINUTE = 60_000;

const US = 'airline-us';
const RIVAL = 'airline-rival';

function stand(
  position: string,
  kind: ApronStandFacts['kind'],
  holders: ApronStandFacts['holders'] = [],
): ApronStandFacts {
  return { position, kind, holders };
}

/** A small apron: two contact gates, two remote stands, an overnight position, a cargo stand. */
function apron(holdings: Record<string, ApronStandFacts['holders']> = {}): ApronStandFacts[] {
  return [
    stand('A1', 'contact_gate', holdings.A1),
    stand('A2', 'contact_gate', holdings.A2),
    stand('R1', 'remote_stand', holdings.R1),
    stand('R2', 'remote_stand', holdings.R2),
    stand('P1', 'overnight_parking', holdings.P1),
    stand('F1', 'cargo_stand', holdings.F1),
  ];
}

function plane(
  key: string,
  airlineId: string,
  overrides: Partial<ApronOccupantFacts> = {},
): ApronOccupantFacts {
  return {
    key,
    airlineId,
    arrivedAt: NOW - 20 * MINUTE,
    departsAt: NOW + 30 * MINUTE,
    freighter: false,
    measuredPosition: null,
    ...overrides,
  };
}

describe('assignApronStands', () => {
  it('stands an airline’s aeroplanes on its own stands, exclusive before preferential', () => {
    const stands = apron({
      A1: [{ airlineId: US, contract: 'preferential' }],
      A2: [{ airlineId: US, contract: 'exclusive' }],
    });
    const placed = assignApronStands(stands, [plane('one', US)], NOW);
    expect(placed.get('one')).toBe('A2');
  });

  it('uses an own contact gate before an own remote stand', () => {
    const stands = apron({
      R1: [{ airlineId: US, contract: 'exclusive' }],
      A2: [{ airlineId: US, contract: 'preferential' }],
    });
    expect(assignApronStands(stands, [plane('one', US)], NOW).get('one')).toBe('A2');
  });

  it('places holders before walk-ups, whatever the arrival order', () => {
    // The rival lands first, but A1 is ours: App. B.6's preferential holder
    // outranks a walk-up, so the rival must not be drawn on it.
    const stands = apron({ A1: [{ airlineId: US, contract: 'preferential' }] });
    const placed = assignApronStands(
      stands,
      [
        plane('rival', RIVAL, { arrivedAt: NOW - 50 * MINUTE }),
        plane('ours', US, { arrivedAt: NOW - 5 * MINUTE }),
      ],
      NOW,
    );
    expect(placed.get('ours')).toBe('A1');
    expect(placed.get('rival')).toBe('A2');
  });

  it('never draws a walk-up on a stand somebody holds, preferential included', () => {
    // `resolveStands` counts every leased contact gate as gone for a walk-up, so
    // the picture must too: the rival walks out to a remote stand.
    const stands = apron({
      A1: [{ airlineId: US, contract: 'preferential' }],
      A2: [{ airlineId: US, contract: 'exclusive' }],
    });
    const placed = assignApronStands(stands, [plane('rival', RIVAL)], NOW);
    expect(placed.get('rival')).toBe('R1');
  });

  it('parks an aeroplane with nothing to do, never on a contact gate', () => {
    const stands = apron({ A1: [{ airlineId: US, contract: 'exclusive' }] });
    const placed = assignApronStands(
      stands,
      [
        plane('idle', US, { departsAt: null }),
        plane('later', US, {
          key: 'later',
          departsAt: NOW + (APRON_PARKED_AFTER_MINUTES + 1) * MINUTE,
        }),
      ],
      NOW,
    );
    // The first parked aeroplane takes the overnight position, the second the
    // remote apron — and neither takes the airline's own empty contact gate.
    expect(new Set([placed.get('idle'), placed.get('later')])).toEqual(new Set(['P1', 'R1']));
  });

  it('sends a freighter to a cargo stand first', () => {
    const placed = assignApronStands(apron(), [plane('box', US, { freighter: true })], NOW);
    expect(placed.get('box')).toBe('F1');
  });

  it('honours the stand M7-06’s measurement put this turn on', () => {
    const stands = apron({
      A1: [{ airlineId: US, contract: 'exclusive' }],
      A2: [{ airlineId: US, contract: 'exclusive' }],
    });
    const placed = assignApronStands(
      stands,
      [
        plane('first', US, { arrivedAt: NOW - 40 * MINUTE }),
        plane('second', US, { arrivedAt: NOW - 30 * MINUTE, measuredPosition: 'A1' }),
      ],
      NOW,
    );
    expect(placed.get('second')).toBe('A1');
    expect(placed.get('first')).toBe('A2');
  });

  it('ignores a measured position on a stand the airline does not hold', () => {
    const stands = apron({ A2: [{ airlineId: US, contract: 'preferential' }] });
    const placed = assignApronStands(stands, [plane('one', US, { measuredPosition: 'A1' })], NOW);
    expect(placed.get('one')).toBe('A2');
  });

  it('gives the earlier arrival a measured stand two aeroplanes both claim', () => {
    const stands = apron({ A1: [{ airlineId: US, contract: 'exclusive' }] });
    const placed = assignApronStands(
      stands,
      [
        plane('late', US, { arrivedAt: NOW - 10 * MINUTE, measuredPosition: 'A1' }),
        plane('early', US, { arrivedAt: NOW - 60 * MINUTE, measuredPosition: 'A1' }),
      ],
      NOW,
    );
    expect(placed.get('early')).toBe('A1');
    expect(placed.get('late')).toBe('A2');
  });

  it('answers null when nothing fits, rather than inventing a stand', () => {
    const tiny = [stand('A1', 'contact_gate')];
    const placed = assignApronStands(tiny, [plane('one', US), plane('two', RIVAL)], NOW);
    expect([...placed.values()].sort()).toEqual(['A1', null].sort());
  });

  it('is the same however the aeroplanes are listed, with ties broken by key', () => {
    const stands = apron();
    const same = NOW - 15 * MINUTE;
    const planes = [
      plane('b', RIVAL, { arrivedAt: same }),
      plane('a', US, { arrivedAt: same }),
      plane('c', US, { arrivedAt: NOW - 60 * MINUTE }),
    ];
    const forward = assignApronStands(stands, planes, NOW);
    const backward = assignApronStands(stands, [...planes].reverse(), NOW);
    expect([...backward.entries()].sort()).toEqual([...forward.entries()].sort());
    // Earliest first, then 'a' before 'b' at the same instant.
    expect(forward.get('c')).toBe('A1');
    expect(forward.get('a')).toBe('A2');
    expect(forward.get('b')).toBe('R1');
  });
});

describe('isParkedOnApron', () => {
  it('counts an aeroplane as turning only when it leaves within the horizon', () => {
    expect(isParkedOnApron({ departsAt: null }, NOW)).toBe(true);
    expect(isParkedOnApron({ departsAt: NOW + APRON_PARKED_AFTER_MINUTES * MINUTE }, NOW)).toBe(
      false,
    );
    expect(
      isParkedOnApron({ departsAt: NOW + (APRON_PARKED_AFTER_MINUTES + 1) * MINUTE }, NOW),
    ).toBe(true);
    // Overdue is still a turn that has not finished, not a parked aeroplane.
    expect(isParkedOnApron({ departsAt: NOW - 30 * MINUTE }, NOW)).toBe(false);
  });
});

describe('apronAircraftSize', () => {
  const catalogue = AIRCRAFT_CATALOGUE_V1.types.map((type) => ({
    class: type.class,
    family: type.family,
    wingspanCode: type.baseSpec.wingspanCode,
    designation: type.designation,
  }));
  const sizeOf = (designation: string) => {
    const type = catalogue.find((row) => row.designation === designation);
    if (type === undefined) throw new Error(`no ${designation} in the catalogue`);
    return apronAircraftSize(type, catalogue);
  };

  it('reads the class, telling a regional from a narrowbody that share a wingspan code', () => {
    expect(sizeOf('ATR 72-600')).toBe('regional');
    expect(sizeOf('E190-E2')).toBe('regional');
    expect(sizeOf('A320neo')).toBe('narrowbody');
    expect(sizeOf('787-9')).toBe('widebody');
    expect(sizeOf('A350-1000')).toBe('widebody');
  });

  it('draws a freighter as its passenger sibling, or by wingspan code without one', () => {
    expect(sizeOf('ATR 72-600F')).toBe('regional');
    expect(sizeOf('777F')).toBe('widebody');
    expect(sizeOf('747-8F')).toBe('widebody');
  });

  it('sizes every type in the shipped catalogue', () => {
    for (const type of catalogue) {
      expect(['regional', 'narrowbody', 'widebody'], type.designation).toContain(
        apronAircraftSize(type, catalogue),
      );
    }
  });
});

describe('runwayHeadingDegrees', () => {
  it('reads the lower designator as a bearing rounded to ten degrees', () => {
    expect(runwayHeadingDegrees('09/27')).toBe(90);
    expect(runwayHeadingDegrees('18L/36R')).toBe(180);
    expect(runwayHeadingDegrees('36/18')).toBe(180);
    expect(runwayHeadingDegrees('04C/22C')).toBe(40);
    expect(runwayHeadingDegrees('36')).toBe(0);
  });

  it('answers null when no end is a numbered designator', () => {
    expect(runwayHeadingDegrees('N/S')).toBeNull();
    expect(runwayHeadingDegrees('H1')).toBeNull();
    expect(runwayHeadingDegrees('')).toBeNull();
  });

  it('recognises a helipad so it can be left off the map', () => {
    expect(isHelipadIdentifier('H1')).toBe(true);
    expect(isHelipadIdentifier('H1/H2')).toBe(true);
    expect(isHelipadIdentifier('09/27')).toBe(false);
    expect(isHelipadIdentifier('N/S')).toBe(false);
  });
});
