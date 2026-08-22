import { describe, expect, it } from 'vitest';

import {
  Airline,
  AirlineCodeAvailabilityResponse,
  AirlineCodeUnavailableError,
  AirlineFoundingAirport,
  AirlineFoundingOptionsResponse,
  AirlineIdentity,
  AirlineIataCode,
  AdminAirlineDetailResponse,
  Airport,
  AirportIcaoCode,
  AirportSummary,
  CreateAirlineInput,
  ECONOMY_CONFIG_V1,
  EconomyConfig,
  Flight,
  FlightKind,
  FlightPhase,
  ForceRenameAirlineInput,
  HealthResponse,
  INITIAL_AIRLINE_REPUTATION,
  MinorUnits,
  OwnAirlineResponse,
  PlayerAirlineContextError,
  PublicAirline,
  Reputation,
  Runway,
  Timestamp,
  UpdateOwnAirlineInput,
  UpdateOwnAirlineResponse,
  World,
} from './index';

/**
 * These test the *constraints*, not the field lists — a schema that merely
 * compiles proves nothing about what it rejects. The cases chosen are the ones
 * that would otherwise be caught in production: a price as a float, an airport
 * code of the wrong length, a private field leaking into a public payload.
 */

describe('primitives', () => {
  it('distinguishes airline codes from airport codes by length', () => {
    // The whole reason these are separate schemas: both are called "IATA code"
    // but one is two characters and the other three.
    expect(AirlineIataCode.safeParse('KL').success).toBe(true);
    expect(AirlineIataCode.safeParse('AMS').success).toBe(false);
    expect(AirportIcaoCode.safeParse('EHAM').success).toBe(true);
    expect(AirportIcaoCode.safeParse('KLM').success).toBe(false);
  });

  it('rejects lowercase codes rather than silently accepting them', () => {
    expect(AirlineIataCode.safeParse('kl').success).toBe(false);
  });

  it('refuses money that is not a whole number of minor units', () => {
    expect(MinorUnits.safeParse(50_000_000).success).toBe(true);
    expect(MinorUnits.safeParse(-1_000).success).toBe(true);
    // 12.34 "euros" is the classic mistake this exists to stop.
    expect(MinorUnits.safeParse(12.34).success).toBe(false);
  });

  it('refuses money beyond exact integer range', () => {
    expect(MinorUnits.safeParse(Number.MAX_SAFE_INTEGER + 2).success).toBe(false);
  });

  it('bounds reputation to the documented 0..1 scale', () => {
    for (const ok of [0, 0.35, 0.5, 1]) expect(Reputation.safeParse(ok).success).toBe(true);
    for (const bad of [-0.01, 1.01, 35]) expect(Reputation.safeParse(bad).success).toBe(false);
  });

  it('requires timestamps to carry an offset', () => {
    expect(Timestamp.safeParse('2024-10-20T00:00:00.000Z').success).toBe(true);
    // No timezone means two readers can disagree about when this was.
    expect(Timestamp.safeParse('2024-10-20T00:00:00').success).toBe(false);
    expect(Timestamp.safeParse('2024-10-20').success).toBe(false);
  });
});

describe('World', () => {
  const valid = {
    id: '3f2b8c9e-1d4a-4f6b-8c2e-9a7d5b3f1e0c',
    name: 'Flagship',
    epoch: '2024-10-20T00:00:00.000Z',
    launchDate: '2026-08-17T12:00:00.000Z',
    speedMultiplier: 2,
    status: 'open',
    aircraftCatalogueVersion: 'v1',
    economyConfigVersion: 'v1',
    playerCap: null,
    createdAt: '2026-08-17T12:00:00.000Z',
  };

  it('accepts the flagship world', () => {
    expect(World.safeParse(valid).success).toBe(true);
  });

  it('refuses a non-positive speed multiplier', () => {
    expect(World.safeParse({ ...valid, speedMultiplier: 0 }).success).toBe(false);
  });

  it('refuses an unknown status', () => {
    expect(World.safeParse({ ...valid, status: 'paused' }).success).toBe(false);
  });

  it('has no current-date field', () => {
    // In-game time is derived, never stored (ADR-0005). If someone adds a
    // currentDate here, this fails and they have to read the ADR first.
    expect(Object.keys(World.shape)).not.toContain('currentDate');
    expect(Object.keys(World.shape)).not.toContain('currentInGameDate');
  });
});

describe('Airline', () => {
  const valid = {
    id: '3f2b8c9e-1d4a-4f6b-8c2e-9a7d5b3f1e0c',
    worldId: '5a1c7d3e-2b8f-4a6c-9d1e-7f3b5c9a2d4e',
    playerId: '7c3e9a1f-4d2b-4e8a-b6c1-3f9d7a5e1c2b',
    // M3-12: an airline is player-run or an NPC, and the two are exclusive —
    // a player airline has a player and no archetype.
    kind: 'player',
    archetype: null,
    name: 'Tailfin Air',
    iataCode: 'TF',
    icaoCode: 'TFN',
    callsign: 'TAILFIN',
    baseCountry: 'NL',
    cash: 50_000_000,
    reputation: 0.35,
    status: 'active',
    statusChangedAt: '2026-08-17T12:00:00.000Z',
    ceasedAt: null,
    createdAt: '2026-08-17T12:00:00.000Z',
  };

  it('accepts a well-formed airline', () => {
    expect(Airline.safeParse(valid).success).toBe(true);
  });

  it('accepts an NPC carrier, which has an archetype and no player', () => {
    // §24's AI carriers (M3-12). The same schema, because an NPC is an airline
    // rather than a separate kind of thing — that is what makes "NPCs obey
    // exactly the same rules as players" structural rather than a promise.
    const npc = { ...valid, playerId: null, kind: 'npc', archetype: 'lcc' };
    expect(Airline.safeParse(npc).success).toBe(true);
  });

  it('refuses a three-character IATA code', () => {
    expect(Airline.safeParse({ ...valid, iataCode: 'TFN' }).success).toBe(false);
  });

  it('refuses a three-letter country code', () => {
    expect(Airline.safeParse({ ...valid, baseCountry: 'NLD' }).success).toBe(false);
  });

  it('keeps cash out of the public projection', () => {
    // §16 makes airline profiles public. Cash must not be among what is shown,
    // and deriving PublicAirline by picking is what guarantees it.
    expect(Object.keys(PublicAirline.shape)).not.toContain('cash');
    expect(Object.keys(PublicAirline.shape)).not.toContain('playerId');
    expect(Object.keys(PublicAirline.shape)).toContain('callsign');
    expect(Object.keys(PublicAirline.shape)).toContain('reputation');
    expect(Object.keys(PublicAirline.shape)).toContain('status');
  });

  it('does not let a client choose its own starting cash', () => {
    expect(Object.keys(CreateAirlineInput.shape)).not.toContain('cash');
    expect(Object.keys(CreateAirlineInput.shape)).not.toContain('reputation');
    expect(Object.keys(CreateAirlineInput.shape)).not.toContain('id');
  });

  it('requires the founder hub but does not let the client call it paid', () => {
    expect(
      CreateAirlineInput.safeParse({
        worldId: valid.worldId,
        name: valid.name,
        iataCode: valid.iataCode,
        icaoCode: valid.icaoCode,
        callsign: valid.callsign,
        baseCountry: valid.baseCountry,
        hubIdent: 'EHAM',
      }).success,
    ).toBe(true);
    expect(Object.keys(CreateAirlineInput.shape)).not.toContain('founderGrant');
  });

  it('keeps opening terms and hub cost server-authored for the founding screen', () => {
    expect(
      AirlineFoundingOptionsResponse.safeParse({
        memberships: [],
        worlds: [
          {
            id: valid.worldId,
            name: 'Flagship',
            openingCashMinor: 50_000_000,
            freeHubAllowance: 1,
            playerCap: null,
            airlines: 0,
            availability: 'available',
          },
        ],
      }).success,
    ).toBe(true);

    expect(
      AirlineFoundingAirport.safeParse({
        ident: 'EGLL',
        icao: 'EGLL',
        iata: 'LHR',
        name: 'London Heathrow Airport',
        city: 'London',
        country: 'GB',
        tier: 'flagship',
        slotLevel: 3,
        foundingCostMinor: 0,
        feeWarning: 'Flagship fees and coordinated slots make this an ambitious first base.',
      }).success,
    ).toBe(true);
  });

  it.each(['Air Côte d’Ivoire', '航空会社', 'خطوط الأفق'])(
    'accepts a deliberately supported Unicode name: %s',
    (name) => {
      expect(AirlineIdentity.safeParse({ ...valid, name }).success).toBe(true);
    },
  );

  it.each([
    ['non-NFC text', 'Ame\u0301lie Air', /NFC/],
    ['emoji', 'Tailfin ✈', /may contain only/],
    ['an invisible separator', 'Tailfin\u200bAir', /may contain only/],
    ['only punctuation', '---', /at least one Unicode letter/],
    ['doubled spaces', 'Tailfin  Air', /single spaces/],
  ])('rejects %s and names the failed rule', (_label, name, message) => {
    const parsed = AirlineIdentity.safeParse({ ...valid, name });
    expect(parsed.success).toBe(false);
    if (!parsed.success)
      expect(parsed.error.issues.map((issue) => issue.message).join(' ')).toMatch(message);
  });

  it('keeps the operational callsign ASCII, uppercase and structurally spoken', () => {
    expect(AirlineIdentity.safeParse({ ...valid, callsign: 'SPEEDBIRD 1' }).success).toBe(true);
    for (const callsign of ['Speedbird', 'SPEEDBIRD  1', 'ПОЛЁТ', '1234']) {
      expect(AirlineIdentity.safeParse({ ...valid, callsign }).success).toBe(false);
    }
  });

  it('lets moderation replace display text but not scarce codes', () => {
    expect(
      ForceRenameAirlineInput.safeParse({
        name: 'Tailfin Reformed',
        callsign: 'TAILFIN NEW',
        reason: 'moderation correction',
      }).success,
    ).toBe(true);
    expect(Object.keys(ForceRenameAirlineInput.shape)).not.toContain('iataCode');
    expect(Object.keys(ForceRenameAirlineInput.shape)).not.toContain('icaoCode');
  });

  it('makes absence a normal own-airline response and names the rebrand boundary', () => {
    expect(OwnAirlineResponse.safeParse({ airline: null, rebrand: null }).success).toBe(true);
    expect(
      OwnAirlineResponse.safeParse({
        airline: valid,
        rebrand: {
          costMinor: 2_500_000,
          mutableFields: ['name', 'callsign', 'baseCountry'],
          immutableFields: ['iataCode', 'icaoCode', 'cash', 'reputation'],
        },
      }).success,
    ).toBe(true);
  });

  it('rejects money, reputation and scarce codes from the strict player rebrand input', () => {
    const identity = { name: valid.name, callsign: valid.callsign, baseCountry: valid.baseCountry };
    expect(UpdateOwnAirlineInput.safeParse(identity).success).toBe(true);
    for (const extra of [
      { cash: 900_000_000 },
      { reputation: 1 },
      { iataCode: 'ZZ' },
      { icaoCode: 'ZZZ' },
    ]) {
      expect(UpdateOwnAirlineInput.safeParse({ ...identity, ...extra }).success).toBe(false);
    }
    expect(
      UpdateOwnAirlineResponse.safeParse({
        airline: { ...valid, cash: 47_500_000 },
        changed: true,
        chargedMinor: 2_500_000,
        identityChangeId: '8a1c7d3e-2b8f-4a6c-9d1e-7f3b5c9a2d4e',
      }).success,
    ).toBe(true);
  });
});

describe('admin airline support record', () => {
  const valid = {
    airline: {
      id: '3f2b8c9e-1d4a-4f6b-8c2e-9a7d5b3f1e0c',
      worldId: '5a1c7d3e-2b8f-4a6c-9d1e-7f3b5c9a2d4e',
      worldName: 'Flagship',
      owner: {
        id: '7c3e9a1f-4d2b-4e8a-b6c1-3f9d7a5e1c2b',
        displayName: 'Amelia Hart',
      },
      kind: 'player',
      archetype: null,
      name: 'Tailfin Air',
      iataCode: 'TF',
      icaoCode: 'TFN',
      callsign: 'TAILFIN',
      baseCountry: 'NL',
      cashMinor: 49_987_500,
      reputation: 0.35,
      status: 'active',
      statusChangedAt: '2026-08-17T12:00:00.000Z',
      ceasedAt: null,
      createdAt: '2026-08-17T12:00:00.000Z',
      routes: [
        {
          id: '8d4f2a6c-1b3e-4d7f-9a5c-2e8b6d4f1a3c',
          originIcao: 'EHAM',
          originName: 'Amsterdam Airport Schiphol',
          destinationIcao: 'EGLL',
          destinationName: 'London Heathrow Airport',
          greatCircleNm: 200,
          fares: { economy: 12_500 },
          active: true,
          createdAt: '2026-08-18T12:00:00.000Z',
          updatedAt: '2026-08-18T12:00:00.000Z',
        },
      ],
    },
    cashMovements: {
      entries: [
        {
          id: '9e5a3b7d-2c4f-4e8a-a6d1-3f9c7b5e2a4d',
          amountMinor: -12_500,
          cause: 'flight_settlement',
          reference: 'flight-123',
          balanceAfterMinor: 49_987_500,
          occurredAt: '2026-08-19T12:00:00.000Z',
          recordedAt: '2026-08-19T12:00:01.000Z',
        },
      ],
      total: 1,
      limit: 50,
      offset: 0,
    },
  };

  it('accepts a route and immutable balance explanation together', () => {
    expect(AdminAirlineDetailResponse.safeParse(valid).success).toBe(true);
  });

  it('refuses an invented cash cause and fractional minor units', () => {
    const inventedCause = JSON.parse(JSON.stringify(valid)) as typeof valid;
    inventedCause.cashMovements.entries[0]!.cause = 'manual_adjustment';
    expect(AdminAirlineDetailResponse.safeParse(inventedCause).success).toBe(false);

    const fractional = JSON.parse(JSON.stringify(valid)) as typeof valid;
    fractional.cashMovements.entries[0]!.amountMinor = 12.5;
    expect(AdminAirlineDetailResponse.safeParse(fractional).success).toBe(false);
  });
});

describe('airline code allocation contracts', () => {
  const advisory = {
    scope: 'world' as const,
    reservation: 'none' as const,
    realWorldCodes: 'allowed-if-free' as const,
    message: 'Availability is advisory; founding reserves the code.',
  };

  it('makes the advisory and real-world scope part of the availability wire shape', () => {
    expect(
      AirlineCodeAvailabilityResponse.safeParse({
        advisory,
        iataCode: { requested: 'TF', status: 'assigned', alternatives: ['TA', 'TN'] },
        icaoCode: { requested: 'TFN', status: 'available', alternatives: [] },
      }).success,
    ).toBe(true);
  });

  it('requires a taken-code refusal to carry alternatives and non-reservation semantics', () => {
    expect(
      AirlineCodeUnavailableError.safeParse({
        code: 'iata_code_taken',
        message: 'TF is already assigned',
        fields: { iataCode: ['TF is already taken in this world.'] },
        codeKind: 'iata',
        submittedCode: 'TF',
        alternatives: ['TA', 'TN', 'TR'],
        advisory,
      }).success,
    ).toBe(true);
    expect(
      AirlineCodeUnavailableError.safeParse({
        code: 'iata_code_taken',
        message: 'TF is already assigned',
        codeKind: 'iata',
        submittedCode: 'TF',
        alternatives: ['TA'],
      }).success,
    ).toBe(false);
  });
});

describe('player airline context contract', () => {
  it.each([
    'airline_required',
    'active_world_required',
    'invalid_active_world',
    'airline_restricted',
    'airline_ceased',
  ])('keeps %s machine-readable while allowing the wording to improve', (code) => {
    expect(
      PlayerAirlineContextError.safeParse({ code, message: 'A useful explanation.' }).success,
    ).toBe(true);
  });

  it('does not mistake authentication or route lookup errors for context state', () => {
    for (const code of ['unauthorized', 'not_found', 'duplicate_route']) {
      expect(
        PlayerAirlineContextError.safeParse({ code, message: 'A different response.' }).success,
      ).toBe(false);
    }
  });
});

describe('EconomyConfig', () => {
  /**
   * The shipped payload is the fixture.
   *
   * Building a valid one by hand would mean maintaining a second copy of every
   * balance number, which is the thing M3-11 exists to stop. Spreading over the
   * real one also means a new required field cannot be added without this suite
   * exercising it.
   */
  const valid: Record<string, unknown> = { ...ECONOMY_CONFIG_V1 };

  it('validates the shipped payload at runtime', () => {
    expect(EconomyConfig.safeParse(valid).success).toBe(true);
    // Not just parseable — parsed. The constant is produced by `EconomyConfig.parse`
    // at module load, so a typo in it fails the first import rather than the
    // first settlement.
    expect(ECONOMY_CONFIG_V1.version).toBe('v1');
  });

  it('refuses a payload missing a whole balance section', () => {
    // Deliberately not optional. A config that parsed without `demand` would
    // load, and then the first share calculation would read `undefined` betas.
    const { demand: _demand, ...withoutDemand } = ECONOMY_CONFIG_V1;
    expect(EconomyConfig.safeParse(withoutDemand).success).toBe(false);
  });

  it('refuses a field the schema does not declare', () => {
    // `.strict()` throughout: a typo in a hand-written retune payload must be a
    // refusal, not a silently ignored key that leaves the old value in force.
    expect(EconomyConfig.safeParse({ ...valid, betaPrice: 3 }).success).toBe(false);
  });

  it.each([
    ['fractional money', { openingCashMinor: 500_000.5, freeHubAllowance: 1 }],
    ['negative opening cash', { openingCashMinor: -1, freeHubAllowance: 1 }],
    ['fractional hub allowance', { openingCashMinor: 50_000_000, freeHubAllowance: 1.5 }],
    ['negative hub allowance', { openingCashMinor: 50_000_000, freeHubAllowance: -1 }],
  ])('refuses %s', (_label, airlineStartingPosition) => {
    expect(EconomyConfig.safeParse({ ...valid, airlineStartingPosition }).success).toBe(false);
  });

  it('requires a positive configured player rebrand cost', () => {
    for (const rebrandCostMinor of [0, -1, 2_500_000.5]) {
      expect(
        EconomyConfig.safeParse({ ...valid, airlineIdentity: { rebrandCostMinor } }).success,
      ).toBe(false);
    }
  });

  it('keeps the fixed initial reputation outside tunable economy config', () => {
    expect(INITIAL_AIRLINE_REPUTATION).toBe(0.35);
    expect(EconomyConfig.safeParse({ ...valid, initialReputation: 0.5 }).success).toBe(false);
  });
});

describe('Airport', () => {
  it('allows both codes to be absent, because most airports have neither', () => {
    // This test used to assert that ICAO could never be null, on the reasoning
    // that "thousands of airports have no IATA code, so ICAO has to be the key".
    // M1-01 imported the dataset and found the opposite: of 85,915 airports,
    // 10,444 carry an ICAO code and 9,052 carry IATA. Neither is a key.
    expect(Airport.shape.iata.safeParse(null).success).toBe(true);
    expect(Airport.shape.icao.safeParse(null).success).toBe(true);
  });

  it('keys on ident, which every airport has', () => {
    expect(Airport.shape.ident.safeParse('EHAM').success).toBe(true);
    expect(Airport.shape.ident.safeParse(null).success).toBe(false);
    expect(Airport.shape.ident.safeParse('').success).toBe(false);
  });

  it('still enforces the shape of a code that is present', () => {
    // Nullable is not "anything goes" — a three-letter ICAO code is still wrong.
    expect(Airport.shape.icao.safeParse('EHAM').success).toBe(true);
    expect(Airport.shape.icao.safeParse('EHA').success).toBe(false);
    expect(Airport.shape.iata.safeParse('AMS').success).toBe(true);
    expect(Airport.shape.iata.safeParse('AMST').success).toBe(false);
  });

  it('treats an unknown elevation as unknown rather than as sea level', () => {
    // 14,905 airports have no elevation, and it feeds the takeoff-length check
    // in B.4 — a default of 0 would be a plausible-looking lie.
    expect(Airport.shape.elevationFt.safeParse(null).success).toBe(true);
    expect(Airport.shape.elevationFt.safeParse(-11).success).toBe(true);
  });

  it('allows a runway of unknown length', () => {
    expect(Runway.shape.lengthFt.safeParse(null).success).toBe(true);
    // But not a nonsensical one.
    expect(Runway.shape.lengthFt.safeParse(0).success).toBe(false);
    expect(Runway.shape.lengthFt.safeParse(-1).success).toBe(false);
  });

  it('carries ident into the summary, so a list row can be identified', () => {
    expect(Object.keys(AirportSummary.shape)).toContain('ident');
  });
});

describe('Flight', () => {
  it('covers every phase in the §3.3 lifecycle', () => {
    expect(FlightPhase.options).toEqual([
      'scheduled',
      'boarding',
      'pushback',
      'taxi_out',
      'departure',
      'climb',
      'cruise',
      'descent',
      'approach',
      'landing',
      'taxi_in',
      'turnaround',
      'idle',
    ]);
  });

  it('models disruption alongside phase, not inside it', () => {
    // A flight can be delayed while still progressing, so these are separate
    // fields rather than one merged enum.
    expect(Object.keys(Flight.shape)).toContain('phase');
    expect(Object.keys(Flight.shape)).toContain('disruption');
  });

  it('accepts a flight carrying only the classes its cabin has', () => {
    const result = Flight.safeParse({
      id: '3f2b8c9e-1d4a-4f6b-8c2e-9a7d5b3f1e0c',
      worldId: '5a1c7d3e-2b8f-4a6c-9d1e-7f3b5c9a2d4e',
      airlineId: '7c3e9a1f-4d2b-4e8a-b6c1-3f9d7a5e1c2b',
      scheduleId: null,
      airframeId: '9d5f1b3a-6c2e-4a8d-b1f7-3e9c5a7d1b2f',
      originIcao: 'EHAM',
      destinationIcao: 'EGLL',
      diversionIcao: null,
      kind: 'scheduled',
      phase: 'cruise',
      disruption: null,
      scheduledDeparture: '2026-08-17T12:00:00.000Z',
      actualDeparture: '2026-08-17T12:07:00.000Z',
      estimatedArrival: '2026-08-17T13:20:00.000Z',
      actualArrival: null,
      load: { economy: { seats: 70, passengers: 48, revenue: 360_000 } },
      cargoKg: 1_200,
      createdAt: '2026-08-17T11:00:00.000Z',
    });
    expect(result.success).toBe(true);
  });

  it('models why the aircraft is flying separately from how it is going (M2-07)', () => {
    // A ferry is a *kind* of flight, not a phase and not a disruption. It
    // progresses through the same lifecycle; it simply earns nothing.
    expect(Object.keys(Flight.shape)).toContain('kind');
    expect(FlightKind.options).toEqual(['scheduled', 'ferry']);
  });
});

describe('HealthResponse', () => {
  it('accepts what the server actually sends', () => {
    expect(HealthResponse.safeParse({ status: 'ok', db: 'not_checked', uptime: 12 }).success).toBe(
      true,
    );
  });

  it('refuses a boolean db field', () => {
    // Tri-state on purpose: "not checked" must not be confusable with "up".
    expect(HealthResponse.safeParse({ status: 'ok', db: true, uptime: 12 }).success).toBe(false);
  });

  it('refuses a fractional uptime', () => {
    expect(HealthResponse.safeParse({ status: 'ok', db: 'up', uptime: 1.5 }).success).toBe(false);
  });
});
