import { type FlightAirframeBasis } from '../aircraft/performance';

/**
 * A fixed aeroplane, for suites whose subject is not the aeroplane (IMPROVE-02).
 *
 * Settlement resolves the real airframe from `airframe.effective_spec` in
 * production, and `flight/settle-aircraft.test.ts` is where that path is proved
 * — including through the handler the worker actually registers.
 *
 * Every *other* settlement suite is about something else: that cash moves by
 * exactly the net, that a replay is a no-op, that a diversion bills the airport
 * it landed at, that the handling snapshot is honoured. Those tests would have
 * to acquire an aircraft through the catalogue to say anything at all, and their
 * expected figures would then move every time a catalogue entry was retuned —
 * so they pass this instead, and the substitution is visible on the line rather
 * than hidden in a default.
 *
 * The numbers are the ones the old `PLACEHOLDER_AIRFRAME` carried: an ATR
 * 72-600, matching the fixture `packages/sim`'s own tests calibrate against.
 * Keeping them means the expected costs in those suites still hold, so the diff
 * that removed the production placeholder does not also renumber sixteen
 * unrelated assertions.
 */
export const FIXTURE_TURBOPROP: FlightAirframeBasis = {
  airframeId: '00000000-0000-4000-8000-0000000f1001',
  catalogueVersion: 'fixture',
  typeDesignation: 'ATR 72-600',
  buildOptionIds: [],
  performance: {
    maxTakeoffWeightT: 23,
    cruiseSpeedKt: 275,
    cruiseBurnTPerNm: 2.5 / 825,
  },
};

/**
 * A `resolveAirframe` that answers with {@link FIXTURE_TURBOPROP} whatever it is
 * asked.
 *
 * It ignores the id on purpose: a suite using this has a flight pointing at an
 * airframe row that does not exist, and inventing one per id would imply a
 * lookup that is not happening.
 */
export function fixtureAirframe(): FlightAirframeBasis {
  return FIXTURE_TURBOPROP;
}
