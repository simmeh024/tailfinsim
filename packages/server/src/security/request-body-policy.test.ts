import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  AdminCreateEconomyConfigRequest,
  AdminPinEconomyConfigRequest,
  AdminRequeueEventsRequest,
  AdminResetWorldRequest,
  AdminSpeedChangeRequest,
  AdminWorldStatusRequest,
  AircraftAcquisitionInput,
  AircraftAcquisitionQuoteInput,
  AirlineCodeAvailabilityInput,
  BookCheckInput,
  CreateAirlineInput,
  CreateScheduleRequest,
  EditScheduleRequest,
  FLAGSHIP_CONFIG,
  ForceRenameAirlineInput,
  HireCrewInput,
  HireOfficeRequest,
  OpenCrewBaseInput,
  OpenRouteInput,
  SetCrewPoliciesInput,
  SetCrewReserveInput,
  SetCurrencyRequest,
  SetFaresRequest,
  SetScheduleActiveRequest,
  SignContractRequest,
  StartCrewConversionInput,
  UpdateOwnAirlineInput,
  WorldConfig,
} from '@tailfin/shared';

import {
  SENSITIVE_REQUEST_FIELDS,
  SERVER_OWNED_FINANCIAL_FIELDS,
  VIRTUAL_PRIVILEGE_FIELDS,
} from '../db/schema';
import { collectRegisteredRoutes } from '../test-fixtures/route-inventory';

const SOURCE_ROOT = join(import.meta.dirname, '..');

function routeSources(directory = SOURCE_ROOT): string[] {
  const paths: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) paths.push(...routeSources(path));
    else if (entry.name.endsWith('routes.ts')) paths.push(path);
  }
  return paths;
}

/** Deliberately narrow: any handler access to the raw boundary is a violation. */
function rawBodyReads(source: string): string[] {
  return source.match(/\brequest\s*\.\s*body\b/g) ?? [];
}

const UUID_A = '00000000-0000-4000-8000-000000000001';

const STRICT_WRITE_CONTRACTS = [
  {
    endpoint: 'PATCH /api/airlines/me',
    schema: UpdateOwnAirlineInput,
    payload: { name: 'Secure Air', callsign: 'SECURE', baseCountry: 'NL' },
  },
  {
    endpoint: 'POST /api/airlines/code-availability',
    schema: AirlineCodeAvailabilityInput,
    payload: { worldId: UUID_A, name: 'Secure Air', iataCode: 'SQ', icaoCode: 'SQA' },
  },
  {
    endpoint: 'PATCH /api/admin/airlines/:airlineId/identity',
    schema: ForceRenameAirlineInput,
    payload: { name: 'Secure Air', callsign: 'SECURE', reason: 'SEC-06 canary' },
  },
  {
    endpoint: 'POST /api/fleet/acquisition-quotes',
    schema: AircraftAcquisitionQuoteInput,
    payload: { kind: 'lease', typeDesignation: 'A320neo' },
  },
  {
    endpoint: 'POST /api/fleet/acquisitions',
    schema: AircraftAcquisitionInput,
    payload: {
      requestId: UUID_A,
      kind: 'lease',
      typeDesignation: 'A320neo',
      deliveryAirportIcao: 'EHAM',
    },
  },
  {
    endpoint: 'POST /api/fleet/maintenance/checks',
    schema: BookCheckInput,
    payload: { airframeId: UUID_A, tier: 'a' },
  },
  {
    endpoint: 'POST /api/crew/bases',
    schema: OpenCrewBaseInput,
    payload: { airportIcao: 'EHAM' },
  },
  {
    endpoint: 'POST /api/crew/hires',
    schema: HireCrewInput,
    payload: { crewBaseId: UUID_A, family: 'A320', rank: 'captain', heads: 2 },
  },
  {
    endpoint: 'POST /api/crew/conversions',
    schema: StartCrewConversionInput,
    payload: {
      crewBaseId: UUID_A,
      fromFamily: 'A320',
      toFamily: 'B737',
      rank: 'captain',
      heads: 2,
    },
  },
  {
    endpoint: 'PUT /api/crew/reserves',
    schema: SetCrewReserveInput,
    payload: { crewBaseId: UUID_A, family: 'A320', rank: 'captain', reserve: 2 },
  },
  {
    endpoint: 'PUT /api/crew/policies',
    schema: SetCrewPoliciesInput,
    payload: { crewBaseId: UUID_A, payBand: 'market' },
  },
  {
    endpoint: 'POST /api/office/hires',
    schema: HireOfficeRequest,
    payload: {
      seat: 'revenue-manager',
      candidateId: 'revenue-manager-1',
      candidateName: 'Secure Candidate',
      candidateRole: 'revenue-manager',
    },
  },
  {
    endpoint: 'POST /api/ground/:icao/contracts',
    schema: SignContractRequest,
    payload: { serviceLine: 'ramp_baggage', grade: 'standard' },
  },
  {
    endpoint: 'POST /api/routes',
    schema: OpenRouteInput,
    payload: { originIcao: 'EHAM', destinationIcao: 'EGLL' },
  },
  {
    endpoint: 'POST /api/schedules',
    schema: CreateScheduleRequest,
    payload: {
      airframeId: UUID_A,
      legs: [{ originIcao: 'EHAM', destinationIcao: 'BIKF', departureMinuteLocal: 480 }],
      autoReturn: true,
      repeat: { kind: 'daily' },
    },
  },
  {
    endpoint: 'PUT /api/schedules/:id',
    schema: EditScheduleRequest,
    payload: {
      legs: [{ originIcao: 'EHAM', destinationIcao: 'BIKF', departureMinuteLocal: 480 }],
      autoReturn: false,
      repeat: { kind: 'daily' },
    },
  },
  {
    endpoint: 'PUT /api/schedules/:id/active',
    schema: SetScheduleActiveRequest,
    payload: { active: false },
  },
  {
    endpoint: 'PUT /api/me/currency',
    schema: SetCurrencyRequest,
    payload: { currency: 'EUR' },
  },
  {
    endpoint: 'PUT/POST /api/routes/:routeId/fares[/preview]',
    schema: SetFaresRequest,
    payload: { fares: { economy: 12_000 } },
  },
  {
    endpoint: 'POST /api/admin/worlds/:worldId/speed',
    schema: AdminSpeedChangeRequest,
    payload: { speedMultiplier: 3, expectedSpeedMultiplier: 2 },
  },
  {
    endpoint: 'POST /api/admin/worlds/:worldId/status',
    schema: AdminWorldStatusRequest,
    payload: { status: 'locked', expectedStatus: 'open' },
  },
  {
    endpoint: 'POST /api/admin/worlds/:worldId/reset',
    schema: AdminResetWorldRequest,
    payload: {
      confirmName: 'Secure World',
      reason: 'SEC-06 reset test',
      expectedStatus: 'staging',
    },
  },
  {
    endpoint: 'POST /api/admin/economy-config',
    schema: AdminCreateEconomyConfigRequest,
    payload: { version: 'sec-06', payloadJson: '{}', parentVersion: 'v1', notes: 'SEC-06' },
  },
  {
    endpoint: 'POST /api/admin/worlds/:worldId/economy-config',
    schema: AdminPinEconomyConfigRequest,
    payload: { version: 'sec-06', expectedVersion: 'v1' },
  },
  {
    endpoint: 'POST /api/admin/events/requeue',
    schema: AdminRequeueEventsRequest,
    payload: { types: ['flight_departure'] },
  },
] as const;

const COVERED_WRITE_ENDPOINTS = [
  'PATCH /api/admin/airlines/:airlineId/identity',
  'PATCH /api/airlines/me',
  'POST /api/admin/economy-config',
  'POST /api/admin/events/requeue',
  'POST /api/admin/players/:playerId/sessions/revoke',
  'POST /api/admin/worlds',
  'POST /api/admin/worlds/:worldId/economy-config',
  'POST /api/admin/worlds/:worldId/reset',
  'POST /api/admin/worlds/:worldId/speed',
  'POST /api/admin/worlds/:worldId/status',
  'POST /api/airlines',
  'POST /api/airlines/code-availability',
  'POST /api/auth/logout',
  'POST /api/auth/logout-all',
  'POST /api/crew/bases',
  'POST /api/crew/conversions',
  'POST /api/crew/hires',
  'POST /api/fleet/acquisition-quotes',
  'POST /api/fleet/acquisitions',
  'POST /api/fleet/maintenance/checks',
  'PUT /api/me/currency',
  'POST /api/office/hires',
  'DELETE /api/office/hires/:seat',
  'POST /api/office/expansion',
  'POST /api/office/executive/unlock',
  'POST /api/office/executive/offices',
  'POST /api/office/executive/hires',
  'DELETE /api/office/executive/hires/:candidateId',
  'PUT /api/automation/:system',
  'POST /api/ground/:icao/contracts',
  'DELETE /api/ground/contracts/:id',
  // Airport slots (M7-05): the band is in the path, so neither write reads a body.
  'POST /api/airports/:icao/slots/:band',
  'DELETE /api/airports/:icao/slots/:band',
  'POST /api/routes',
  'POST /api/schedules',
  'PUT /api/schedules/:id',
  'PUT /api/schedules/:id/active',
  'DELETE /api/schedules/:id',
  'POST /api/routes/:routeId/fares/preview',
  'DELETE /api/routes/:routeId',
  'PUT /api/routes/:routeId/active',
  'PUT /api/crew/policies',
  'PUT /api/crew/reserves',
  'PUT /api/routes/:routeId/fares',
] as const;

describe('SEC-06 request-body policy', () => {
  it('detects the raw-field-access canary', () => {
    expect(rawBodyReads('const admin = request.body.isAdmin;')).toEqual(['request.body']);
  });

  it('keeps every route handler behind the parsed-body boundary', () => {
    const violations = routeSources().flatMap((path) => {
      const reads = rawBodyReads(readFileSync(path, 'utf8'));
      return reads.map(() => path.slice(SOURCE_ROOT.length + 1));
    });

    expect(
      violations,
      'Route handlers must call parseRequestBody() and consume only its parser result.',
    ).toEqual([]);
  });

  it('accounts for every registered write endpoint', async () => {
    const writeMethods = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
    const registered = (await collectRegisteredRoutes())
      .filter((route) => writeMethods.has(route.method))
      .map((route) => route.key)
      .sort();
    expect(registered).toEqual([...COVERED_WRITE_ENDPOINTS].sort());
  });

  it.each(STRICT_WRITE_CONTRACTS)(
    '$endpoint rejects an appended privileged field',
    ({ schema, payload }) => {
      expect(schema.safeParse(payload).success).toBe(true);
      expect(schema.safeParse({ ...payload, isAdmin: true }).success).toBe(false);
    },
  );

  it.each(STRICT_WRITE_CONTRACTS)(
    '$endpoint rejects every client-supplied financial fact and status',
    ({ schema, payload }) => {
      for (const field of SERVER_OWNED_FINANCIAL_FIELDS) {
        expect(
          schema.safeParse({ ...payload, [field]: field === 'entitlements' ? ['premium'] : 1 })
            .success,
          `${field} must not be accepted by ${schema.description ?? 'this request contract'}`,
        ).toBe(false);
      }
    },
  );

  it('rejects non-positive, fractional and absurd crew purchase quantities', () => {
    const base = { crewBaseId: UUID_A, family: 'A320', rank: 'captain' as const };
    for (const heads of [0, -1, 1.5, 1_001]) {
      expect(HireCrewInput.safeParse({ ...base, heads }).success).toBe(false);
      expect(StartCrewConversionInput.safeParse({ ...base, toFamily: 'B737', heads }).success).toBe(
        false,
      );
    }
  });

  it('keeps the world-create compatibility contract but strips privileged extras', () => {
    const parsed = WorldConfig.parse({
      ...FLAGSHIP_CONFIG,
      isAdmin: true,
      status: 'open',
      launchDate: '1900-01-01T00:00:00.000Z',
    });
    expect(parsed).toEqual(FLAGSHIP_CONFIG);
  });

  it('keeps airline founding compatible while stripping server-owned financial facts', () => {
    const allowed = {
      worldId: UUID_A,
      name: 'Secure Air',
      iataCode: 'SQ',
      icaoCode: 'SQA',
      callsign: 'SECURE',
      baseCountry: 'NL',
      hubIdent: 'EHAM',
    };
    const hostileFinancialFacts = Object.fromEntries(
      SERVER_OWNED_FINANCIAL_FIELDS.map((field) => [
        field,
        field === 'entitlements' ? ['premium'] : 999_999_999,
      ]),
    );
    const parsed = CreateAirlineInput.parse({
      ...allowed,
      ...hostileFinancialFacts,
      playerId: UUID_A,
      isAdmin: true,
      tokenHash: 'attacker-controlled-session-material',
    });
    expect(parsed).toEqual(allowed);
  });

  it('keeps the schema-derived hostile field registry complete and duplicate-free', () => {
    expect(SENSITIVE_REQUEST_FIELDS).toEqual({
      adminGrant: ['playerId'],
      world: ['speedMultiplier', 'launchDate', 'epoch', 'status'],
      airline: ['cashMinor', 'reputation', 'playerId', 'worldId'],
      playerIdentity: ['email', 'subject', 'playerId'],
      session: ['tokenHash', 'playerId'],
    });
    expect(VIRTUAL_PRIVILEGE_FIELDS).toEqual(['isAdmin', 'adminGrant']);
    expect(SERVER_OWNED_FINANCIAL_FIELDS).toEqual([
      'cash',
      'cashMinor',
      'balanceMinor',
      'reputation',
      'amountMinor',
      'priceMinor',
      'chargedMinor',
      'monthlyLeaseRateMinor',
      'resultingCashMinor',
      'credits',
      'entitlements',
      'paymentStatus',
      'orderStatus',
    ]);

    const all = [...Object.values(SENSITIVE_REQUEST_FIELDS).flat(), ...VIRTUAL_PRIVILEGE_FIELDS];
    expect(new Set(all)).toEqual(
      new Set([
        'playerId',
        'speedMultiplier',
        'launchDate',
        'epoch',
        'status',
        'cashMinor',
        'reputation',
        'worldId',
        'email',
        'subject',
        'tokenHash',
        'isAdmin',
        'adminGrant',
      ]),
    );
  });
});
