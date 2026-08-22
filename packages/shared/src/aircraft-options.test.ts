import { describe, expect, it } from 'vitest';

import { AIRCRAFT_CATALOGUE_V1 } from './aircraft-catalogue';
import {
  AIRCRAFT_OPTIONS_V1,
  AIRCRAFT_OPTIONS_V1_BY_ID,
  AircraftOption,
  type AircraftSpecDelta,
  availableOptionsFor,
} from './aircraft-options';

/**
 * The shipped option set, against App. C.3's own rules (M4-03).
 *
 * These are data tests, and they exist because the data is the feature. An option
 * with a gain and no cost is not a balance problem to be noticed later — it is
 * C.3's central constraint broken, and C.3 says so in bold:
 *
 * > *"Every option is paid for in money, weight, space, or time — **never none
 * > of them**. That constraint is the whole feature."*
 */

/** Every axis C.3 permits an option to debit. */
function debits(deltas: AircraftSpecDelta): readonly string[] {
  const charged: string[] = [];
  if ((deltas.seatsDelta ?? 0) < 0) charged.push('seats');
  if ((deltas.maxPayloadDeltaTonnes ?? 0) < 0) charged.push('payload');
  if ((deltas.rangeDeltaNm ?? 0) < 0) charged.push('range');
  if ((deltas.oewDeltaTonnes ?? 0) > 0) charged.push('weight');
  if ((deltas.fuelBurnFactor ?? 1) > 1) charged.push('burn');
  if ((deltas.runwayRequirementFactor ?? 1) > 1) charged.push('runway');
  if ((deltas.turnaroundDeltaMin ?? 0) > 0) charged.push('turnaround');
  if ((deltas.cargoVolumeFactor ?? 1) < 1) charged.push('cargo volume');
  if ((deltas.comfortDelta ?? 0) < 0) charged.push('comfort');
  if ((deltas.maintenanceCostFactor ?? 1) > 1) charged.push('maintenance');
  if ((deltas.wingspanCodeSteps ?? 0) > 0) charged.push('wingspan code');
  return charged;
}

/** Every axis an option can improve. An option that improves nothing is not an option. */
function gains(deltas: AircraftSpecDelta): readonly string[] {
  const gained: string[] = [];
  if ((deltas.maxSeatsFactor ?? 1) > 1) gained.push('certified seats');
  if ((deltas.seatsDelta ?? 0) > 0) gained.push('seats');
  if ((deltas.maxPayloadDeltaTonnes ?? 0) > 0) gained.push('payload');
  if ((deltas.rangeDeltaNm ?? 0) > 0) gained.push('range');
  if ((deltas.oewDeltaTonnes ?? 0) < 0) gained.push('weight');
  if ((deltas.mtowDeltaTonnes ?? 0) > 0) gained.push('MTOW');
  if ((deltas.fuelBurnFactor ?? 1) < 1) gained.push('burn');
  if ((deltas.runwayRequirementFactor ?? 1) < 1) gained.push('runway');
  if ((deltas.cargoVolumeFactor ?? 1) > 1) gained.push('cargo volume');
  if ((deltas.wingspanCodeSteps ?? 0) < 0) gained.push('wingspan code');
  if (deltas.etopsMinutes !== undefined) gained.push('ETOPS');
  if ((deltas.lowVisibilityCancellationFactor ?? 1) < 1) gained.push('low-visibility dispatch');
  if (deltas.ulhCapable === true) gained.push('ULH legality');
  if (deltas.unpavedCapable === true) gained.push('unpaved strips');
  return gained;
}

describe('the shipped option set', () => {
  it('parses', () => {
    for (const option of AIRCRAFT_OPTIONS_V1) {
      expect(() => AircraftOption.parse(option)).not.toThrow();
    }
  });

  it('has unique ids, and the index agrees with the list', () => {
    const ids = AIRCRAFT_OPTIONS_V1.map((option) => option.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(AIRCRAFT_OPTIONS_V1_BY_ID.size).toBe(ids.length);
  });

  it('covers every option App. C.3 tabulates', () => {
    // C.3's table, row by row. A row missing here is a feature the design doc
    // specifies and the game does not have.
    for (const id of [
      'act-1', // Auxiliary centre tanks (1–3)
      'act-2',
      'act-3',
      'mtow-increase', // Increased MTOW
      'high-density-exits', // High-density exit configuration
      'lightweight-cabin', // Lightweight cabin package
      'sharklets', // Sharklets / winglets
      'thrust-rating-high', // Engine thrust rating
      'engine-variant-alt', // Engine variant
      'etops-180', // ETOPS 180 / 330 package
      'etops-330',
      'cat-iiib', // Cat IIIb autoland
      'cargo-door', // Main-deck cargo door / combi
      'crew-rest', // Crew rest module
      'folding-wingtips', // Folding wingtips (777-9)
      'rough-field-kit', // Rough-field kit (era worlds)
      'efficiency-package', // Extra fuel-efficiency package
    ]) {
      expect(AIRCRAFT_OPTIONS_V1_BY_ID.get(id), `C.3 row "${id}"`).toBeDefined();
    }
  });

  it('charges for everything — C.3 rule 1, no free lunch', () => {
    for (const option of AIRCRAFT_OPTIONS_V1) {
      const charged = [...debits(option.specDeltas)];
      // Money and time are the two C.3 lists alongside the spec axes.
      if (option.priceMinor > 0) charged.push('money');
      if (option.leadTimeWeeks > 0) charged.push('delivery');

      expect(charged, `${option.id} must be paid for somewhere`).not.toHaveLength(0);
    }
  });

  it('gains something — an option that only costs is not a choice', () => {
    for (const option of AIRCRAFT_OPTIONS_V1) {
      expect(gains(option.specDeltas), `${option.id} must buy something`).not.toHaveLength(0);
    }
  });

  it('declares conflicts symmetrically', () => {
    // A conflict that holds in one direction only is a conflict that depends on
    // the order the player clicked.
    for (const option of AIRCRAFT_OPTIONS_V1) {
      for (const other of option.conflictsWith) {
        const target = AIRCRAFT_OPTIONS_V1_BY_ID.get(other);
        expect(target, `${option.id} conflicts with unknown "${other}"`).toBeDefined();
        expect(target?.conflictsWith, `${other} must conflict back with ${option.id}`).toContain(
          option.id,
        );
      }
    }
  });

  it('never conflicts with itself', () => {
    for (const option of AIRCRAFT_OPTIONS_V1) {
      expect(option.conflictsWith).not.toContain(option.id);
    }
  });

  it('keeps the three auxiliary tank fits mutually exclusive', () => {
    // C.3 quotes them as "(1–3)" — a quantity, modelled as three rows because a
    // build is a set of ids. Any two of them together is nonsense.
    const tanks = ['act-1', 'act-2', 'act-3'];
    for (const id of tanks) {
      const option = AIRCRAFT_OPTIONS_V1_BY_ID.get(id);
      expect(option?.conflictsWith.slice().sort()).toEqual(tanks.filter((t) => t !== id).sort());
    }
  });

  it('orders the tank fits monotonically in range, weight and lost volume', () => {
    // More tanks must mean more range, more weight and less hold. A set where
    // two tanks beat three on any axis would make one of them dead data.
    const fits = ['act-1', 'act-2', 'act-3'].map((id) => {
      const option = AIRCRAFT_OPTIONS_V1_BY_ID.get(id);
      if (option === undefined) throw new Error(`No ${id}`);
      return option;
    });

    for (let i = 1; i < fits.length; i += 1) {
      const previous = fits[i - 1]?.specDeltas;
      const current = fits[i]?.specDeltas;
      expect(current?.rangeDeltaNm ?? 0).toBeGreaterThan(previous?.rangeDeltaNm ?? 0);
      expect(current?.oewDeltaTonnes ?? 0).toBeGreaterThan(previous?.oewDeltaTonnes ?? 0);
      expect(current?.cargoVolumeFactor ?? 1).toBeLessThan(previous?.cargoVolumeFactor ?? 1);
      expect(fits[i]?.priceMinor ?? 0).toBeGreaterThan(fits[i - 1]?.priceMinor ?? 0);
    }
  });

  it('refuses to retrofit anything that cuts metal or changes an engine', () => {
    // C.3 rule 5: "some (structural, engine variant) can't be changed at all".
    // The MTOW increase is the deliberate exception and says why in its comment:
    // the certificate changes, not the airframe.
    for (const option of AIRCRAFT_OPTIONS_V1) {
      if (option.category === 'engine') {
        expect(option.retrofittable, `${option.id} is an engine change`).toBe(false);
      }
    }
    expect(AIRCRAFT_OPTIONS_V1_BY_ID.get('cargo-door')?.retrofittable).toBe(false);
    expect(AIRCRAFT_OPTIONS_V1_BY_ID.get('folding-wingtips')?.retrofittable).toBe(false);
    expect(AIRCRAFT_OPTIONS_V1_BY_ID.get('mtow-increase')?.retrofittable).toBe(true);
  });

  it('gates ETOPS behind research, and only ETOPS', () => {
    // C.3: the ETOPS package "requires §10.3 research and rated crew". Cat IIIb
    // carries a training requirement, so it is gated too.
    expect(AIRCRAFT_OPTIONS_V1_BY_ID.get('etops-180')?.requiresResearch).toEqual(['etops-180']);
    expect(AIRCRAFT_OPTIONS_V1_BY_ID.get('etops-330')?.requiresResearch).toEqual([
      'etops-180',
      'etops-330',
    ]);
    expect(AIRCRAFT_OPTIONS_V1_BY_ID.get('sharklets')?.requiresResearch).toEqual([]);
  });
});

describe('which options a type is offered', () => {
  it('names every id against a real option', () => {
    // The rule that fills `availableOptionIds` can only refer to options that
    // exist, or a configurator offers a build that cannot be resolved.
    for (const type of AIRCRAFT_CATALOGUE_V1.types) {
      for (const id of type.availableOptionIds) {
        expect(
          AIRCRAFT_OPTIONS_V1_BY_ID.get(id),
          `${type.designation} offers "${id}"`,
        ).toBeDefined();
      }
    }
  });

  it('offers every type something to configure', () => {
    // A type with an empty configurator is a type somebody forgot, which is the
    // failure a rule-based list exists to prevent.
    for (const type of AIRCRAFT_CATALOGUE_V1.types) {
      expect(type.availableOptionIds, `${type.designation}`).not.toHaveLength(0);
    }
  });

  it('honours the two aircraft C.3 names outright', () => {
    for (const type of AIRCRAFT_CATALOGUE_V1.types) {
      // "Folding wingtips (777-9)".
      if (type.availableOptionIds.includes('folding-wingtips')) {
        expect(type.designation).toBe('777-9');
      }
      // "Rough-field kit (era worlds)" — the turboprops are what an era world flies.
      if (type.availableOptionIds.includes('rough-field-kit')) {
        expect(type.class).toBe('turboprop_regional');
      }
    }
  });

  it('offers no cabin option to a freighter', () => {
    for (const type of AIRCRAFT_CATALOGUE_V1.types) {
      if (type.class !== 'freighter') continue;
      for (const id of ['high-density-exits', 'lightweight-cabin', 'crew-rest', 'cargo-door']) {
        expect(type.availableOptionIds, `${type.designation} offers ${id}`).not.toContain(id);
      }
    }
  });

  it('offers no auxiliary tanks to a short-haul turboprop', () => {
    const atr = AIRCRAFT_CATALOGUE_V1.types.find((t) => t.designation === 'ATR 72-600');
    // An 825 nm aircraft has nowhere useful to put 700 nm of fuel.
    expect(atr?.availableOptionIds).not.toContain('act-1');
    expect(atr?.availableOptionIds).toContain('rough-field-kit');
  });

  it('is deterministic for the same type', () => {
    const type = AIRCRAFT_CATALOGUE_V1.types[0];
    if (type === undefined) throw new Error('Empty catalogue');
    expect(availableOptionsFor(type)).toEqual(availableOptionsFor(type));
  });
});

describe('the catalogue carries its options', () => {
  it('ships the option set inside the version', () => {
    // §22.5 versions the catalogue and a world pins it. Options travel with it,
    // so a retune cannot reach a running world by deploy.
    expect(AIRCRAFT_CATALOGUE_V1.options).toEqual(AIRCRAFT_OPTIONS_V1);
    expect(AIRCRAFT_CATALOGUE_V1.version).toBe('v1');
  });

  it('still ships eighteen types', () => {
    // The launch set is unchanged by M4-03; a fold that dropped a type would be
    // caught here rather than by a player.
    expect(AIRCRAFT_CATALOGUE_V1.types).toHaveLength(18);
  });
});
