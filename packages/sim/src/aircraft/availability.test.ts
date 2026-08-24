import { describe, expect, it } from 'vitest';

import { AIRCRAFT_CATALOGUE_V1, type AircraftEraDates, FLAGSHIP_CONFIG } from '@tailfin/shared';

import {
  AIRCRAFT_AVAILABILITY_STATES,
  aircraftAcquisitionMethods,
  availabilityOf,
  existsInWorld,
  isOperable,
  isOrderableNew,
  restrictionsInForce,
} from './availability';

/**
 * Era gating (M4-01, §7.2b).
 *
 * The rule these tests defend is stronger than "hidden": *"An aircraft simply
 * **does not exist** in a world whose clock hasn't reached it."* And the payoff
 * §7.2b claims for it is a specific, checkable event — the A321XLR entering
 * service three weeks into the flagship world — so that is asserted here as
 * behaviour rather than as a date in a table.
 */

const day = (iso: string) => new Date(`${iso}T12:00:00.000Z`);

function era(over: Partial<AircraftEraDates> = {}): AircraftEraDates {
  return {
    firstFlight: '2010-01-01',
    entryIntoService: '2012-01-01',
    productionEnd: '2020-01-01',
    outOfService: '2035-01-01',
    restrictionDates: [],
    ...over,
  };
}

const typeOf = (designation: string) => {
  const found = AIRCRAFT_CATALOGUE_V1.types.find((t) => t.designation === designation);
  if (!found) throw new Error(`no ${designation} in the catalogue`);
  return found;
};

describe('the five states a type moves through', () => {
  it('walks them in order as the clock advances', () => {
    const dates = era();
    expect(availabilityOf(dates, day('2009-12-31'))).toBe('unannounced');
    expect(availabilityOf(dates, day('2011-06-01'))).toBe('prototype');
    expect(availabilityOf(dates, day('2015-06-01'))).toBe('orderable');
    expect(availabilityOf(dates, day('2025-06-01'))).toBe('used_only');
    expect(availabilityOf(dates, day('2040-01-01'))).toBe('retired');
  });

  it('reaches every state it declares', () => {
    // A state nothing can produce is a state that should not be in the union.
    const reached = new Set([
      availabilityOf(era(), day('2009-01-01')),
      availabilityOf(era(), day('2011-01-01')),
      availabilityOf(era(), day('2015-01-01')),
      availabilityOf(era(), day('2025-01-01')),
      availabilityOf(era(), day('2040-01-01')),
    ]);
    expect([...reached].sort()).toEqual([...AIRCRAFT_AVAILABILITY_STATES].sort());
  });

  it('includes the boundary day itself', () => {
    // An aircraft entering service on the 11th is available on the 11th. Off by
    // one here and the A321XLR arrives a day late for every player in the world.
    const dates = era({ entryIntoService: '2012-01-01' });
    expect(availabilityOf(dates, new Date('2012-01-01T00:00:00.000Z'))).toBe('orderable');
    expect(availabilityOf(dates, new Date('2011-12-31T23:59:59.999Z'))).toBe('prototype');
  });

  it('treats a type with no dates at all as never having existed', () => {
    const nothing = era({
      firstFlight: null,
      entryIntoService: null,
      productionEnd: null,
      outOfService: null,
    });
    expect(availabilityOf(nothing, day('2024-10-20'))).toBe('unannounced');
    expect(existsInWorld(nothing, day('2024-10-20'))).toBe(false);
  });
});

describe('what each state permits', () => {
  it('publishes the exact type-level acquisition paths the server enforces', () => {
    const terms = { listPrice: 10_000, monthlyLeaseRate: 500 };
    expect(aircraftAcquisitionMethods('unannounced', terms)).toEqual([]);
    expect(aircraftAcquisitionMethods('prototype', terms)).toEqual([]);
    expect(aircraftAcquisitionMethods('orderable', terms)).toEqual(['new', 'lease', 'used']);
    expect(aircraftAcquisitionMethods('used_only', terms)).toEqual(['lease', 'used']);
    expect(aircraftAcquisitionMethods('retired', terms)).toEqual([]);
    expect(
      aircraftAcquisitionMethods('orderable', { listPrice: null, monthlyLeaseRate: null }),
    ).toEqual(['used']);
  });

  it('lets a player order new only while the line is open', () => {
    const dates = era();
    expect(isOrderableNew(dates, day('2011-06-01'))).toBe(false);
    expect(isOrderableNew(dates, day('2015-06-01'))).toBe(true);
    // Past production end there is no factory left to build one.
    expect(isOrderableNew(dates, day('2025-06-01'))).toBe(false);
  });

  it('keeps an out-of-production type flyable', () => {
    // Most of what makes a used market interesting: you can still fly it, you
    // just cannot buy a new one.
    const dates = era();
    expect(isOperable(dates, day('2025-06-01'))).toBe(true);
    expect(isOrderableNew(dates, day('2025-06-01'))).toBe(false);
  });

  it('stops a retired type being operated at all', () => {
    // §7.2b's hard date, as distinct from the slow squeeze of restrictions.
    expect(isOperable(era(), day('2040-01-01'))).toBe(false);
  });
});

describe('restrictions, which squeeze rather than delete', () => {
  const restricted = era({
    restrictionDates: [
      { at: '2030-01-01', kind: 'emissions_charge', note: 'Emissions surcharge at EU airports.' },
      { at: '2026-01-01', kind: 'noise_quota', note: 'Excluded from night noise quotas.' },
    ],
  });

  it('reports none before the first one bites', () => {
    expect(restrictionsInForce(restricted, day('2025-01-01'))).toEqual([]);
  });

  it('accumulates them, oldest first', () => {
    const inForce = restrictionsInForce(restricted, day('2031-01-01'));
    expect(inForce.map((r) => r.kind)).toEqual(['noise_quota', 'emissions_charge']);
  });

  it('leaves a restricted type perfectly legal to fly', () => {
    // "Your beloved fleet becomes uneconomic before it becomes illegal."
    expect(isOperable(restricted, day('2031-01-01'))).toBe(true);
    expect(availabilityOf(restricted, day('2031-01-01'))).toBe('used_only');
  });
});

describe('the flagship world on its opening day', () => {
  const epoch = new Date(FLAGSHIP_CONFIG.epoch);

  it('does not have the A321XLR yet', () => {
    // The whole point of choosing a 2024 epoch: the player starts the world
    // knowing it is coming.
    expect(availabilityOf(typeOf('A321XLR').eraDates, epoch)).toBe('prototype');
    expect(isOrderableNew(typeOf('A321XLR').eraDates, epoch)).toBe(false);
  });

  it('has it about three weeks later — §7.2b’s dated, verifiable event', () => {
    // Bracketed rather than pinned to a day. C.2 says "~3 weeks" and the real
    // gap is 22 days; asserting exactly 21 would be claiming a precision the
    // document does not have, and would fail for being right about the wrong
    // thing. Still tight enough to catch a year or a month going astray.
    const daysIn = (n: number) => new Date(epoch.getTime() + n * 86_400_000);
    const era = typeOf('A321XLR').eraDates;

    expect(isOrderableNew(era, daysIn(14)), 'two weeks in').toBe(false);
    expect(isOrderableNew(era, daysIn(28)), 'four weeks in').toBe(true);
  });

  it('shows the 777-9 without letting anyone order it', () => {
    // M4-01's third acceptance criterion, as behaviour: "visible but not
    // orderable". Both halves, because either alone would be wrong.
    const era777x = typeOf('777-9').eraDates;
    expect(existsInWorld(era777x, epoch)).toBe(true);
    expect(availabilityOf(era777x, epoch)).toBe('prototype');
    expect(isOrderableNew(era777x, epoch)).toBe(false);
  });

  it('offers the 737-800 and A380 used but not new', () => {
    // C.2's "Used market only" rows, arrived at from the dates rather than from
    // the note — the note is prose and the dates are the mechanism.
    for (const designation of ['737-800', 'A380-800', '747-8F']) {
      const dates = typeOf(designation).eraDates;
      expect(availabilityOf(dates, epoch), designation).toBe('used_only');
      expect(isOperable(dates, epoch), designation).toBe(true);
    }
  });

  it('leaves the rest of the launch set orderable', () => {
    // Thirteen of eighteen: five are not orderable on day one, and each for a
    // reason C.2 states. Two are prototypes — the 777-9, and the A321XLR that
    // has not arrived yet — and three are out of production.
    const orderable = AIRCRAFT_CATALOGUE_V1.types.filter((t) => isOrderableNew(t.eraDates, epoch));
    const notOrderable = AIRCRAFT_CATALOGUE_V1.types
      .filter((t) => !isOrderableNew(t.eraDates, epoch))
      .map((t) => t.designation);

    expect(notOrderable.sort()).toEqual(
      ['737-800', '747-8F', '777-9', 'A321XLR', 'A380-800'].sort(),
    );
    expect(orderable).toHaveLength(13);
  });

  it('has nothing retired and nothing unannounced', () => {
    for (const type of AIRCRAFT_CATALOGUE_V1.types) {
      const state = availabilityOf(type.eraDates, epoch);
      expect(state, type.designation).not.toBe('retired');
      expect(state, type.designation).not.toBe('unannounced');
    }
  });
});
