import type { AircraftAvailabilityState, AircraftClass, CatalogueEntry } from '@tailfin/shared';

export const AVAILABILITY_LABEL: Record<AircraftAvailabilityState, string> = {
  unannounced: 'Not yet flying',
  prototype: 'In testing',
  orderable: 'Available',
  used_only: 'Used only',
  retired: 'Unavailable',
};

export const CLASS_LABEL: Record<AircraftClass, string> = {
  turboprop_regional: 'Regional turboprop',
  regional_jet: 'Regional jet',
  narrowbody: 'Narrowbody',
  widebody: 'Widebody',
  widebody_ulh: 'Ultra-long-haul',
  freighter: 'Freighter',
};

export type MarketRole = 'all' | 'passenger' | 'cargo';
export type MarketMethod = 'all' | 'new' | 'lease' | 'used';
export type MarketSort = 'name' | 'price' | 'range' | 'seats' | 'runway';

export interface MarketFilters {
  query: string;
  manufacturer: string;
  aircraftClass: AircraftClass | 'all';
  availability: AircraftAvailabilityState | 'all';
  role: MarketRole;
  method: MarketMethod;
  sort: MarketSort;
}

/**
 * A presentation projection over server-owned availability and inventory.
 * The final acquisition endpoint independently enforces every one of these.
 */
export function exposesMethod(
  entry: CatalogueEntry,
  method: Exclude<MarketMethod, 'all'>,
  usedCount: number,
): boolean {
  switch (method) {
    case 'new':
      return entry.acquisitionMethods.includes('new');
    case 'lease':
      return entry.acquisitionMethods.includes('lease');
    case 'used':
      return entry.acquisitionMethods.includes('used') && usedCount > 0;
  }
}

function nullableNumber(value: number | null): number {
  return value ?? Number.POSITIVE_INFINITY;
}

export function browseCatalogue(
  entries: readonly CatalogueEntry[],
  filters: MarketFilters,
  usedCounts: ReadonlyMap<string, number>,
): CatalogueEntry[] {
  const query = filters.query.trim().toLocaleLowerCase();
  const result = entries.filter((entry) => {
    if (
      query.length > 0 &&
      !`${entry.manufacturer} ${entry.designation}`.toLocaleLowerCase().includes(query)
    ) {
      return false;
    }
    if (filters.manufacturer !== 'all' && entry.manufacturer !== filters.manufacturer) return false;
    if (filters.aircraftClass !== 'all' && entry.class !== filters.aircraftClass) return false;
    if (filters.availability !== 'all' && entry.availability !== filters.availability) return false;
    if (filters.role === 'passenger' && entry.class === 'freighter') return false;
    if (filters.role === 'cargo' && entry.class !== 'freighter') return false;
    if (
      filters.method !== 'all' &&
      !exposesMethod(entry, filters.method, usedCounts.get(entry.designation) ?? 0)
    ) {
      return false;
    }
    return true;
  });

  return result.sort((a, b) => {
    switch (filters.sort) {
      case 'price':
        return nullableNumber(a.listPrice) - nullableNumber(b.listPrice);
      case 'range':
        return b.rangeNm - a.rangeNm;
      case 'seats':
        return b.seatsTwoClass - a.seatsTwoClass;
      case 'runway':
        return a.runwayRequirementM - b.runwayRequirementM;
      case 'name':
        return (
          a.manufacturer.localeCompare(b.manufacturer) || a.designation.localeCompare(b.designation)
        );
    }
  });
}

export function formatMoney(minor: number | null): string {
  if (minor === null) return 'Unavailable';
  return new Intl.NumberFormat('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(minor / 100);
}
