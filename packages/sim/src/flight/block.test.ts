import { describe, expect, it } from 'vitest';

import { blockHours, computeBlockTime, taxiMinutes } from './block';
import { DEFAULT_FLIGHT_PROFILE, type FlightProfile } from './profile';

/**
 * Block time (M2-05, §3.3, §10.4, App. B.6).
 *
 * The acceptance criterion is *"AMS–LHR in an ATR 72 yields ~55 min block time"*,
 * and the interesting thing about it is that it is **wrong about which figure it
 * names**: 55 minutes is the airborne time under this model, and the block time is
 * 20 minutes longer because block time includes taxi. Both are asserted below,
 * along with the thing that actually reconciles the two — App. B.6's own schedule,
 * which puts the sector at 65 minutes gate to gate.
 *
 * That third assertion is the one worth having. It proves the gap between this
 * model and the design doc's worked example is **entirely the taxi assumption**
 * and not the airborne model, which is the difference between a calibration note
 * and a bug.
 */

/** EHAM–EGLL, from the OurAirports coordinates the server's importer loads. */
const AMS_LHR_NM = 200;

/** ATR 72-600. App. B.6's example fleet, and the only aircraft it names. */
const ATR72_CRUISE_KT = 275;

describe('computeBlockTime', () => {
  it('is taxi out, airborne, and taxi in — and says so component by component', () => {
    const result = computeBlockTime(AMS_LHR_NM, ATR72_CRUISE_KT, DEFAULT_FLIGHT_PROFILE);

    expect(result.blockMinutes).toBeCloseTo(
      result.taxiOutMinutes + result.airborneMinutes + result.taxiInMinutes,
      10,
    );
    // No dead-end numbers (invariant 4): the parts are on the result, not lost.
    expect(result.taxiOutMinutes).toBe(DEFAULT_FLIGHT_PROFILE.taxiOutMinutes);
    expect(result.taxiInMinutes).toBe(DEFAULT_FLIGHT_PROFILE.taxiInMinutes);
  });

  it('echoes the sector it was given, so fuel burn cannot disagree with it', () => {
    const result = computeBlockTime(AMS_LHR_NM, ATR72_CRUISE_KT, DEFAULT_FLIGHT_PROFILE);

    expect(result.distanceNm).toBe(AMS_LHR_NM);
    expect(result.cruiseSpeedKt).toBe(ATR72_CRUISE_KT);
  });

  it('carries an allocation that sums to exactly the airborne time', () => {
    const result = computeBlockTime(AMS_LHR_NM, ATR72_CRUISE_KT, DEFAULT_FLIGHT_PROFILE);
    const { allocation } = result;
    const sum =
      allocation.departureMinutes +
      allocation.climbMinutes +
      allocation.cruiseMinutes +
      allocation.descentMinutes +
      allocation.approachMinutes +
      allocation.landingMinutes;

    expect(sum).toBeCloseTo(result.airborneMinutes, 10);
    expect(allocation.totalMinutes).toBeCloseTo(result.airborneMinutes, 10);
  });

  /**
   * The three figures for one sector, and why they differ.
   *
   * 55 airborne · 65 by App. B.6's schedule · 75.6 block on the default profile.
   * The middle one is the design doc's, and it is reproduced exactly by the same
   * airborne model the moment the taxi assumption matches the one B.6 implies.
   */
  describe('AMS–LHR in an ATR 72', () => {
    it('is about 55 minutes in the air — which is the figure the criterion names', () => {
      const result = computeBlockTime(AMS_LHR_NM, ATR72_CRUISE_KT, DEFAULT_FLIGHT_PROFILE);

      // 200 nm at 275 kt is 43.6 minutes of arithmetic; the profile's 12-minute
      // manoeuvre allowance is the rest, and it is why a hop is never as quick as
      // distance ÷ speed says.
      expect(result.airborneMinutes).toBeCloseTo(55.6, 1);
    });

    it('is about 75 minutes off-blocks to on-blocks on the default profile', () => {
      const result = computeBlockTime(AMS_LHR_NM, ATR72_CRUISE_KT, DEFAULT_FLIGHT_PROFILE);

      // The default profile is a busy-narrowbody-hub assumption: 12 out, 8 in.
      // Twenty minutes of taxi on a 200 nm sector is why short-haul is unforgiving.
      expect(result.blockMinutes).toBeCloseTo(75.6, 1);
      expect(taxiMinutes(result)).toBe(20);
      expect(blockHours(result)).toBeCloseTo(75.6 / 60, 2);
    });

    it("reproduces App. B.6's 06:00–07:05 schedule once taxi matches what it implies", () => {
      // B.6's worked day: "06:00 AMS → LHR / 07:05 arr" — 65 block minutes. That
      // is the airborne model above plus ten minutes of taxi rather than twenty,
      // which is a regional turboprop at a quiet apron rather than a jet at a hub.
      const regional: FlightProfile = {
        ...DEFAULT_FLIGHT_PROFILE,
        taxiOutMinutes: 6,
        taxiInMinutes: 4,
      };

      const result = computeBlockTime(AMS_LHR_NM, ATR72_CRUISE_KT, regional);

      // 65.6 against the schedule's 65 — inside a minute, on a figure the doc
      // published rounded to the nearest five. Asserted as a band rather than a
      // rounding, because the claim being made is "the airborne model already
      // agrees with B.6", not "it agrees to the second".
      expect(result.blockMinutes).toBeGreaterThan(64);
      expect(result.blockMinutes).toBeLessThan(66);
    });
  });

  describe('§10.4 boosts', () => {
    it('removes nothing when there are no boosts', () => {
      const result = computeBlockTime(AMS_LHR_NM, ATR72_CRUISE_KT, DEFAULT_FLIGHT_PROFILE);

      expect(result.boostFraction).toBe(0);
      expect(result.boostSavingMinutes).toBe(0);
      expect(result.boostCapReached).toBe(false);
    });

    it('takes a lone boost at its face value', () => {
      const plain = computeBlockTime(AMS_LHR_NM, ATR72_CRUISE_KT, DEFAULT_FLIGHT_PROFILE);
      const boosted = computeBlockTime(AMS_LHR_NM, ATR72_CRUISE_KT, DEFAULT_FLIGHT_PROFILE, [
        { id: 'taxi-routing', fraction: 0.02 },
      ]);

      expect(boosted.boostFraction).toBeCloseTo(0.02, 10);
      expect(boosted.blockMinutes).toBeCloseTo(plain.blockMinutes * 0.98, 10);
      expect(boosted.boostCapReached).toBe(false);
    });

    it('never exceeds §10.4’s −4% ceiling, however many are stacked', () => {
      const many = Array.from({ length: 12 }, (_, i) => ({ id: `r-${String(i)}`, fraction: 0.05 }));

      const result = computeBlockTime(AMS_LHR_NM, ATR72_CRUISE_KT, DEFAULT_FLIGHT_PROFILE, many);
      const plain = computeBlockTime(AMS_LHR_NM, ATR72_CRUISE_KT, DEFAULT_FLIGHT_PROFILE);

      expect(result.boostFraction).toBe(0.04);
      expect(result.boostCapReached).toBe(true);
      expect(result.blockMinutes).toBeCloseTo(plain.blockMinutes * 0.96, 10);
    });

    it('leaves the taxi and airborne components at their unboosted values', () => {
      // The saving is reported, not smeared across the parts. A player asking
      // where the four minutes went gets `boostSavingMinutes`, and the breakdown
      // still describes the flight that was actually planned.
      const result = computeBlockTime(AMS_LHR_NM, ATR72_CRUISE_KT, DEFAULT_FLIGHT_PROFILE, [
        { id: 'r', fraction: 0.04 },
      ]);

      expect(result.taxiOutMinutes).toBe(DEFAULT_FLIGHT_PROFILE.taxiOutMinutes);
      expect(result.blockMinutes + result.boostSavingMinutes).toBeCloseTo(
        result.taxiOutMinutes + result.airborneMinutes + result.taxiInMinutes,
        10,
      );
    });
  });

  describe('replanning from cruise', () => {
    it('drops the takeoff roll and the initial climb', () => {
      // A diversion or an air return: the aircraft is already flying, so the new
      // leg is cruise then down. Same total airborne time, different shape.
      const normal = computeBlockTime(AMS_LHR_NM, ATR72_CRUISE_KT, DEFAULT_FLIGHT_PROFILE);
      const replan = computeBlockTime(AMS_LHR_NM, ATR72_CRUISE_KT, DEFAULT_FLIGHT_PROFILE, [], {
        fromCruise: true,
      });

      expect(replan.allocation.departureMinutes).toBe(0);
      expect(replan.allocation.climbMinutes).toBe(0);
      expect(replan.allocation.totalMinutes).toBeCloseTo(normal.allocation.totalMinutes, 10);
    });
  });

  describe('rejects inputs that cannot mean anything', () => {
    it('refuses a negative taxi out, naming which one', () => {
      expect(() =>
        computeBlockTime(AMS_LHR_NM, ATR72_CRUISE_KT, {
          ...DEFAULT_FLIGHT_PROFILE,
          taxiOutMinutes: -1,
        }),
      ).toThrow(/[Tt]axi out/);
    });

    it('refuses a negative taxi in, naming which one', () => {
      expect(() =>
        computeBlockTime(AMS_LHR_NM, ATR72_CRUISE_KT, {
          ...DEFAULT_FLIGHT_PROFILE,
          taxiInMinutes: Number.NaN,
        }),
      ).toThrow(/[Tt]axi in/);
    });

    it('leaves distance and speed to the airborne model, which already checks them', () => {
      expect(() => computeBlockTime(-1, ATR72_CRUISE_KT, DEFAULT_FLIGHT_PROFILE)).toThrow(
        /distance/i,
      );
      expect(() => computeBlockTime(AMS_LHR_NM, 0, DEFAULT_FLIGHT_PROFILE)).toThrow(/speed/i);
    });
  });

  it('is a pure function — the same sector always gives the same block time', () => {
    // The invariant the replay harness (M13-01) depends on.
    const once = computeBlockTime(AMS_LHR_NM, ATR72_CRUISE_KT, DEFAULT_FLIGHT_PROFILE);
    const twice = computeBlockTime(AMS_LHR_NM, ATR72_CRUISE_KT, DEFAULT_FLIGHT_PROFILE);

    expect(once).toEqual(twice);
  });
});
