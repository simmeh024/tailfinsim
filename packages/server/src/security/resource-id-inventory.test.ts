import { describe, expect, it } from 'vitest';

import {
  AircraftAcquisitionInput,
  AirlineCodeAvailabilityInput,
  BookCheckInput,
  CreateAirlineInput,
  CreateScheduleRequest,
  HireCrewInput,
  SetCrewPoliciesInput,
  SetCrewReserveInput,
  StartCrewConversionInput,
} from '@tailfin/shared';

import { parseActiveWorldHeader } from '../airline/context';
import {
  ABSENT_RESOURCE_UUID,
  MALFORMED_RESOURCE_IDS,
  RESOURCE_ID_SURFACES,
  resourceIdCases,
} from '../test-fixtures/resource-id';
import { collectRegisteredRoutes } from '../test-fixtures/route-inventory';

const UUID_A = '00000000-0000-4000-8000-000000000001';

/** Parameterised routes whose identifiers deliberately are not resource UUIDs. */
const NON_UUID_PATH_IDENTIFIERS = [
  'DELETE /api/office/hires/:seat',
  'DELETE /api/office/executive/hires/:candidateId',
  'GET /api/admin/economy-config/:version',
  'PUT /api/automation/:system',
  'GET /api/ground/:icao',
  'POST /api/ground/:icao/contracts',
] as const;

const BODY_UUID_CONTRACTS = [
  {
    endpoint: 'POST /api/airlines/code-availability worldId',
    schema: AirlineCodeAvailabilityInput,
    payload: { worldId: UUID_A, name: 'Secure Air', iataCode: 'SQ', icaoCode: 'SQA' },
    field: 'worldId',
  },
  {
    endpoint: 'POST /api/airlines worldId',
    schema: CreateAirlineInput,
    payload: {
      worldId: UUID_A,
      name: 'Secure Air',
      iataCode: 'SQ',
      icaoCode: 'SQA',
      callsign: 'SECURE',
      baseCountry: 'NL',
      hubIdent: 'EHAM',
    },
    field: 'worldId',
  },
  {
    endpoint: 'POST /api/fleet/acquisitions requestId',
    schema: AircraftAcquisitionInput,
    payload: {
      requestId: UUID_A,
      kind: 'lease',
      typeDesignation: 'ATR 72-600',
      deliveryAirportIcao: 'EHAM',
    },
    field: 'requestId',
  },
  {
    endpoint: 'POST /api/fleet/acquisitions listingId',
    schema: AircraftAcquisitionInput,
    payload: { requestId: UUID_A, kind: 'used', listingId: ABSENT_RESOURCE_UUID },
    field: 'listingId',
  },
  {
    endpoint: 'POST /api/fleet/maintenance/checks airframeId',
    schema: BookCheckInput,
    payload: { airframeId: UUID_A, tier: 'a' },
    field: 'airframeId',
  },
  {
    endpoint: 'POST /api/crew/hires crewBaseId',
    schema: HireCrewInput,
    payload: { crewBaseId: UUID_A, family: 'A320neo', rank: 'captain', heads: 1 },
    field: 'crewBaseId',
  },
  {
    endpoint: 'POST /api/schedules airframeId',
    schema: CreateScheduleRequest,
    payload: {
      airframeId: UUID_A,
      legs: [{ originIcao: 'EHAM', destinationIcao: 'BIKF', departureMinuteLocal: 480 }],
      repeat: { kind: 'daily' },
    },
    field: 'airframeId',
  },
  {
    endpoint: 'POST /api/crew/conversions crewBaseId',
    schema: StartCrewConversionInput,
    payload: {
      crewBaseId: UUID_A,
      fromFamily: 'A320neo',
      toFamily: 'B737',
      rank: 'captain',
      heads: 1,
    },
    field: 'crewBaseId',
  },
  {
    endpoint: 'PUT /api/crew/reserves crewBaseId',
    schema: SetCrewReserveInput,
    payload: { crewBaseId: UUID_A, family: 'A320neo', rank: 'captain', reserve: 1 },
    field: 'crewBaseId',
  },
  {
    endpoint: 'PUT /api/crew/policies crewBaseId',
    schema: SetCrewPoliciesInput,
    payload: { crewBaseId: UUID_A, payBand: 'generous' },
    field: 'crewBaseId',
  },
] as const;

describe('SEC-07 resource identifier inventory', () => {
  it('accounts for every parameterised route, including the non-UUID exceptions', async () => {
    const registered = (await collectRegisteredRoutes())
      .filter((route) => route.url.includes(':'))
      .map((route) => route.key)
      .sort();
    const inventoried = [
      ...RESOURCE_ID_SURFACES.filter((surface) => surface.position === 'path').map(
        (surface) => surface.endpoint,
      ),
      ...NON_UUID_PATH_IDENTIFIERS,
    ].sort();

    expect(registered).toEqual(inventoried);
  });

  it('keeps every position/field pair unique and visible', () => {
    const keys = RESOURCE_ID_SURFACES.map(
      (surface) => `${surface.endpoint} ${surface.position}:${surface.field}`,
    );
    expect(new Set(keys).size).toBe(keys.length);
    expect(new Set(RESOURCE_ID_SURFACES.map((surface) => surface.position))).toEqual(
      new Set(['path', 'query', 'body', 'header']),
    );
  });

  it('builds the four distinct cases without treating UUID syntax as authority', () => {
    const cases = resourceIdCases({
      own: UUID_A,
      anotherPlayer: '00000000-0000-4000-8000-000000000002',
      wrongEntity: '00000000-0000-4000-8000-000000000003',
    });
    expect(cases.map(({ kind }) => kind)).toEqual([
      'own',
      'another-player',
      'absent',
      'wrong-entity',
    ]);
    expect(cases.filter(({ expected }) => expected === 'allow')).toHaveLength(1);
  });

  it.each(BODY_UUID_CONTRACTS)(
    '$endpoint rejects malformed UUIDs before a database lookup',
    ({ schema, payload, field }) => {
      expect(schema.safeParse(payload).success).toBe(true);
      for (const malformed of MALFORMED_RESOURCE_IDS) {
        expect(
          schema.safeParse({ ...payload, [field]: malformed }).success,
          `${field}=${JSON.stringify(malformed)}`,
        ).toBe(false);
      }
    },
  );

  it('validates the active-world header once for every airline-scoped endpoint', () => {
    expect(parseActiveWorldHeader(UUID_A)).toEqual({ ok: true, worldId: UUID_A });
    for (const malformed of MALFORMED_RESOURCE_IDS) {
      expect(parseActiveWorldHeader(malformed)).toEqual({ ok: false });
    }
    expect(parseActiveWorldHeader([UUID_A, ABSENT_RESOURCE_UUID])).toEqual({ ok: false });
  });
});
