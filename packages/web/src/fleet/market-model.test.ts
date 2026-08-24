import { describe, expect, it } from 'vitest';

import type { CatalogueEntry } from '@tailfin/shared';

import { browseCatalogue, exposesMethod, type MarketFilters } from './market-model';

const entry = (over: Partial<CatalogueEntry> = {}): CatalogueEntry => ({
  designation: 'A320neo',
  family: 'A320neo',
  manufacturer: 'Airbus',
  class: 'narrowbody',
  availability: 'orderable',
  acquisitionMethods: ['new', 'lease', 'used'],
  detail: 'Available for factory order.',
  arrivesOn: null,
  seatsTwoClass: 165,
  maxSeats: 194,
  rangeNm: 3500,
  mtowTonnes: 79,
  runwayRequirementM: 2100,
  wingspanCode: 'C',
  listPrice: 110_000_000_00,
  monthlyLeaseRate: 880_000_00,
  baseDeliveryLeadWeeks: 4,
  restrictions: [],
  restrictionCostPerDepartureMinor: 0,
  availableOptionIds: [],
  ...over,
});

const FILTERS: MarketFilters = {
  query: '',
  manufacturer: 'all',
  aircraftClass: 'all',
  availability: 'all',
  role: 'all',
  method: 'all',
  sort: 'name',
};

describe('aircraft marketplace browsing', () => {
  it('searches manufacturer and type and combines canonical filters', () => {
    const result = browseCatalogue(
      [
        entry(),
        entry({
          designation: '777F',
          manufacturer: 'Boeing',
          class: 'freighter',
          seatsTwoClass: 0,
        }),
      ],
      { ...FILTERS, query: 'boe', role: 'cargo' },
      new Map(),
    );
    expect(result.map((type) => type.designation)).toEqual(['777F']);
  });

  it('sorts null prices last and numeric trade-offs in the requested direction', () => {
    const cheap = entry({ designation: 'Cheap', listPrice: 10_000 });
    const expensive = entry({ designation: 'Expensive', listPrice: 20_000 });
    const usedOnly = entry({ designation: 'Used only', listPrice: null });
    expect(
      browseCatalogue([usedOnly, expensive, cheap], { ...FILTERS, sort: 'price' }, new Map()).map(
        (type) => type.designation,
      ),
    ).toEqual(['Cheap', 'Expensive', 'Used only']);
  });

  it('uses server-authored methods and still requires real used inventory', () => {
    expect(
      exposesMethod(
        entry({ availability: 'used_only', acquisitionMethods: ['lease', 'used'] }),
        'new',
        2,
      ),
    ).toBe(false);
    expect(
      exposesMethod(entry({ availability: 'prototype', acquisitionMethods: [] }), 'lease', 2),
    ).toBe(false);
    expect(exposesMethod(entry(), 'used', 0)).toBe(false);
    expect(exposesMethod(entry(), 'used', 1)).toBe(true);
  });
});
