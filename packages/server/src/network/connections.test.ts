import { describe, expect, it } from 'vitest';

import { buildConnectionBanks, type HubFlight } from './connections';

/**
 * The connection-bank arithmetic (§7.4), proven on a small hub.
 *
 * The DB test drives the real query; these fix the rules the pure builder has to
 * keep: a connection is a gap inside the window, a turn-back to the arrival city
 * is not a connection, and a bank is a cluster no wider gap than the window
 * splits.
 */

const HUB = 'EHAM';
const BASE = Date.UTC(2024, 0, 1, 10, 0, 0);
const at = (minutes: number): Date => new Date(BASE + minutes * 60_000);

function inbound(flightId: string, spokeIcao: string, minutes: number): HubFlight {
  return { flightId, spokeIcao, atUtc: at(minutes) };
}
function outbound(flightId: string, spokeIcao: string, minutes: number): HubFlight {
  return { flightId, spokeIcao, atUtc: at(minutes) };
}

describe('buildConnectionBanks', () => {
  it('reads as unscheduled, not broken, when the hub has no flights', () => {
    const result = buildConnectionBanks(HUB, [], []);
    expect(result).toMatchObject({
      hubIcao: HUB,
      inboundFlights: 0,
      outboundFlights: 0,
      feasibleConnections: 0,
      connectingInbound: 0,
      connectingOutbound: 0,
      deadEndArrivalCount: 0,
      unfedDepartureCount: 0,
      horizonDays: 0,
    });
    expect(result.banks).toEqual([]);
  });

  it('counts a connection only inside the window, and never a turn-back', () => {
    const inbounds = [inbound('A', 'BIKF', 0), inbound('B', 'LEBL', 10)];
    const outbounds = [
      outbound('X', 'KJFK', 45), // feeds both A (+45) and B (+35)
      outbound('Y', 'BIKF', 60), // A→Y is a turn-back to BIKF; B→Y (+50) is a real feed
      outbound('Z', 'LEBL', 240), // > 120 min after everything: unfed
    ];

    const result = buildConnectionBanks(HUB, inbounds, outbounds);

    // A feeds X only (Y is a turn-back); B feeds X and Y.
    expect(result.feasibleConnections).toBe(3);
    expect(result.connectingInbound).toBe(2);
    expect(result.connectingOutbound).toBe(2); // X and Y are fed; Z is not
    expect(result.deadEndArrivalCount).toBe(0);
    expect(result.unfedDepartureCount).toBe(1);
    expect(result.unfedDepartures).toEqual([
      { flightId: 'Z', spokeIcao: 'LEBL', atUtc: at(240).toISOString() },
    ]);
  });

  it('splits into banks where a gap exceeds the window, attributing each connection to its arrival bank', () => {
    const inbounds = [inbound('A', 'BIKF', 0), inbound('B', 'LEBL', 10)];
    const outbounds = [
      outbound('X', 'KJFK', 45),
      outbound('Y', 'BIKF', 60),
      outbound('Z', 'LEBL', 240),
    ];

    const { banks } = buildConnectionBanks(HUB, inbounds, outbounds);

    expect(banks).toHaveLength(2);
    const [first, second] = banks;
    expect(first).toMatchObject({
      arrivals: 2,
      departures: 2,
      connections: 3,
      startUtc: at(0).toISOString(),
      endUtc: at(60).toISOString(),
    });
    expect(second).toMatchObject({ arrivals: 0, departures: 1, connections: 0 });
  });

  it('names a dead-end arrival — one that reaches nothing onward', () => {
    const inbounds = [inbound('late', 'BIKF', 0)];
    const outbounds = [outbound('gone', 'KJFK', 10)]; // only 10 min later: below the 30-min minimum

    const result = buildConnectionBanks(HUB, inbounds, outbounds);

    expect(result.feasibleConnections).toBe(0);
    expect(result.deadEndArrivalCount).toBe(1);
    expect(result.deadEndArrivals).toEqual([
      { flightId: 'late', spokeIcao: 'BIKF', atUtc: at(0).toISOString() },
    ]);
    expect(result.unfedDepartureCount).toBe(1);
  });

  it('respects a widened window', () => {
    const inbounds = [inbound('A', 'BIKF', 0)];
    const outbounds = [outbound('far', 'KJFK', 200)]; // outside 120, inside 240

    const tight = buildConnectionBanks(HUB, inbounds, outbounds);
    expect(tight.feasibleConnections).toBe(0);

    const wide = buildConnectionBanks(HUB, inbounds, outbounds, {
      minConnectMinutes: 30,
      maxConnectMinutes: 240,
    });
    expect(wide.feasibleConnections).toBe(1);
  });
});
