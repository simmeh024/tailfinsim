import { randomUUID } from 'node:crypto';

import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import type { AirportTier, HandlerGrade } from '@tailfin/shared';
import { realTimeAtGameTime, type WorldClock } from '@tailfin/sim';

import { createDatabase, type DatabaseHandle } from '../db/client';
import { airport, world } from '../db/schema';
import { rollGroundDisruption } from '../flight/disruption';
import {
  createFoundedAirlineFixtureHarness,
  type FoundedAirlineFixture,
  type FoundedAirlineFixtureHarness,
} from '../test-fixtures/founded-airline';

import {
  contractedGrade,
  expireGroundContracts,
  listAirlineContracts,
  readStation,
  signContract,
} from './contracts';

import type { ResolvedPlayerAirline } from '../airline/context';

const DAY = 86_400_000;

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

  it('a cheaper ramp handler never fixes a flight a better one would have broken', async () => {
    // The disruption effect (M5-06 → M5-05's loop), proved deterministically: the
    // roll is a pure function of the flight's own stream, so the set of flights a
    // budget handler disrupts is a *superset* of what premium disrupts — a worse
    // handler only ever adds disruptions, it never removes them.
    const a = await fixtures.create();
    const icao = await makeAirport('GVND', 'flagship');
    // Enough flights that the band between budget's and premium's odds is very
    // unlikely to be empty — the strict-difference assertion below stays robust.
    const flightIds = Array.from({ length: 200 }, () => randomUUID());

    const disruptedUnder = async (grade: HandlerGrade): Promise<Set<string>> => {
      await signContract(db.db, own(a), icao, { serviceLine: 'ramp_baggage', grade });
      const disrupted = new Set<string>();
      for (const flightId of flightIds) {
        const roll = await rollGroundDisruption(db.db, {
          flightId,
          worldId: a.world.id,
          airframeId: randomUUID(), // no airframe row: technical risk 0, so only the handler moves the odds
          airlineId: a.airline.id,
          originIcao: icao,
        });
        if (roll !== null) disrupted.add(flightId);
      }
      return disrupted;
    };

    const budget = await disruptedUnder('budget');
    const premium = await disruptedUnder('premium');

    for (const flightId of premium) {
      expect(budget.has(flightId)).toBe(true);
    }
    // And on this batch the budget handler is strictly worse, as it should be.
    expect(budget.size).toBeGreaterThan(premium.size);
  });

  async function clockOf(worldId: string): Promise<WorldClock> {
    const [row] = await db.db
      .select({
        epoch: world.epoch,
        launchDate: world.launchDate,
        speedMultiplier: world.speedMultiplier,
      })
      .from(world)
      .where(eq(world.id, worldId))
      .limit(1);
    if (!row) throw new Error(`no world ${worldId}`);
    return {
      epoch: row.epoch,
      launchDate: row.launchDate,
      speedMultiplier: Number(row.speedMultiplier),
    };
  }

  function contractedTermEnd(
    result: Awaited<ReturnType<typeof signContract>>,
    serviceLine: 'ramp_baggage' | 'fuelling',
  ): Date {
    if (!result.ok) throw new Error('expected the contract to be signed');
    const line = result.station.lines.find((l) => l.serviceLine === serviceLine);
    const termEnd = line?.contracted?.termEnd;
    if (!termEnd) throw new Error('expected a term end');
    return new Date(termEnd);
  }

  it('signs with a term the station view carries, not yet expiring', async () => {
    const a = await fixtures.create();
    const icao = await makeAirport('GTRM', 'flagship');
    const result = await signContract(db.db, own(a), icao, {
      serviceLine: 'ramp_baggage',
      grade: 'standard',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const ramp = result.station.lines.find((l) => l.serviceLine === 'ramp_baggage');
      expect(ramp?.contracted?.termEnd).toBeTruthy();
      // A full term still to run — nothing to warn about yet.
      expect(ramp?.contracted?.expiring).toBe(false);
    }
  });

  it('lapses a contract at term end and frees the vendor slot', async () => {
    const a = await fixtures.create();
    const icao = await makeAirport('GEXP', 'flagship');
    const signed = await signContract(db.db, own(a), icao, {
      serviceLine: 'ramp_baggage',
      grade: 'standard',
    });
    const termEnd = contractedTermEnd(signed, 'ramp_baggage');

    // Nothing lapses while the term still has a day to run.
    const before = await expireGroundContracts(
      db.db,
      a.world.id,
      new Date(termEnd.getTime() - DAY),
    );
    expect(before.expired).toBe(0);

    // Once past the term it lapses.
    const after = await expireGroundContracts(db.db, a.world.id, new Date(termEnd.getTime() + DAY));
    expect(after.expired).toBe(1);

    // Back to walk-up handling, and the slot it held is free again.
    expect(await contractedGrade(db.db, a.airline.id, icao, 'ramp_baggage')).toBeNull();
    const station = await readStation(db.db, own(a), icao);
    const ramp = station?.lines.find((l) => l.serviceLine === 'ramp_baggage');
    expect(ramp?.contracted).toBeNull();
    expect(ramp?.offers.find((o) => o.grade === 'standard')?.taken).toBe(0);
  });

  it('flags a contract as expiring inside the warning window', async () => {
    const a = await fixtures.create();
    const icao = await makeAirport('GWRN', 'flagship');
    const clock = await clockOf(a.world.id);
    const signed = await signContract(db.db, own(a), icao, {
      serviceLine: 'ramp_baggage',
      grade: 'standard',
    });
    const termEnd = contractedTermEnd(signed, 'ramp_baggage');

    // The real instant at which the world clock reads three game days before the term.
    const realNow = realTimeAtGameTime(clock, new Date(termEnd.getTime() - 3 * DAY));
    const station = await readStation(db.db, own(a), icao, realNow);
    const ramp = station?.lines.find((l) => l.serviceLine === 'ramp_baggage');
    expect(ramp?.contracted?.expiring).toBe(true);
  });

  it('lists an airline’s contracts across stations, flagging the expiring ones', async () => {
    const a = await fixtures.create();
    const one = await makeAirport('GLA1', 'flagship');
    const two = await makeAirport('GLA2', 'flagship');
    const clock = await clockOf(a.world.id);
    await signContract(db.db, own(a), one, { serviceLine: 'ramp_baggage', grade: 'standard' });
    const signedTwo = await signContract(db.db, own(a), two, {
      serviceLine: 'fuelling',
      grade: 'standard',
    });
    const termEndTwo = contractedTermEnd(signedTwo, 'fuelling');

    const realNow = realTimeAtGameTime(clock, new Date(termEndTwo.getTime() - 3 * DAY));
    const { contracts } = await listAirlineContracts(db.db, own(a), realNow);
    expect(contracts.map((c) => c.icao).sort()).toEqual(['GLA1', 'GLA2']);
    // Both terms are the same length and signed together, so both are expiring now.
    expect(contracts.every((c) => c.expiring)).toBe(true);
  });
});
