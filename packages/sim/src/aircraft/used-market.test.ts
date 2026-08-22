import { describe, expect, it } from 'vitest';

import {
  AIRCRAFT_CATALOGUE_V1,
  AIRCRAFT_OPTIONS_V1,
  AIRCRAFT_OPTIONS_V1_BY_ID,
  type AircraftOption,
  type AircraftOptionCategory,
  type AircraftType,
} from '@tailfin/shared';

import {
  ageFactor,
  ageYearsBetween,
  buildWindow,
  configurationFactor,
  cyclesForHours,
  DEFAULT_USED_MARKET,
  draftUsedListing,
  expectedHours,
  generationIndex,
  listingLifetimeDays,
  newEquivalentValue,
  utilisationFactor,
  valueUsedAirframe,
  type UsedMarketCandidate,
} from './used-market';

const BALANCE = DEFAULT_USED_MARKET;
const TYPES = AIRCRAFT_CATALOGUE_V1.types;

function typeNamed(designation: string): AircraftType {
  const found = TYPES.find((t) => t.designation === designation);
  if (!found) throw new Error(`No v1 type ${designation}`);
  return found;
}

function optionNamed(id: string): AircraftOption {
  const found = AIRCRAFT_OPTIONS_V1_BY_ID.get(id);
  if (!found) throw new Error(`No v1 option ${id}`);
  return found;
}

function candidateFor(type: AircraftType): UsedMarketCandidate {
  return {
    designation: type.designation,
    aircraftClass: type.class,
    era: type.eraDates,
    baseSpec: type.baseSpec,
    listPriceMinor: type.listPrice,
    monthlyLeaseRateMinor: type.monthlyLeaseRate,
    availableOptionIds: type.availableOptionIds,
  };
}

/** Price one type at one age with one option set, holding everything else equal. */
function priceOf(type: AircraftType, ageYears: number, options: readonly AircraftOption[]) {
  const valuation = valueUsedAirframe(
    {
      aircraftClass: type.class,
      listPriceMinor: type.listPrice,
      monthlyLeaseRateMinor: type.monthlyLeaseRate,
      ageYears,
      // Exactly average utilisation, so the comparison isolates configuration.
      hours: expectedHours(ageYears, type.class, BALANCE),
      options,
    },
    BALANCE,
  );
  if (valuation === null) throw new Error(`${type.designation} could not be valued`);
  return valuation;
}

describe('the anchor', () => {
  it('uses the list price when the catalogue gives one', () => {
    const a321 = typeNamed('A321neo');
    expect(
      newEquivalentValue(
        { listPriceMinor: a321.listPrice, monthlyLeaseRateMinor: a321.monthlyLeaseRate },
        BALANCE,
      ),
    ).toEqual({ minor: a321.listPrice, source: 'list_price' });
  });

  /**
   * The three v1 types that need the fallback, and the reason it exists.
   *
   * C.2 prints "—" for a type out of production, so `list_price` is genuinely
   * null for all three — the 737-800, the A380-800 and the 747-8F, each of which
   * stopped being built. Naming them explicitly rather than counting them is the
   * point: if a future catalogue makes a fourth type unpriced, that should be a
   * decision somebody took rather than something this test absorbed.
   *
   * The notional prices are recovered exactly because the catalogue authored
   * every one of those lease rates through `leaseFor`, which is 0.8% of list per
   * month, and `leaseCapitalisationMonths` is its inverse.
   */
  it('capitalises the lease for every v1 type with no list price', () => {
    const withoutList = TYPES.filter((t) => t.listPrice === null);
    expect(withoutList.map((t) => t.designation)).toEqual(['737-800', 'A380-800', '747-8F']);

    const expected = new Map([
      ['737-800', 50],
      ['A380-800', 200],
      ['747-8F', 300],
    ]);

    for (const type of withoutList) {
      const anchor = newEquivalentValue(
        { listPriceMinor: type.listPrice, monthlyLeaseRateMinor: type.monthlyLeaseRate },
        BALANCE,
      );
      expect(anchor?.source, type.designation).toBe('capitalised_lease');
      expect(anchor?.minor, type.designation).toBe(
        (expected.get(type.designation) ?? 0) * 1_000_000 * 100,
      );
    }
  });

  it('values every type in the shipped catalogue', () => {
    for (const type of TYPES) {
      const anchor = newEquivalentValue(
        { listPriceMinor: type.listPrice, monthlyLeaseRateMinor: type.monthlyLeaseRate },
        BALANCE,
      );
      expect(anchor, type.designation).not.toBeNull();
      expect(anchor?.minor).toBeGreaterThan(0);
    }
  });

  it('refuses a type the catalogue prices neither way', () => {
    expect(
      newEquivalentValue({ listPriceMinor: null, monthlyLeaseRateMinor: null }, BALANCE),
    ).toBeNull();
  });
});

describe('the depreciation curve', () => {
  it('is worth full value at zero age', () => {
    expect(ageFactor(0, BALANCE)).toBe(1);
  });

  it('falls with every year, until the floor', () => {
    let previous = ageFactor(0, BALANCE);
    for (let age = 1; age <= 20; age += 1) {
      const factor = ageFactor(age, BALANCE);
      expect(factor, `age ${String(age)}`).toBeLessThan(previous);
      previous = factor;
    }
  });

  /**
   * The property is *approaches without reaching*, and it holds for every age
   * this market can produce and far beyond it. It stops being observable at
   * absurd ages only because `0.86 ** 500` is smaller than the last bit of
   * `0.1` — float64 running out of room, not the curve going flat — so the
   * assertion is written where it means something.
   */
  it('approaches the residual without reaching it, across every age it can list', () => {
    const floor = BALANCE.depreciation.residualFloorRatio;
    for (const age of [BALANCE.inventory.maxAgeYears, 40, 60, 100]) {
      expect(ageFactor(age, BALANCE), `age ${String(age)}`).toBeGreaterThan(floor);
    }
    expect(ageFactor(60, BALANCE)).toBeLessThan(floor * 1.05);
    // And never below it, at any age at all.
    for (const age of [0, 1, 25, 100, 500, 5_000]) {
      expect(ageFactor(age, BALANCE), `age ${String(age)}`).toBeGreaterThanOrEqual(floor);
    }
  });

  it('prices an old airframe at roughly its spares value rather than at nothing', () => {
    const a321 = typeNamed('A321neo');
    const anchor = a321.listPrice ?? 0;
    const ancient = priceOf(a321, 80, []);
    expect(ancient.askingPriceMinor).toBeGreaterThan(
      anchor * BALANCE.depreciation.residualFloorRatio,
    );
    expect(ancient.askingPriceMinor).toBeLessThan(
      anchor * BALANCE.depreciation.residualFloorRatio * 1.05,
    );
  });

  /**
   * The bug the salvage form exists to prevent, asserted directly.
   *
   * A clamped curve is flat past the crossing age, so an unusual airframe and a
   * plain one of the same great age price the same and configuration stops
   * mattering. This is the same claim the configuration property test makes, at
   * the far end of the age band where the first version of the curve broke.
   */
  it('still lets configuration and hours move the price at the oldest age listed', () => {
    const a321 = typeNamed('A321neo');
    const oldest = BALANCE.inventory.maxAgeYears;
    const plain = priceOf(a321, oldest, []);
    const odd = priceOf(a321, oldest, [optionNamed('cargo-door')]);
    expect(odd.askingPriceMinor).toBeLessThan(plain.askingPriceMinor);
    expect(ageFactor(oldest, BALANCE)).toBeGreaterThan(ageFactor(oldest + 1, BALANCE));
  });

  it('treats a negative age as new rather than throwing', () => {
    expect(ageFactor(-5, BALANCE)).toBe(1);
    expect(ageYearsBetween(new Date('2030-01-01'), new Date('2026-01-01'))).toBe(0);
  });
});

describe('utilisation', () => {
  const NARROWBODY = 'narrowbody' as const;

  it('is neutral for an airframe worked exactly as hard as its age suggests', () => {
    const hours = expectedHours(10, NARROWBODY, BALANCE);
    expect(utilisationFactor(hours, 10, NARROWBODY, BALANCE)).toBeCloseTo(1, 10);
  });

  it('discounts a hard-worked airframe and pays for a low-time one', () => {
    const expected = expectedHours(10, NARROWBODY, BALANCE);
    expect(utilisationFactor(expected * 1.3, 10, NARROWBODY, BALANCE)).toBeLessThan(1);
    expect(utilisationFactor(expected * 0.6, 10, NARROWBODY, BALANCE)).toBeGreaterThan(1);
  });

  it('stays inside its bounds however extreme the hours', () => {
    const [low, high] = BALANCE.depreciation.utilisationFactorBounds;
    expect(utilisationFactor(1_000_000, 10, NARROWBODY, BALANCE)).toBe(low);
    expect(utilisationFactor(0, 10, NARROWBODY, BALANCE)).toBe(high);
  });

  it('has nothing to say about a brand-new airframe', () => {
    // No expected hours to divide by. The age curve is the whole story, and this
    // must not become a division by zero.
    expect(utilisationFactor(0, 0, NARROWBODY, BALANCE)).toBe(1);
  });

  /**
   * The reason cycles are per class rather than per hour.
   *
   * A turboprop and a ULH widebody of the same age have wildly different
   * landing counts, and cycles are what a maintenance programme counts (M4-06).
   */
  it('gives a turboprop far more cycles than a ULH widebody for the same age', () => {
    const turboprop = cyclesForHours(
      expectedHours(12, 'turboprop_regional', BALANCE),
      'turboprop_regional',
      BALANCE,
    );
    const ulh = cyclesForHours(expectedHours(12, 'widebody_ulh', BALANCE), 'widebody_ulh', BALANCE);
    expect(turboprop).toBeGreaterThan(ulh * 4);
  });
});

describe('configuration — App. C.5, and M4-05 acceptance criterion 1', () => {
  it('is exactly 1 for a standard airframe', () => {
    const verdict = configurationFactor([], BALANCE);
    expect(verdict.factor).toBe(1);
    expect(verdict.drags).toEqual([]);
    expect(verdict.unusualness).toBe(0);
  });

  /**
   * **The headline criterion, as a property rather than an example.**
   *
   * *"An unusual configuration is visibly cheaper than a common one of the same
   * age."* Asserted for every type in the shipped catalogue against every
   * specialising option that type can carry — not one hand-picked pair — because
   * the whole point of anchoring on the type's list price rather than on
   * `list + options` is that this holds by construction. If a coefficient is
   * ever retuned into making an unusual airframe dearer, this fails.
   */
  it('prices every specialising option below a standard airframe of the same age, for every type', () => {
    const specialising: AircraftOptionCategory[] = [
      'fuel',
      'structural',
      'cabin',
      'engine',
      'cargo',
    ];
    let pairsChecked = 0;

    for (const type of TYPES) {
      const plain = priceOf(type, 8, []);
      for (const id of type.availableOptionIds) {
        const option = optionNamed(id);
        if (!specialising.includes(option.category)) continue;
        const optioned = priceOf(type, 8, [option]);
        expect(
          optioned.askingPriceMinor,
          `${type.designation} + ${id} (${option.category})`,
        ).toBeLessThan(plain.askingPriceMinor);
        pairsChecked += 1;
      }
    }

    // Guard against the assertion silently checking nothing if the catalogue's
    // availability rules ever narrow.
    expect(pairsChecked).toBeGreaterThan(30);
  });

  it('pays a premium for an option every operator wants', () => {
    const a321 = typeNamed('A321neo');
    const plain = priceOf(a321, 8, []);
    const winged = priceOf(a321, 8, [optionNamed('sharklets')]);
    expect(winged.askingPriceMinor).toBeGreaterThan(plain.askingPriceMinor);
    expect(winged.configuration.factor).toBeGreaterThan(1);
  });

  it('charges more for an option the buyer cannot undo', () => {
    const retrofittable = optionNamed('etops-180');
    const stuckWith = optionNamed('engine-variant-alt');
    expect(retrofittable.retrofittable).toBe(true);
    expect(stuckWith.retrofittable).toBe(false);

    // Same-category comparison is not available in v1's option set, so compare
    // each against its own category's raw drag instead.
    const drags = configurationFactor([stuckWith], BALANCE).drags;
    expect(drags[0]?.drag).toBeCloseTo(
      BALANCE.configuration.categoryDrag.engine * BALANCE.configuration.nonRetrofittableMultiplier,
      10,
    );
    expect(configurationFactor([retrofittable], BALANCE).drags[0]?.drag).toBeCloseTo(
      BALANCE.configuration.categoryDrag.avionics,
      10,
    );
  });

  it('stacks drags, and stays inside its bounds', () => {
    const [low, high] = BALANCE.configuration.factorBounds;
    const everything = AIRCRAFT_OPTIONS_V1;
    const verdict = configurationFactor(everything, BALANCE);
    expect(verdict.factor).toBeGreaterThanOrEqual(low);
    expect(verdict.factor).toBeLessThanOrEqual(high);
    expect(verdict.unusualness).toBe(1);
    expect(verdict.drags).toHaveLength(everything.length);
  });

  it('attributes every part of the discount to a named option', () => {
    const build = [
      optionNamed('act-3'),
      optionNamed('crew-rest'),
      optionNamed('engine-variant-alt'),
    ];
    const verdict = configurationFactor(build, BALANCE);
    const summed = verdict.drags.reduce((total, line) => total + line.drag, 0);
    expect(verdict.factor).toBeCloseTo(1 - summed, 10);
    expect(verdict.drags.map((d) => d.optionId)).toEqual(build.map((o) => o.id));
  });

  it('makes an unusual airframe linger and a plain one go quickly', () => {
    const plain = listingLifetimeDays(0, BALANCE);
    const odd = listingLifetimeDays(1, BALANCE);
    expect(plain).toBe(BALANCE.inventory.baseListingLifetimeDays);
    expect(odd).toBe(
      BALANCE.inventory.baseListingLifetimeDays + BALANCE.inventory.unusualLingerDays,
    );
    expect(odd).toBeGreaterThan(plain);
  });

  /**
   * The worked case from C.4's long-thin A321neo, priced second-hand.
   *
   * Not a fixed number — the coefficients are config and may be retuned — but
   * the *shape* is the claim C.5 makes, and it should be a big discount rather
   * than a rounding difference.
   */
  it('discounts C.4s long-thin build substantially against a standard airframe', () => {
    const a321 = typeNamed('A321neo');
    const plain = priceOf(a321, 8, []);
    const longThin = priceOf(a321, 8, [
      optionNamed('act-3'),
      optionNamed('crew-rest'),
      optionNamed('engine-variant-alt'),
    ]);
    const discount = 1 - longThin.askingPriceMinor / plain.askingPriceMinor;
    expect(discount).toBeGreaterThan(0.15);
  });
});

describe('the price explains itself', () => {
  it('reports every factor it multiplied', () => {
    const a321 = typeNamed('A321neo');
    const valuation = priceOf(a321, 8, [optionNamed('high-density-exits')]);

    expect(valuation.anchorMinor).toBe(a321.listPrice);
    expect(valuation.anchorSource).toBe('list_price');
    expect(valuation.ageYears).toBe(8);
    expect(valuation.configuration.drags).toHaveLength(1);

    const recomputed =
      valuation.anchorMinor *
      valuation.ageFactor *
      valuation.utilisationFactor *
      valuation.configuration.factor;
    expect(valuation.askingPriceMinor).toBe(Math.round(recomputed));
  });
});

describe('which types the market can offer', () => {
  const IN_2026 = new Date('2026-08-22T00:00:00.000Z');

  it('offers a type that is out of production but still flyable', () => {
    // C.2's "Used market only" row. Production ended in 2020, so it cannot be
    // ordered new, and the used market is the only way to get one.
    const window = buildWindow(candidateFor(typeNamed('737-800')), IN_2026, BALANCE);
    expect(window).not.toBeNull();
    expect(window?.latest.getTime()).toBeLessThanOrEqual(Date.parse('2020-01-01T00:00:00.000Z'));
  });

  it('offers nothing of a type too new to have had a previous owner', () => {
    // The A321XLR entered service in November 2024. In 2026 there is no example
    // two years old, so the type is simply absent — not listed at zero, not
    // listed as new.
    expect(buildWindow(candidateFor(typeNamed('A321XLR')), IN_2026, BALANCE)).toBeNull();
  });

  it('offers nothing of a type that has not entered service', () => {
    // The 777-9 has flown but has no EIS date in v1 — the prototype window.
    expect(buildWindow(candidateFor(typeNamed('777-9')), IN_2026, BALANCE)).toBeNull();
  });

  it('offers nothing before the type had flown at all', () => {
    const early = new Date('1990-01-01T00:00:00.000Z');
    for (const type of TYPES) {
      expect(buildWindow(candidateFor(type), early, BALANCE), type.designation).toBeNull();
    }
  });

  it('never proposes a build date outside the age band or before entry into service', () => {
    for (const type of TYPES) {
      const window = buildWindow(candidateFor(type), IN_2026, BALANCE);
      if (window === null) continue;
      const oldest = ageYearsBetween(window.earliest, IN_2026);
      const youngest = ageYearsBetween(window.latest, IN_2026);
      expect(oldest, type.designation).toBeLessThanOrEqual(BALANCE.inventory.maxAgeYears + 0.01);
      expect(youngest, type.designation).toBeGreaterThanOrEqual(
        BALANCE.inventory.minAgeYears - 0.01,
      );
      const eis = Date.parse(`${type.eraDates.entryIntoService ?? ''}T00:00:00.000Z`);
      expect(window.earliest.getTime(), type.designation).toBeGreaterThanOrEqual(eis);
    }
  });
});

describe('generations', () => {
  const EPOCH = new Date('2026-01-01T00:00:00.000Z');

  it('has not started before the world has', () => {
    expect(generationIndex(EPOCH, new Date('2025-12-25T00:00:00.000Z'), BALANCE)).toBe(-1);
  });

  it('advances once per interval of game days', () => {
    const interval = BALANCE.inventory.refreshIntervalDays;
    const day = (n: number) => new Date(EPOCH.getTime() + n * 86_400_000);
    expect(generationIndex(EPOCH, day(0), BALANCE)).toBe(0);
    expect(generationIndex(EPOCH, day(interval - 1), BALANCE)).toBe(0);
    expect(generationIndex(EPOCH, day(interval), BALANCE)).toBe(1);
    expect(generationIndex(EPOCH, day(interval * 5 + 2), BALANCE)).toBe(5);
  });
});

describe('drafting a listing', () => {
  const EPOCH = new Date('2020-01-01T00:00:00.000Z');
  const NOW = new Date('2026-08-22T00:00:00.000Z');

  const base = {
    worldSeed: 'seed-alpha',
    epoch: EPOCH,
    gameNow: NOW,
    candidates: TYPES.map(candidateFor),
    optionCatalogue: AIRCRAFT_OPTIONS_V1_BY_ID,
    locationCount: 12,
    balance: BALANCE,
  };

  it('produces the same aircraft for the same berth and generation, every time', () => {
    const first = draftUsedListing({ ...base, slotIndex: 3 });
    const second = draftUsedListing({ ...base, slotIndex: 3 });
    expect(first).not.toBeNull();
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  /**
   * The property `random.ts` is built for: a berth's occupant depends on which
   * berth it is, not on how many were drawn before it. Two workers racing, or a
   * refresh that skipped a berth, cannot change what berth 3 holds.
   */
  it('gives each berth its own stream', () => {
    const drafts = [0, 1, 2, 3, 4, 5].map((slotIndex) => draftUsedListing({ ...base, slotIndex }));
    const signatures = new Set(
      drafts.map((d) => `${d?.typeDesignation ?? ''}|${d?.builtAt.toISOString() ?? ''}`),
    );
    // Not all six need differ — two berths may legitimately draw the same type —
    // but they must not all be identical, which is what a shared stream would do.
    expect(signatures.size).toBeGreaterThan(1);
  });

  it('gives a different world a different market from the same berth', () => {
    const a = draftUsedListing({ ...base, slotIndex: 1 });
    const b = draftUsedListing({ ...base, worldSeed: 'seed-beta', slotIndex: 1 });
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(b));
  });

  it('offers nothing before the world has launched', () => {
    expect(
      draftUsedListing({ ...base, gameNow: new Date('2019-01-01T00:00:00.000Z'), slotIndex: 0 }),
    ).toBeNull();
  });

  it('offers nothing when it has nowhere to park the aircraft', () => {
    expect(draftUsedListing({ ...base, locationCount: 0, slotIndex: 0 })).toBeNull();
  });

  it('draws only aircraft the world could actually have, priced and specified', () => {
    for (let slot = 0; slot < 40; slot += 1) {
      const draft = draftUsedListing({ ...base, slotIndex: slot });
      if (draft === null) continue;

      const type = typeNamed(draft.typeDesignation);
      const age = ageYearsBetween(draft.builtAt, NOW);
      expect(age, draft.typeDesignation).toBeGreaterThanOrEqual(
        BALANCE.inventory.minAgeYears - 0.01,
      );
      expect(age, draft.typeDesignation).toBeLessThanOrEqual(BALANCE.inventory.maxAgeYears + 0.01);

      expect(draft.hours).toBeGreaterThanOrEqual(0);
      expect(draft.cycles).toBeGreaterThanOrEqual(0);
      expect(draft.valuation.askingPriceMinor).toBeGreaterThan(0);
      expect(draft.expiresAt.getTime()).toBeGreaterThan(NOW.getTime());
      expect(draft.locationIndex).toBeGreaterThanOrEqual(0);
      expect(draft.locationIndex).toBeLessThan(base.locationCount);

      // Every option is one this type can actually carry (C.6's availability),
      // and the spec is the M4-03 fold rather than the bare base spec.
      for (const id of draft.buildOptionIds) {
        expect(type.availableOptionIds, `${draft.typeDesignation} / ${id}`).toContain(id);
      }
      // MTOW rather than seats: C.2's three freighters carry `maxSeats: 0`, and
      // asserting on seats would have quietly required every drawn aircraft to
      // be a passenger one.
      expect(draft.effectiveSpec.mtowTonnes).toBeGreaterThan(0);
    }
  });

  it('keeps most airframes ordinary, so an unusual one means something', () => {
    const drafts = Array.from({ length: 120 }, (_unused, slotIndex) =>
      draftUsedListing({ ...base, slotIndex }),
    ).flatMap((d) => (d === null ? [] : [d]));

    expect(drafts.length).toBeGreaterThan(100);
    const plain = drafts.filter((d) => d.buildOptionIds.length === 0).length;
    // The option-count weights put ~40% at zero options. A market where nearly
    // everything were optioned would have no common configuration to compare an
    // unusual one against, which is C.5's whole contrast.
    expect(plain / drafts.length).toBeGreaterThan(0.25);
  });

  it('never proposes a build the catalogue would refuse', () => {
    for (let slot = 0; slot < 60; slot += 1) {
      const draft = draftUsedListing({ ...base, slotIndex: slot });
      if (draft === null) continue;
      // Conflicting options are skipped rather than emitted; duplicates are not
      // possible because each id is removed from the pool as it is drawn.
      expect(new Set(draft.buildOptionIds).size).toBe(draft.buildOptionIds.length);
      for (const id of draft.buildOptionIds) {
        const option = optionNamed(id);
        for (const conflict of option.conflictsWith) {
          expect(draft.buildOptionIds, `${id} vs ${conflict}`).not.toContain(conflict);
        }
      }
    }
  });
});
