import { describe, expect, it } from 'vitest';

import { AircraftAcquisitionInput, AircraftOrder } from './aircraft-acquisition';
import { AIRCRAFT_CATALOGUE_V1 } from './aircraft-catalogue';

const requestId = '11111111-2222-4333-8444-555555555555';

describe('aircraft acquisition wire contracts', () => {
  it('derives airline and world from the session rather than admitting either id', () => {
    expect(
      AircraftAcquisitionInput.safeParse({
        requestId,
        kind: 'lease',
        typeDesignation: 'ATR 72-600',
        deliveryAirportIcao: 'EHAM',
        airlineId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      }).success,
    ).toBe(false);
  });

  it('defaults an off-the-shelf new build to no options', () => {
    expect(
      AircraftAcquisitionInput.parse({
        requestId,
        kind: 'new',
        typeDesignation: 'A321neo',
        deliveryAirportIcao: 'EHAM',
      }),
    ).toMatchObject({ optionIds: [] });
  });

  it('requires a delivered order to name its physical airframe', () => {
    const effectiveSpec = AIRCRAFT_CATALOGUE_V1.types[0]!.baseSpec;
    const parsed = AircraftOrder.safeParse({
      id: requestId,
      worldId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      airlineId: 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff',
      kind: 'lease',
      status: 'delivered',
      catalogueVersion: 'v1',
      typeDesignation: 'ATR 72-600',
      buildOptionIds: [],
      effectiveSpec,
      chargedMinor: 17_000_000,
      monthlyLeaseRateMinor: 8_500_000,
      baseLeadTimeWeeks: 0,
      optionLeadTimeWeeks: 0,
      deliveryAirportIcao: 'EHAM',
      orderedAt: '2026-08-22T10:00:00.000Z',
      deliveryAt: '2026-08-22T10:00:00.000Z',
      deliveredAt: '2026-08-22T10:00:00.000Z',
      airframeId: null,
    });

    expect(parsed.success).toBe(false);
  });
});
