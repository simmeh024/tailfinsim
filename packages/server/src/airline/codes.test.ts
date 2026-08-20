import { describe, expect, it } from 'vitest';

import { AirlineIataCode, AirlineIcaoCode } from '@tailfin/shared';

import {
  rankedAirlineCodeCandidates,
  suggestAirlineCodes,
  tailfinAirlineCodePolicy,
} from './codes';

describe('airline code candidates', () => {
  it('leads with readable alternatives derived from the airline name', () => {
    expect(rankedAirlineCodeCandidates('Tailfin Air', 'iata').slice(0, 3)).toEqual([
      'TA',
      'TN',
      'TR',
    ]);
    expect(rankedAirlineCodeCandidates('Tailfin Air', 'icao').slice(0, 3)).toEqual([
      'TAI',
      'TFN',
      'TAA',
    ]);
    expect(rankedAirlineCodeCandidates('Air Côte d’Ivoire', 'iata').slice(0, 3)).toEqual([
      'AC',
      'AI',
      'AR',
    ]);
  });

  it('handles a non-Latin name deliberately with a deterministic Unicode hash', () => {
    const first = rankedAirlineCodeCandidates('航空会社', 'iata').slice(0, 5);
    const second = rankedAirlineCodeCandidates('航空会社', 'iata').slice(0, 5);
    expect(first).toEqual(second);
    expect(first).toHaveLength(5);
    for (const code of first) expect(AirlineIataCode.safeParse(code).success).toBe(true);
  });

  it('walks valid namespaces without duplicates', () => {
    const iata = rankedAirlineCodeCandidates('Tailfin Air', 'iata');
    const icao = rankedAirlineCodeCandidates('Tailfin Air', 'icao');
    expect(new Set(iata).size).toBe(iata.length);
    expect(new Set(icao).size).toBe(icao.length);
    expect(iata).toHaveLength(36 ** 2);
    expect(icao).toHaveLength(26 ** 3);
    for (const code of iata) expect(AirlineIataCode.safeParse(code).success).toBe(true);
    for (const code of icao) expect(AirlineIcaoCode.safeParse(code).success).toBe(true);
  });

  it('skips assigned, submitted and policy-reserved candidates', () => {
    const unavailable = new Set(['TA', 'TN']);
    const policy = {
      realWorldCodes: 'reserved' as const,
      isReserved: (_kind: 'iata' | 'icao', code: string) => code === 'TR',
    };
    const suggestions = suggestAirlineCodes('Tailfin Air', 'iata', unavailable, policy);
    expect(suggestions).toHaveLength(3);
    expect(suggestions).not.toContain('TA');
    expect(suggestions).not.toContain('TN');
    expect(suggestions).not.toContain('TR');
  });

  it('records the real-world policy rather than hiding it in the generator', () => {
    expect(tailfinAirlineCodePolicy.realWorldCodes).toBe('allowed-if-free');
    expect(tailfinAirlineCodePolicy.isReserved('iata', 'BA')).toBe(false);
    expect(tailfinAirlineCodePolicy.isReserved('icao', 'BAW')).toBe(false);
  });
});
