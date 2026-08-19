import { describe, expect, it } from 'vitest';

import {
  Airline,
  AirlineIataCode,
  Airport,
  AirportIcaoCode,
  AirportSummary,
  CreateAirlineInput,
  Flight,
  FlightKind,
  FlightPhase,
  HealthResponse,
  MinorUnits,
  PublicAirline,
  Reputation,
  Runway,
  Timestamp,
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
    name: 'Tailfin Air',
    iataCode: 'TF',
    icaoCode: 'TFN',
    callsign: 'TAILFIN',
    baseCountry: 'NL',
    cash: 50_000_000,
    reputation: 0.35,
    createdAt: '2026-08-17T12:00:00.000Z',
  };

  it('accepts a well-formed airline', () => {
    expect(Airline.safeParse(valid).success).toBe(true);
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
    expect(Object.keys(PublicAirline.shape)).toContain('reputation');
  });

  it('does not let a client choose its own starting cash', () => {
    expect(Object.keys(CreateAirlineInput.shape)).not.toContain('cash');
    expect(Object.keys(CreateAirlineInput.shape)).not.toContain('reputation');
    expect(Object.keys(CreateAirlineInput.shape)).not.toContain('id');
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
