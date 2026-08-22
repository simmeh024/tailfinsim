import { describe, expect, it } from 'vitest';

import { AircraftSpec } from './aircraft';
import {
  AirframeDetailResponse,
  BuildCapabilities,
  CapabilityAxis,
  FleetAirframesResponse,
  SpecAxis,
} from './fleet';

/**
 * The fleet contract (M4-07).
 *
 * Two guards, and both exist because of the same failure mode: a decomposition
 * that silently stops covering the thing it decomposes. A spec field nobody
 * attributes, or a capability nothing reports, becomes exactly the dead-end
 * number CONTRIBUTING invariant 4 forbids — visible to the player, explained
 * nowhere.
 */

describe('every axis of the spec is decomposed', () => {
  it('covers AircraftSpec exactly, with wingspanCode as the one exception', () => {
    const specFields = Object.keys(AircraftSpec.shape).sort();
    const decomposed = [...SpecAxis.options, 'wingspanCode'].sort();

    // Add a field to `AircraftSpec` without adding it here and this fails,
    // rather than the build screen quietly omitting the number that moved.
    // `wingspanCode` is excluded on purpose: it is a letter on a scale, reported
    // as a step from one code to another rather than as a difference.
    expect(decomposed).toEqual(specFields);
  });

  it('reports every capability the fold carries', () => {
    const totals = Object.keys(BuildCapabilities.shape).sort();
    const perStep = [...CapabilityAxis.options, 'ulhCapable', 'unpavedCapable'].sort();

    // The two booleans are reported as `capabilitiesGained` rather than as a
    // before/after pair, because nothing in App. C.3 switches one off — so a
    // movement would always read `false -> true` and the pair would be noise.
    expect(perStep).toEqual(totals);
  });
});

describe('the responses parse what the server means to send', () => {
  it('accepts a fleet with nothing in it', () => {
    expect(FleetAirframesResponse.parse({ airframes: [] })).toEqual({ airframes: [] });
  });

  it('rejects a detail response that has grown a field', () => {
    // `.strict()` everywhere, so a field added to a handler's return value fails
    // here as well as being stripped by Fastify's serialiser. Two independent
    // reasons a leak cannot reach a client.
    const result = AirframeDetailResponse.safeParse({ surprise: true });
    expect(result.success).toBe(false);
  });
});
