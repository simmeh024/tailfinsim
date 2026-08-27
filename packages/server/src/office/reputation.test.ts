import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase, type DatabaseHandle } from '../db/client';
import { airline, officeHire, socialMediaReputationGrant } from '../db/schema';
import {
  createFoundedAirlineFixtureHarness,
  type FoundedAirlineFixtureHarness,
  type FoundedAirlineFixture,
} from '../test-fixtures/founded-airline';

import { reviewSocialMediaReputation } from './reputation';

/**
 * The social media specialist's monthly reputation drip (M5-04 follow-up, §15).
 *
 * The mechanism the worker runs, tested in isolation from the tick loop: a
 * hired reputation specialist lifts `airline.reputation` a little each game
 * month, once and only once, clamped at the ceiling, and only when the airline
 * actually employs *that* specialist.
 *
 * The hire is inserted directly rather than founded, because the offered
 * specialist is a per-world hash and this test cares about the sweep, not about
 * which of the two a given world puts on the market — the airline itself is
 * still founded through the fixture, never inserted.
 */

const url = process.env.DATABASE_URL;
if (!url) console.warn('\n  [reputation.test] DATABASE_URL not set — skipping.\n');
const describeDb = url ? describe : describe.skip;

/** Reputation stored as `numeric(3,2)`; the driver hands it back as a string. */
async function reputationOf(db: DatabaseHandle, airlineId: string): Promise<number> {
  const [row] = await db.db
    .select({ reputation: airline.reputation })
    .from(airline)
    .where(eq(airline.id, airlineId))
    .limit(1);
  if (!row) throw new Error(`no airline ${airlineId}`);
  return Number.parseFloat(row.reputation);
}

async function setReputation(db: DatabaseHandle, airlineId: string, value: number): Promise<void> {
  await db.db
    .update(airline)
    .set({ reputation: value.toFixed(2) })
    .where(eq(airline.id, airlineId));
}

/** Put a specialist on staff, straight into a neutral seat. */
async function employSpecialist(
  db: DatabaseHandle,
  fixture: FoundedAirlineFixture,
  candidateId: string,
): Promise<void> {
  await db.db.insert(officeHire).values({
    worldId: fixture.world.id,
    airlineId: fixture.airline.id,
    role: 'neutral-1',
    candidateId,
    candidateName: 'Specialist',
    monthlySalaryMinor: 1_500_000,
  });
}

describeDb('the reputation drip, on the database', () => {
  let db: DatabaseHandle;
  let fixtures: FoundedAirlineFixtureHarness;

  // Any two consecutive game months; the sweep grants for the month that closed.
  const inJan = new Date('2000-02-15T00:00:00.000Z');
  const inFeb = new Date('2000-03-15T00:00:00.000Z');

  beforeAll(() => {
    db = createDatabase();
    fixtures = createFoundedAirlineFixtureHarness(db.db);
  });

  afterEach(async () => {
    await fixtures.cleanup();
  });

  afterAll(async () => {
    await db.close();
  });

  it('adds the configured reputation for an airline with the reputation specialist', async () => {
    const fixture = await fixtures.create();
    await setReputation(db, fixture.airline.id, 0.4);
    await employSpecialist(db, fixture, 'social-media-reputation');

    const result = await reviewSocialMediaReputation(db.db, fixture.world.id, inJan);

    expect(result.airlinesGranted).toBe(1);
    expect(result.totalApplied).toBeCloseTo(0.05, 10);
    expect(await reputationOf(db, fixture.airline.id)).toBeCloseTo(0.45, 10);

    const grants = await db.db
      .select({ period: socialMediaReputationGrant.period })
      .from(socialMediaReputationGrant)
      .where(eq(socialMediaReputationGrant.airlineId, fixture.airline.id));
    expect(grants).toEqual([{ period: '2000-01' }]);
  });

  it('is idempotent — a second sweep in the same month adds nothing more', async () => {
    const fixture = await fixtures.create();
    await setReputation(db, fixture.airline.id, 0.4);
    await employSpecialist(db, fixture, 'social-media-reputation');

    await reviewSocialMediaReputation(db.db, fixture.world.id, inJan);
    const second = await reviewSocialMediaReputation(db.db, fixture.world.id, inJan);

    expect(second.airlinesGranted).toBe(0);
    expect(await reputationOf(db, fixture.airline.id)).toBeCloseTo(0.45, 10);
  });

  it('drips again once a new month has closed', async () => {
    const fixture = await fixtures.create();
    await setReputation(db, fixture.airline.id, 0.4);
    await employSpecialist(db, fixture, 'social-media-reputation');

    await reviewSocialMediaReputation(db.db, fixture.world.id, inJan);
    const next = await reviewSocialMediaReputation(db.db, fixture.world.id, inFeb);

    expect(next.airlinesGranted).toBe(1);
    expect(await reputationOf(db, fixture.airline.id)).toBeCloseTo(0.5, 10);
  });

  it('clamps at the 1.00 ceiling and records what it actually applied', async () => {
    const fixture = await fixtures.create();
    await setReputation(db, fixture.airline.id, 0.99);
    await employSpecialist(db, fixture, 'social-media-reputation');

    const result = await reviewSocialMediaReputation(db.db, fixture.world.id, inJan);

    // The airline still counts as granted for the month, but only 0.01 fit under
    // the ceiling, and that — not the nominal 0.05 — is what the record shows.
    expect(result.airlinesGranted).toBe(1);
    expect(result.totalApplied).toBeCloseTo(0.01, 10);
    expect(await reputationOf(db, fixture.airline.id)).toBeCloseTo(1, 10);

    const [grant] = await db.db
      .select({ amount: socialMediaReputationGrant.amount })
      .from(socialMediaReputationGrant)
      .where(
        and(
          eq(socialMediaReputationGrant.airlineId, fixture.airline.id),
          eq(socialMediaReputationGrant.period, '2000-01'),
        ),
      );
    expect(Number.parseFloat(grant?.amount ?? '')).toBeCloseTo(0.01, 10);
  });

  it('leaves an airline whose specialist is the attractiveness one untouched', async () => {
    const fixture = await fixtures.create();
    await setReputation(db, fixture.airline.id, 0.4);
    await employSpecialist(db, fixture, 'social-media-attractiveness');

    const result = await reviewSocialMediaReputation(db.db, fixture.world.id, inJan);

    expect(result.airlinesGranted).toBe(0);
    expect(await reputationOf(db, fixture.airline.id)).toBeCloseTo(0.4, 10);
  });

  it('leaves an airline with no specialist untouched', async () => {
    const fixture = await fixtures.create();
    await setReputation(db, fixture.airline.id, 0.4);

    const result = await reviewSocialMediaReputation(db.db, fixture.world.id, inJan);

    expect(result.airlinesGranted).toBe(0);
    expect(await reputationOf(db, fixture.airline.id)).toBeCloseTo(0.4, 10);
  });
});
