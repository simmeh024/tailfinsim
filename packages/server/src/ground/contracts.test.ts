import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import type { AirportTier } from '@tailfin/shared';

import { createDatabase, type DatabaseHandle } from '../db/client';
import { airport } from '../db/schema';
import {
  createFoundedAirlineFixtureHarness,
  type FoundedAirlineFixture,
  type FoundedAirlineFixtureHarness,
} from '../test-fixtures/founded-airline';

import { contractedGrade, readStation, signContract } from './contracts';

import type { ResolvedPlayerAirline } from '../airline/context';

/**
 * Ground handling contracts (M5-06, §9.3).
 *
 * The two rules that make ground ops a shared world: one active handler per
 * service line at a station, and a vendor's finite capacity that competing
 * airlines can exhaust. Requires `DATABASE_URL`; CI provides it.
 */

const url = process.env.DATABASE_URL;
if (!url) console.warn('\n  [ground/contracts.test] DATABASE_URL not set — skipping.\n');
const describeDb = url ? describe : describe.skip;

function own(fixture: FoundedAirlineFixture): ResolvedPlayerAirline {
  return { id: fixture.airline.id, worldId: fixture.world.id, status: 'active' };
}

describeDb('ground contracts', () => {
  let db: DatabaseHandle;
  let fixtures: FoundedAirlineFixtureHarness;
  const madeAirports: string[] = [];
  let seq = 0;

  beforeAll(() => {
    db = createDatabase();
    fixtures = createFoundedAirlineFixtureHarness(db.db);
  });

  afterEach(async () => {
    await fixtures.cleanup();
  });

  afterAll(async () => {
    for (const id of madeAirports.splice(0)) {
      await db.db.delete(airport).where(eq(airport.id, id));
    }
    await db.close();
  });

  async function makeAirport(icao: string, tier: AirportTier): Promise<string> {
    const n = seq++;
    const [created] = await db.db
      .insert(airport)
      .values({
        sourceId: -(9_700_000 + n),
        ident: icao,
        icaoCode: icao,
        name: `Ground Test ${icao}`,
        isoCountry: 'US',
        kind: 'large_airport',
        latitude: 5,
        longitude: -60 - n,
        scheduledService: true,
        hasRunwayData: false,
        tier,
        elevationFt: 0,
      })
      .returning({ id: airport.id });
    if (!created) throw new Error(`no airport ${icao}`);
    madeAirports.push(created.id);
    return icao;
  }

  it('lists a flagship’s vendors — all three grades, nothing contracted', async () => {
    const a = await fixtures.create();
    const icao = await makeAirport('GFLG', 'flagship');
    const station = await readStation(db.db, own(a), icao);
    const ramp = station?.lines.find((l) => l.serviceLine === 'ramp_baggage');
    expect(ramp?.offers.map((o) => o.grade)).toEqual(['budget', 'standard', 'premium']);
    expect(ramp?.contracted).toBeNull();
  });

  it('reports an unknown station rather than inventing one', async () => {
    const a = await fixtures.create();
    expect(await readStation(db.db, own(a), 'ZZZZ')).toBeNull();
  });

  it('signs a handler and reflects it in the station and the lookup', async () => {
    const a = await fixtures.create();
    const icao = await makeAirport('GSTD', 'flagship');
    const result = await signContract(db.db, own(a), icao, {
      serviceLine: 'ramp_baggage',
      grade: 'standard',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const ramp = result.station.lines.find((l) => l.serviceLine === 'ramp_baggage');
      expect(ramp?.contracted?.grade).toBe('standard');
    }
    expect(await contractedGrade(db.db, a.airline.id, icao, 'ramp_baggage')).toBe('standard');
  });

  it('holds one handler per line — switching grades replaces it', async () => {
    const a = await fixtures.create();
    const icao = await makeAirport('GSWP', 'flagship');
    await signContract(db.db, own(a), icao, { serviceLine: 'ramp_baggage', grade: 'standard' });
    const result = await signContract(db.db, own(a), icao, {
      serviceLine: 'ramp_baggage',
      grade: 'premium',
    });
    expect(result.ok).toBe(true);
    expect(await contractedGrade(db.db, a.airline.id, icao, 'ramp_baggage')).toBe('premium');
    // The incumbent's slot was freed: only the premium is taken now.
    if (result.ok) {
      const ramp = result.station.lines.find((l) => l.serviceLine === 'ramp_baggage');
      expect(ramp?.offers.find((o) => o.grade === 'standard')?.taken).toBe(0);
      expect(ramp?.offers.find((o) => o.grade === 'premium')?.taken).toBe(1);
    }
  });

  it('refuses a grade the station does not offer', async () => {
    const a = await fixtures.create();
    const icao = await makeAirport('GRGN', 'regional'); // regional offers only budget
    expect(
      await signContract(db.db, own(a), icao, { serviceLine: 'ramp_baggage', grade: 'premium' }),
    ).toEqual({
      ok: false,
      code: 'grade_not_offered',
    });
  });

  it('exhausts a scarce vendor when airlines compete for it', async () => {
    const first = await fixtures.create();
    const icao = await makeAirport('GCAP', 'regional'); // budget capacity is small
    const airlines = [first];
    for (let i = 0; i < 5; i += 1) {
      airlines.push(await fixtures.create({ worldId: first.world.id }));
    }

    let signed = 0;
    let exhausted = 0;
    for (const fixture of airlines) {
      const result = await signContract(db.db, own(fixture), icao, {
        serviceLine: 'ramp_baggage',
        grade: 'budget',
      });
      if (result.ok) signed += 1;
      else if (result.code === 'capacity_exhausted') exhausted += 1;
    }

    // Six airlines against a handful of slots: some get in, the rest are shut out.
    expect(signed).toBeGreaterThanOrEqual(1);
    expect(exhausted).toBeGreaterThanOrEqual(1);
    expect(signed + exhausted).toBe(6);
  });
});
