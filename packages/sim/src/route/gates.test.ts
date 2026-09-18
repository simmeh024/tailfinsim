import { describe, expect, it } from 'vitest';

import {
  assignStands,
  concurrencyProfile,
  contractPriority,
  deniesRivals,
  gateRequirement,
  OPERATING_DAY_MINUTES,
  overnightPositions,
  peakConcurrency,
  percentileConcurrency,
  standOccupancies,
  standUtilisation,
  turnaroundStandOf,
  type StandOccupancy,
} from './gates';

/* -- App. B.6's simulation, reconstructed ------------------------------------ */

/**
 * The parameters App. B.6 states it simulated across: *"4 rotations/aircraft,
 * 70-minute sectors, 40-minute hub turns"*.
 *
 * A **rotation** is out and back — two sectors — so one aircraft's day is
 * 4 × (70 + 40 + 70) = 720 minutes of flying and outstation turn, plus a
 * 40-minute turn at the hub between consecutive rotations.
 */
const SECTOR_MINUTES = 70;
const TURN_MINUTES = 40;
const ROTATIONS_PER_AIRCRAFT = 4;
const DAY_START = 6 * 60;

/** One rotation, start to start: out, turn away, back, turn at home. */
const ROTATION_MINUTES = SECTOR_MINUTES + TURN_MINUTES + SECTOR_MINUTES + TURN_MINUTES;

/**
 * A **rolling** (point-to-point) operation's hub occupancies.
 *
 * Aircraft are not synchronised: each starts its day at its own offset, so the
 * hub turns land spread across the operating day rather than together. That is
 * what point-to-point *is* — an aircraft touching the base between sectors, not
 * an aircraft waiting at it for everyone else.
 *
 * The offsets are spread across a whole rotation cycle, which is the longest
 * stagger a repeating schedule admits: past it the pattern simply repeats.
 */
function rollingHubOccupancies(aircraft: number): StandOccupancy[] {
  const occupancies: StandOccupancy[] = [];
  for (let a = 0; a < aircraft; a += 1) {
    const offset = Math.round((a * ROTATION_MINUTES) / aircraft);
    for (let r = 1; r <= ROTATIONS_PER_AIRCRAFT; r += 1) {
      // Back from rotation r, then 40 minutes on stand before rotation r + 1.
      const on = DAY_START + offset + r * ROTATION_MINUTES - TURN_MINUTES;
      occupancies.push({ on, off: on + TURN_MINUTES });
    }
  }
  return occupancies;
}

/**
 * A **banked** (hub-and-spoke) operation's hub occupancies.
 *
 * The mechanism App. B.6 describes: *"connection banks work by putting every
 * aircraft on the ground simultaneously — that's the entire mechanism"*. Every
 * aircraft returns into the same wave, sits through it so its passengers can
 * cross to any other aircraft, and leaves in the outbound push.
 *
 * Arrivals are spread over a quarter of an hour rather than landing on one
 * minute, because a runway takes them one at a time; the connection window is
 * the 40-minute turn, which every aircraft in the bank shares.
 */
function bankedHubOccupancies(aircraft: number): StandOccupancy[] {
  const ARRIVAL_SPREAD_MINUTES = 15;
  const occupancies: StandOccupancy[] = [];
  for (let bank = 1; bank <= ROTATIONS_PER_AIRCRAFT; bank += 1) {
    const bankStart = DAY_START + bank * ROTATION_MINUTES - TURN_MINUTES;
    for (let a = 0; a < aircraft; a += 1) {
      const on = bankStart + Math.round((a * ARRIVAL_SPREAD_MINUTES) / Math.max(aircraft - 1, 1));
      // Everybody leaves together once the last connection has crossed.
      occupancies.push({ on, off: bankStart + ARRIVAL_SPREAD_MINUTES + TURN_MINUTES });
    }
  }
  return occupancies;
}

describe('stand concurrency', () => {
  it('counts nothing for an airline with no turns', () => {
    expect(concurrencyProfile([])).toEqual([]);
    expect(peakConcurrency([])).toBe(0);
    expect(percentileConcurrency([], 0.95)).toBe(0);
  });

  it('does not count a handover as two aircraft', () => {
    // One leaves exactly as the next arrives: one stand works both turns.
    const backToBack: StandOccupancy[] = [
      { on: 600, off: 640 },
      { on: 640, off: 680 },
    ];
    expect(peakConcurrency(backToBack)).toBe(1);
  });

  it('weights a percentile by how long each level lasted', () => {
    // Two aircraft overlap for two minutes of a two-hour day. The peak says
    // two; the 95th percentile says one, which is what to size the hub against.
    const brief: StandOccupancy[] = [
      { on: 600, off: 662 },
      { on: 660, off: 720 },
    ];
    expect(peakConcurrency(brief)).toBe(2);
    expect(percentileConcurrency(brief, 0.95)).toBe(1);
  });

  it('refuses an occupancy that ends before it starts', () => {
    expect(() => peakConcurrency([{ on: 700, off: 600 }])).toThrow(/cannot end before it starts/);
  });

  it('refuses a percentile outside 0–1', () => {
    expect(() => percentileConcurrency([], 95)).toThrow(/fraction/);
  });
});

describe("App. B.6's worked example — the one-aircraft Amsterdam airline", () => {
  /*
   * The doc's own schedule, transcribed. AMS hub, one ATR 72, AMS–LHR and
   * AMS–CDG, 40-minute hub turns:
   *
   *   on stand 08:45–09:25, 12:20–13:00, 15:45–16:25, then overnight from 19:20.
   */
  const AMS: StandOccupancy[] = [
    { on: 8 * 60 + 45, off: 9 * 60 + 25 },
    { on: 12 * 60 + 20, off: 13 * 60 },
    { on: 15 * 60 + 45, off: 16 * 60 + 25 },
    // Overnight: in at 19:20, out on tomorrow's 06:00 departure.
    { on: 19 * 60 + 20, off: 24 * 60 + 6 * 60 },
  ];

  it('needs one contact gate', () => {
    const requirement = gateRequirement(AMS);
    expect(requirement.peakConcurrency).toBe(1);
    expect(requirement.percentileConcurrency).toBe(1);
    expect(requirement.contactGates).toBe(1);
  });

  it('needs one overnight position', () => {
    expect(overnightPositions(AMS)).toBe(1);
  });

  it('reports the gate at 12% — 3 turns, 2.0 h of 17 h', () => {
    const [gate] = standUtilisation(AMS);
    expect(gate).toBeDefined();
    // Three turns inside the operating day; the overnight is clipped at 23:00.
    expect(gate?.turns).toBe(4);
    expect(gate?.occupiedMinutes).toBe(120 + (23 * 60 - (19 * 60 + 20)));
    // The doc's figure counts the three daytime turns: 2.0 h of 17 h → 12%.
    const daytimeOnly = standUtilisation(AMS.slice(0, 3));
    expect(daytimeOnly[0]?.occupiedMinutes).toBe(120);
    expect(Math.round((daytimeOnly[0]?.fraction ?? 0) * 100)).toBe(12);
  });

  it('measures utilisation against a 17-hour operating day', () => {
    expect(OPERATING_DAY_MINUTES).toBe(17 * 60);
  });
});

describe("App. B.6's growth table", () => {
  const rows = [1, 2, 4, 8, 16, 30, 60, 120].map((aircraft) => ({
    aircraft,
    rolling: gateRequirement(rollingHubOccupancies(aircraft)).contactGates,
    banked: gateRequirement(bankedHubOccupancies(aircraft)).contactGates,
  }));

  function row(aircraft: number): { rolling: number; banked: number } {
    const found = rows.find((it) => it.aircraft === aircraft);
    if (found === undefined) throw new Error(`no row for ${String(aircraft)}`);
    return found;
  }

  it('needs one gate for one aircraft, either way round', () => {
    expect(row(1).rolling).toBe(1);
    expect(row(1).banked).toBe(1);
  });

  it('grows monotonically with the fleet', () => {
    for (let i = 1; i < rows.length; i += 1) {
      expect(rows[i]?.rolling ?? 0).toBeGreaterThanOrEqual(rows[i - 1]?.rolling ?? 0);
      expect(rows[i]?.banked ?? 0).toBeGreaterThanOrEqual(rows[i - 1]?.banked ?? 0);
    }
  });

  /**
   * The finding the doc calls *"the best systems link in the whole document"*,
   * and the one the mechanic actually rests on:
   *
   * > *"a banked hub needs roughly five times the gates of a rolling
   * > point-to-point operation for the same fleet"*
   *
   * This reproduces, and closely: 5.3× at sixteen aircraft, 5.0× at thirty and
   * 5.5× at a hundred and twenty. Nothing here arranges that — a bank puts every
   * aircraft on the ground at once and a rolling operation does not, and the
   * formula counts what it is given.
   */
  it('charges a banked hub roughly five times the gates of a rolling one', () => {
    for (const aircraft of [16, 30, 60, 120]) {
      const { rolling, banked } = row(aircraft);
      const ratio = banked / rolling;
      expect(ratio).toBeGreaterThan(4.5);
      expect(ratio).toBeLessThan(6);
    }
  });

  /**
   * Where the doc's table and the doc's formula part company — recorded here
   * rather than fitted to.
   *
   * App. B.6's growth table is close to **1.4 × the aircraft on the ground** in
   * both columns (23 for 16 based aircraft banked, 171 for 120, 32 for 120
   * rolling). `ceil(P95 × 1.2)` cannot reach those figures, and for the banked
   * column nothing can: concurrency at one airport is bounded by the aircraft
   * based there, so sixteen aircraft can put at most sixteen on stand at once
   * however the bank is arranged. The doc's own calibration note says the model
   * *"slightly overstates flagship-hub gate needs"* without towing, which points
   * the same way.
   *
   * So the formula is what ships, the headline ratio above is what reproduces,
   * and the absolute column is reported on the issue rather than reverse-fitted
   * with a coefficient that would stop the formula being the doc's.
   */
  it('never requires more stands than aircraft that could stand on them', () => {
    for (const { aircraft, rolling, banked } of rows) {
      expect(banked).toBeLessThanOrEqual(aircraft);
      expect(rolling).toBeLessThanOrEqual(aircraft);
    }
    // The doc's row for sixteen based aircraft reads 5 rolling and 23 banked.
    expect(row(16).rolling).toBe(3);
    expect(row(16).banked).toBe(16);
  });

  it('applies the buffer out of the gap between the percentile and the peak', () => {
    // A day whose P95 sits below its peak: the buffer buys part of that gap back.
    const spiky: StandOccupancy[] = [
      { on: 600, off: 900 },
      { on: 610, off: 890 },
      { on: 700, off: 760 },
      { on: 710, off: 770 },
    ];
    expect(percentileConcurrency(spiky, 0.95)).toBe(4);
    expect(gateRequirement(spiky).peakConcurrency).toBe(4);
    // ceil(4 × 1.2) = 5, capped at the four that can ever be there at once.
    expect(gateRequirement(spiky).contactGates).toBe(4);

    const roomy: StandOccupancy[] = [
      { on: 600, off: 900 },
      { on: 610, off: 890 },
      { on: 700, off: 702 },
      { on: 701, off: 703 },
      { on: 701, off: 704 },
    ];
    // P95 is 2 over the occupied day; the peak is 5, so the buffer is free to
    // round 2.4 up to the 3 the doc's formula asks for.
    expect(percentileConcurrency(roomy, 0.95)).toBe(2);
    expect(gateRequirement(roomy).contactGates).toBe(3);
  });
});

describe('assigning turns to stands', () => {
  it('uses exactly as many stands as the peak', () => {
    const day = rollingHubOccupancies(8);
    const placed = assignStands(day);
    const used = placed.reduce((max, it) => Math.max(max, it.standIndex + 1), 0);
    expect(used).toBe(peakConcurrency(day));
  });

  it('never double-books a stand', () => {
    const placed = assignStands(bankedHubOccupancies(6));
    for (const a of placed) {
      for (const b of placed) {
        if (a === b || a.standIndex !== b.standIndex) continue;
        expect(a.on >= b.off || b.on >= a.off).toBe(true);
      }
    }
  });

  it('concentrates work on the first stands, so the idle one is visible', () => {
    const rows = standUtilisation(rollingHubOccupancies(8));
    for (let i = 1; i < rows.length; i += 1) {
      expect(rows[i]?.occupiedMinutes ?? 0).toBeLessThanOrEqual(rows[i - 1]?.occupiedMinutes ?? 0);
    }
  });

  it('pads out to the stands actually held, so an unused gate reports 0%', () => {
    const rows = standUtilisation([{ on: 600, off: 640 }], 3);
    expect(rows).toHaveLength(3);
    expect(rows[2]?.turns).toBe(0);
    expect(rows[2]?.fraction).toBe(0);
  });

  it('never reports more stands than were used when fewer are held', () => {
    const rows = standUtilisation(rollingHubOccupancies(4), 1);
    expect(rows.length).toBeGreaterThanOrEqual(peakConcurrency(rollingHubOccupancies(4)));
  });
});

describe('building occupancies from a rotation', () => {
  it('pairs each arrival with the next departure', () => {
    expect(standOccupancies([540, 740], [560, 800])).toEqual([
      { on: 540, off: 560 },
      { on: 740, off: 800 },
    ]);
  });

  it('holds the last arrival until tomorrow rather than dropping it', () => {
    const [overnight] = standOccupancies([1_160], [360]);
    expect(overnight).toEqual({ on: 1_160, off: 360 + 1_440 });
  });
});

describe('stand kinds and contracts', () => {
  it('maps only the two passenger stands onto a turnaround', () => {
    expect(turnaroundStandOf('contact_gate')).toBe('contact');
    expect(turnaroundStandOf('remote_stand')).toBe('remote');
    expect(turnaroundStandOf('overnight_parking')).toBeNull();
    expect(turnaroundStandOf('cargo_stand')).toBeNull();
    expect(turnaroundStandOf('maintenance_stand')).toBeNull();
  });

  it('ranks a stronger contract above a weaker one', () => {
    expect(contractPriority('exclusive')).toBeGreaterThan(contractPriority('preferential'));
    expect(contractPriority('preferential')).toBeGreaterThan(contractPriority('common_use'));
  });

  it('denies rivals only under an exclusive lease', () => {
    expect(deniesRivals('exclusive')).toBe(true);
    expect(deniesRivals('preferential')).toBe(false);
    expect(deniesRivals('common_use')).toBe(false);
  });
});
