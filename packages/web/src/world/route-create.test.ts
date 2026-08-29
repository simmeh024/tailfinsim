import { describe, expect, it } from 'vitest';

import { bestHub, fleetMaxRangeNm, haversineNm, reachableAirportIcaos } from './route-create';

import type { WorldHub } from './map-api';
import type { LngLat } from './terminator';

const ams: LngLat = [4.76, 52.31];
const lhr: LngLat = [-0.46, 51.47];
const jfk: LngLat = [-73.78, 40.64];

const amsHub: WorldHub = { position: ams, icao: 'EHAM', name: 'Amsterdam' };

describe('haversineNm', () => {
  it('matches known great-circle distances', () => {
    // AMS–LHR is ~200 nm; AMS–JFK is ~3,150 nm. Loose bounds — this is a hint, not
    // the billed distance, which the server computes.
    expect(haversineNm(ams, lhr)).toBeGreaterThan(180);
    expect(haversineNm(ams, lhr)).toBeLessThan(230);
    expect(haversineNm(ams, jfk)).toBeGreaterThan(3000);
    expect(haversineNm(ams, jfk)).toBeLessThan(3300);
  });

  it('is zero for a point to itself', () => {
    expect(haversineNm(ams, ams)).toBeCloseTo(0, 6);
  });
});

describe('fleetMaxRangeNm', () => {
  const catalogue = [
    { designation: 'AT76', rangeNm: 825 },
    { designation: 'A21N', rangeNm: 4000 },
  ];

  it('takes the longest range across owned types', () => {
    const airframes = [{ typeDesignation: 'AT76' }, { typeDesignation: 'A21N' }];
    expect(fleetMaxRangeNm(airframes, catalogue)).toBe(4000);
  });

  it('ignores a type missing from the catalogue and returns 0 for an empty fleet', () => {
    expect(fleetMaxRangeNm([{ typeDesignation: 'ZZZZ' }], catalogue)).toBe(0);
    expect(fleetMaxRangeNm([], catalogue)).toBe(0);
  });
});

describe('bestHub', () => {
  it('marks a near airport reachable and a far one out of range', () => {
    const near = bestHub(lhr, [amsHub], 825);
    expect(near?.reachable).toBe(true);
    expect(near?.hub.icao).toBe('EHAM');

    const far = bestHub(jfk, [amsHub], 825);
    expect(far?.reachable).toBe(false);
    expect(far?.distanceNm).toBeGreaterThan(3000);
  });

  it('prefers the nearest hub that is actually in range', () => {
    const parisHub: WorldHub = { position: [2.55, 49.01], icao: 'LFPG', name: 'Paris' };
    // JFK is out of range from both; the nearest of the two is returned for messaging.
    const reach = bestHub(jfk, [amsHub, parisHub], 500);
    expect(reach?.reachable).toBe(false);
    // A short leg reachable only from Paris still resolves to Paris.
    const orly: LngLat = [2.36, 48.72];
    const short = bestHub(orly, [amsHub, parisHub], 100);
    expect(short?.hub.icao).toBe('LFPG');
    expect(short?.reachable).toBe(true);
  });

  it('returns null with no hubs', () => {
    expect(bestHub(lhr, [], 825)).toBeNull();
  });
});

describe('reachableAirportIcaos', () => {
  const airports = [
    { icao: 'EGLL', position: lhr },
    { icao: 'KJFK', position: jfk },
  ];

  it('lights only the airports a hub can reach', () => {
    const set = reachableAirportIcaos(airports, [amsHub], 825);
    expect(set.has('EGLL')).toBe(true);
    expect(set.has('KJFK')).toBe(false);
  });

  it('lights nothing with no fleet range or no hub', () => {
    expect(reachableAirportIcaos(airports, [amsHub], 0).size).toBe(0);
    expect(reachableAirportIcaos(airports, [], 825).size).toBe(0);
  });
});
