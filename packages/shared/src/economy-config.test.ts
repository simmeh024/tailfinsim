import { describe, expect, it } from 'vitest';

import {
  FuelCurveBalance,
  canonicalEconomyJson,
  diffEconomyConfig,
  ECONOMY_CONFIG_V1,
  EconomyConfig,
  EconomyConfigVersion,
} from './economy-config';

/**
 * The economy payload as a contract (M3-11).
 *
 * Three things are being defended here, and they are the issue's three
 * acceptance criteria: the numbers exist in exactly one place, a payload can be
 * changed without a deploy, and any two versions can be compared field by field.
 */

/** A retune, built from the shipped payload rather than written out again. */
function retune(mutate: (draft: EconomyConfig) => void): EconomyConfig {
  const draft = EconomyConfig.parse(JSON.parse(JSON.stringify(ECONOMY_CONFIG_V1)));
  mutate(draft);
  return draft;
}

describe('the shipped payload', () => {
  it('carries App. A.3’s six coefficients verbatim', () => {
    // A.3's published table. If this ever fails, either the doc moved or
    // somebody retuned the seed rather than shipping a new version.
    const beta = ECONOMY_CONFIG_V1.demand.logit.beta;
    expect(beta.business.price).toBe(1.1);
    expect(beta.leisure.price).toBe(3.0);
    expect(beta.vfr.price).toBe(2.4);
    expect(beta.business.product).toBe(2.2);
    expect(beta.leisure.product).toBe(0.8);
    expect(beta.vfr.product).toBe(0.6);
  });

  it('keeps leisure far more price-sensitive than business', () => {
    // The ordering rather than the values: this is the property A.1's "no
    // dominant strategy" rests on, and it must survive any retune that keeps
    // the model honest. Stated as a relationship so it still means something
    // after the numbers move.
    const beta = ECONOMY_CONFIG_V1.demand.logit.beta;
    expect(beta.leisure.price).toBeGreaterThan(beta.business.price);
    expect(beta.business.product).toBeGreaterThan(beta.leisure.product);
    expect(beta.business.frequency).toBeGreaterThan(beta.leisure.frequency);
  });

  it('splits each segment’s cabin propensity into exactly one seat', () => {
    for (const [segment, row] of Object.entries(ECONOMY_CONFIG_V1.demand.classMix.propensity)) {
      const total = row.first + row.business + row.premium_economy + row.economy;
      expect(total, `${segment} propensity`).toBeCloseTo(1, 10);
    }
  });

  it('covers the booking horizon exactly once, summing to the whole demand', () => {
    const bands = ECONOMY_CONFIG_V1.demand.bookingCurve.bands;
    expect(bands.reduce((sum, b) => sum + b.share, 0)).toBeCloseTo(1, 10);

    const covered = new Set<number>();
    for (const band of bands) {
      for (let day = band.toDaysOut; day <= band.fromDaysOut; day += 1) {
        expect(covered.has(day), `day ${String(day)} covered twice`).toBe(false);
        covered.add(day);
      }
    }
    expect(covered.size).toBe(14);
  });
});

describe('a payload written before a section existed', () => {
  it('still loads, taking the shipped default for the missing section', () => {
    // The failure this prevents is total rather than partial. `economy_config`
    // rows are immutable and are parsed on the way *out*, so a required new
    // section makes every earlier payload unparseable — and a world pinned to
    // one cannot price a flight, found an airline or draw a fare floor.
    //
    // M3-12 added `npc` and dev found out on the first economy read after the
    // deploy. A new section is an expand-shaped change and must arrive with a
    // default, exactly as `ADD COLUMN … DEFAULT` does for the database.
    const { npc: _npc, ...beforeNpcExisted } = ECONOMY_CONFIG_V1;

    const parsed = EconomyConfig.parse(beforeNpcExisted);
    expect(parsed.npc).toEqual(ECONOMY_CONFIG_V1.npc);
  });

  it('takes the shipped used market when a pre-M4-05 payload is read back', () => {
    // The same rule, one section later. Every `v1` row already in dev and
    // production was written before `usedMarket` existed; if this default were
    // missing, the first economy read after the deploy would throw and take
    // flight pricing, airline founding and the fare floor down with it.
    const { usedMarket: _usedMarket, ...beforeUsedMarketExisted } = ECONOMY_CONFIG_V1;

    const parsed = EconomyConfig.parse(beforeUsedMarketExisted);
    expect(parsed.usedMarket).toEqual(ECONOMY_CONFIG_V1.usedMarket);
  });

  it('takes the shipped maintenance programmes when a pre-M4-06 payload is read back', () => {
    // Third time the same rule has been needed, and it is now the pattern rather
    // than an exception: a new section arrives defaulted or it is a new version.
    const { maintenance: _maintenance, ...beforeMaintenanceExisted } = ECONOMY_CONFIG_V1;

    const parsed = EconomyConfig.parse(beforeMaintenanceExisted);
    expect(parsed.maintenance).toEqual(ECONOMY_CONFIG_V1.maintenance);
  });

  it('takes the shipped social media balance when a pre-specialist payload is read back', () => {
    // The same rule again (M5-04 follow-up). Every `v1` row written before the
    // social media specialist existed has no `socialMedia` section; without this
    // default the first economy read after the deploy would throw and take flight
    // pricing and the fare floor down with it, exactly as M3-12 did with `npc`.
    const { socialMedia: _socialMedia, ...beforeSocialMediaExisted } = ECONOMY_CONFIG_V1;

    const parsed = EconomyConfig.parse(beforeSocialMediaExisted);
    expect(parsed.socialMedia).toEqual(ECONOMY_CONFIG_V1.socialMedia);
  });

  it('takes the shipped hub curve when a pre-M7-04 payload is read back', () => {
    // The same rule again (M7-04). A `v1` row written before the hub purchase curve
    // existed has no `hubs` section; the default fills it so the world still prices
    // a hub rather than throwing on the first read.
    const { hubs: _hubs, ...beforeHubsExisted } = ECONOMY_CONFIG_V1;

    const parsed = EconomyConfig.parse(beforeHubsExisted);
    expect(parsed.hubs).toEqual(ECONOMY_CONFIG_V1.hubs);
  });

  it('keeps a section the payload does carry, rather than defaulting over it', () => {
    // A default fills an absence. It must never overwrite a live retune —
    // which is the property the whole seed-but-never-update design rests on.
    const retuned = retune((draft) => {
      draft.npc.behaviour.entryMarginThreshold = 0.21;
    });

    const parsed = EconomyConfig.parse(JSON.parse(JSON.stringify(retuned)));
    expect(parsed.npc.behaviour.entryMarginThreshold).toBe(0.21);
  });
});

describe('what the schema refuses', () => {
  it('refuses a version name that could not be a URL segment', () => {
    for (const bad of ['', 'v 2', 'V2', 'v2/../v1', 'a'.repeat(65)]) {
      expect(EconomyConfigVersion.safeParse(bad).success, bad).toBe(false);
    }
    for (const good of ['v1', 'v2', '2026-08-autumn-retune', 'canary.3', 'sandbox_1']) {
      expect(EconomyConfigVersion.safeParse(good).success, good).toBe(true);
    }
  });

  it('refuses a day-of-week table that is not seven days long', () => {
    const short = JSON.parse(JSON.stringify(ECONOMY_CONFIG_V1)) as EconomyConfig;
    short.demand.modulation.dayOfWeek.business = [1, 1, 1];
    expect(EconomyConfig.safeParse(short).success).toBe(false);
  });

  it('refuses a schedule curve that is not twenty-four hours long', () => {
    // The curve is indexed by hour. A 23-entry curve would read `undefined` at
    // 23:00 and produce a NaN utility for every late departure in the world.
    const short = JSON.parse(JSON.stringify(ECONOMY_CONFIG_V1)) as EconomyConfig;
    short.demand.schedFit.curve.leisure = short.demand.schedFit.curve.leisure.slice(0, 23);
    expect(EconomyConfig.safeParse(short).success).toBe(false);
  });

  it('refuses money that is not an integer number of minor units', () => {
    const fractional = JSON.parse(JSON.stringify(ECONOMY_CONFIG_V1)) as EconomyConfig;
    fractional.costs.settlement.crewCostPerBlockHourMinor = 19_500.5;
    expect(EconomyConfig.safeParse(fractional).success).toBe(false);
  });

  it('refuses a month that is not a month', () => {
    const bad = JSON.parse(JSON.stringify(ECONOMY_CONFIG_V1)) as EconomyConfig;
    (bad.demand.modulation.holidayMonths as number[])[0] = 13;
    expect(EconomyConfig.safeParse(bad).success).toBe(false);
  });

  it('refuses a boost ceiling above 100%', () => {
    // A ceiling over 1 would mean a stack of boosts could remove more than all
    // of a cost, which is negative fuel.
    const bad = JSON.parse(JSON.stringify(ECONOMY_CONFIG_V1)) as EconomyConfig;
    bad.boosts.ceilings.fuelBurn = 1.5;
    expect(EconomyConfig.safeParse(bad).success).toBe(false);
  });
});

describe('diffing two versions', () => {
  it('finds nothing between a payload and itself', () => {
    expect(diffEconomyConfig(ECONOMY_CONFIG_V1, ECONOMY_CONFIG_V1)).toEqual([]);
  });

  it('reports one row per changed leaf, not per enclosing object', () => {
    const after = retune((draft) => {
      draft.version = 'v2';
      draft.demand.logit.beta.leisure.price = 2.6;
    });

    const changes = diffEconomyConfig(ECONOMY_CONFIG_V1, after);
    expect(changes).toEqual([
      { path: 'version', before: 'v1', after: 'v2' },
      { path: 'demand.logit.beta.leisure.price', before: 3.0, after: 2.6 },
    ]);
  });

  it('addresses array elements by index', () => {
    const after = retune((draft) => {
      draft.demand.bookingCurve.bands[0]!.share = 0.2;
    });

    expect(diffEconomyConfig(ECONOMY_CONFIG_V1, after)).toEqual([
      { path: 'demand.bookingCurve.bands[0].share', before: 0.15, after: 0.2 },
    ]);
  });

  it('reports a longer array as added elements rather than as one big change', () => {
    const after = retune((draft) => {
      draft.demand.modulation.holidayMonths = [1, 12];
    });

    const changes = diffEconomyConfig(ECONOMY_CONFIG_V1, after);
    expect(changes).toEqual([
      { path: 'demand.modulation.holidayMonths[0]', before: 12, after: 1 },
      { path: 'demand.modulation.holidayMonths[1]', before: undefined, after: 12 },
    ]);
  });

  it('is not fooled by key order', () => {
    // The whole reason the diff walks the structure rather than comparing text:
    // a payload that round-tripped through a different key order is the same
    // config, and a diff that claimed otherwise would be one nobody trusted.
    const reordered = EconomyConfig.parse(
      JSON.parse(canonicalEconomyJson(ECONOMY_CONFIG_V1)) as unknown,
    );
    expect(diffEconomyConfig(ECONOMY_CONFIG_V1, reordered)).toEqual([]);
  });
});

describe('the canonical form', () => {
  it('produces one byte sequence for two equal payloads', () => {
    // Reversed from the payload's own key order rather than listed section by
    // section: a hand-written list stops reordering anything the moment a new
    // section is added, and does so silently.
    const reordered = EconomyConfig.parse(
      Object.fromEntries(Object.entries(ECONOMY_CONFIG_V1).reverse()),
    );

    expect(canonicalEconomyJson(reordered)).toBe(canonicalEconomyJson(ECONOMY_CONFIG_V1));
  });

  it('changes when a single coefficient changes', () => {
    const after = retune((draft) => {
      draft.demand.logit.beta.business.price = 1.2;
    });
    expect(canonicalEconomyJson(after)).not.toBe(canonicalEconomyJson(ECONOMY_CONFIG_V1));
  });

  it('keeps array order, because an array’s order is data', () => {
    // Sorting keys is safe; sorting a booking band table or a 24-hour curve
    // would silently rewrite the model.
    const parsed = JSON.parse(canonicalEconomyJson(ECONOMY_CONFIG_V1)) as EconomyConfig;
    expect(parsed.demand.schedFit.curve.business).toEqual(
      ECONOMY_CONFIG_V1.demand.schedFit.curve.business,
    );
    expect(parsed.demand.bookingCurve.bands.map((b) => b.fromDaysOut)).toEqual([14, 7, 2]);
  });
});

describe('the fuel curve clamp (BUG-05)', () => {
  /**
   * `minFactor` and `maxFactor` were each validated as positive and never
   * against each other. Transposing them is a plausible slip in a hand-written
   * retune and it fails silently rather than loudly: `min(max, max(min, f))`
   * with the pair the wrong way round returns `maxFactor` for every instant, so
   * §11's curve stops moving and the world's fuel price freezes. Nothing refused
   * the write and no counter showed it.
   */
  const curve = ECONOMY_CONFIG_V1.fuel.curve;

  it('accepts an ordered pair', () => {
    expect(FuelCurveBalance.safeParse({ ...curve, minFactor: 0.5, maxFactor: 2 }).success).toBe(
      true,
    );
  });

  it('accepts a degenerate pair, which is a legitimate flat clamp', () => {
    expect(FuelCurveBalance.safeParse({ ...curve, minFactor: 1, maxFactor: 1 }).success).toBe(true);
  });

  it('refuses a transposed pair, naming what is wrong', () => {
    const result = FuelCurveBalance.safeParse({ ...curve, minFactor: 1.2, maxFactor: 0.9 });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues[0]?.message).toMatch(/ordered/);
  });

  it('refuses it through the whole payload too, not only the section', () => {
    // The section is reached through `EconomyConfig`, and a refinement that only
    // fires when the schema is used directly would never fire in production.
    const payload = JSON.parse(JSON.stringify(ECONOMY_CONFIG_V1)) as {
      fuel: { curve: { minFactor: number; maxFactor: number } };
    };
    payload.fuel.curve.minFactor = 1.2;
    payload.fuel.curve.maxFactor = 0.9;
    expect(EconomyConfig.safeParse(payload).success).toBe(false);
  });

  it('leaves the shipped payload parseable', () => {
    expect(EconomyConfig.safeParse(ECONOMY_CONFIG_V1).success).toBe(true);
  });
});
