import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { EXECUTIVE_CANDIDATES, EXECUTIVE_OFFICE_COSTS_MINOR } from '@tailfin/shared';

import { moveAirlineCash } from '../airline/cash';
import { createDatabase, type DatabaseHandle } from '../db/client';
import { airline, executiveFloor } from '../db/schema';
import {
  createFoundedAirlineFixtureHarness,
  type FoundedAirlineFixtureHarness,
  type FoundedAirlineFixture,
} from '../test-fixtures/founded-airline';

import {
  dismissExecutive,
  hireExecutive,
  readExecutiveFloor,
  unlockExecutiveFloor,
  unlockExecutiveOffice,
} from './executive';

import type { ResolvedPlayerAirline } from '../airline/context';

/**
 * The executive floor, on the database (§9.1 follow-up).
 *
 * The floor's own two gates and the office cascade — the money paths. The
 * revenue gate is exercised by its refusal (an airline with no flights earns
 * nothing, so it is turned away); a fixture that seeds real flight revenue to
 * prove the *successful* floor unlock is a follow-up. The office cascade is
 * proved end to end by seeding an open floor and buying offices in sequence,
 * which is where the charging and the ordering live.
 */

const url = process.env.DATABASE_URL;
if (!url) console.warn('\n  [executive.test] DATABASE_URL not set — skipping.\n');
const describeDb = url ? describe : describe.skip;

function own(fixture: FoundedAirlineFixture): ResolvedPlayerAirline {
  return { id: fixture.airline.id, worldId: fixture.world.id, status: 'active' };
}

describeDb('the executive floor, on the database', () => {
  let db: DatabaseHandle;
  let fixtures: FoundedAirlineFixtureHarness;

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

  /** Add cash the one way cash moves — an AIR-06 movement, so the ledger reconciles. */
  async function fund(airlineId: string, amountMinor: number): Promise<void> {
    await db.db.transaction((tx) =>
      moveAirlineCash(tx, {
        airlineId,
        amountMinor,
        cause: 'admin_adjustment',
        reference: `test-fund:${airlineId}`,
        occurredAt: new Date('2024-01-01T00:00:00.000Z'),
      }),
    );
  }

  async function cashOf(airlineId: string): Promise<number> {
    const [row] = await db.db
      .select({ cashMinor: airline.cashMinor })
      .from(airline)
      .where(eq(airline.id, airlineId))
      .limit(1);
    return row?.cashMinor ?? 0;
  }

  /** Open the floor without going through the revenue gate — for the office tests. */
  async function seedOpenFloor(fixture: FoundedAirlineFixture, offices = 0): Promise<void> {
    await db.db.insert(executiveFloor).values({
      worldId: fixture.world.id,
      airlineId: fixture.airline.id,
      officesUnlocked: offices,
    });
  }

  it('reads a closed floor by default', async () => {
    const a = await fixtures.create();
    const state = await readExecutiveFloor(db.db, own(a));
    expect(state.unlocked).toBe(false);
    expect(state.officesUnlocked).toBe(0);
    expect(state.nextOffice).toBeNull();
    expect(state.monthlyRevenueMinor).toBe(0);
  });

  it('refuses to open the floor for an airline that is not earning enough', async () => {
    const a = await fixtures.create();
    // Cash is not the problem — revenue is. A freshly founded airline has flown
    // nothing, so its trailing revenue is zero, well under the gate.
    await fund(a.airline.id, 1_000_000_000_000);
    const result = await unlockExecutiveFloor(db.db, own(a));
    expect(result).toEqual({ ok: false, code: 'revenue_too_low' });
    expect(await readExecutiveFloor(db.db, own(a))).toMatchObject({ unlocked: false });
  });

  it('refuses to open an office before the floor is open', async () => {
    const a = await fixtures.create();
    await fund(a.airline.id, 1_000_000_000_000);
    const result = await unlockExecutiveOffice(db.db, own(a));
    expect(result).toEqual({ ok: false, code: 'floor_locked' });
  });

  it('buys executive offices in sequence, charging the rising cost each time', async () => {
    const a = await fixtures.create();
    await seedOpenFloor(a);
    await fund(a.airline.id, 100_000_000_000); // +$1B

    const before1 = await cashOf(a.airline.id);
    const first = await unlockExecutiveOffice(db.db, own(a));
    expect(first.ok).toBe(true);
    expect(first.ok && first.state.officesUnlocked).toBe(1);
    expect(await cashOf(a.airline.id)).toBe(before1 - EXECUTIVE_OFFICE_COSTS_MINOR[0]!);

    const before2 = await cashOf(a.airline.id);
    const second = await unlockExecutiveOffice(db.db, own(a));
    expect(second.ok && second.state.officesUnlocked).toBe(2);
    expect(await cashOf(a.airline.id)).toBe(before2 - EXECUTIVE_OFFICE_COSTS_MINOR[1]!);
  });

  it('refuses the next office when the cash is not there', async () => {
    const a = await fixtures.create();
    await seedOpenFloor(a);
    // No extra funding: the opening balance is far below the $75M first office.
    const result = await unlockExecutiveOffice(db.db, own(a));
    expect(result).toEqual({ ok: false, code: 'insufficient_funds' });
    expect(await readExecutiveFloor(db.db, own(a))).toMatchObject({ officesUnlocked: 0 });
  });

  it('refuses to open an eleventh office', async () => {
    const a = await fixtures.create();
    await seedOpenFloor(a, 10);
    const result = await unlockExecutiveOffice(db.db, own(a));
    expect(result).toEqual({ ok: false, code: 'maxed' });
  });

  /* ---- The C-Suite (Phase 2) ------------------------------------------- */

  const [first, second] = EXECUTIVE_CANDIDATES;

  it('hires a C-Suite member into a free office, from the catalogue salary', async () => {
    const a = await fixtures.create();
    await seedOpenFloor(a, 2);
    const result = await hireExecutive(db.db, own(a), first!.id);
    if (!result.ok) throw new Error(`expected the hire to succeed, got ${result.code}`);
    expect(result.state.hires).toHaveLength(1);
    const [hire] = result.state.hires;
    expect(hire).toMatchObject({
      candidateId: first!.id,
      candidateName: first!.name,
      monthlySalaryMinor: first!.monthlySalaryMinor,
    });
    expect(typeof hire!.hiredAt).toBe('string');
  });

  it('refuses a C-Suite hire before the floor is open', async () => {
    const a = await fixtures.create();
    const result = await hireExecutive(db.db, own(a), first!.id);
    expect(result).toEqual({ ok: false, code: 'floor_locked' });
  });

  it('refuses an unknown candidate', async () => {
    const a = await fixtures.create();
    await seedOpenFloor(a, 1);
    const result = await hireExecutive(db.db, own(a), 'not-a-real-id');
    expect(result).toEqual({ ok: false, code: 'unknown_candidate' });
  });

  it('refuses hiring the same person twice', async () => {
    const a = await fixtures.create();
    await seedOpenFloor(a, 2);
    await hireExecutive(db.db, own(a), first!.id);
    const again = await hireExecutive(db.db, own(a), first!.id);
    expect(again).toEqual({ ok: false, code: 'already_hired' });
  });

  it('locks the market when every open office is staffed', async () => {
    const a = await fixtures.create();
    await seedOpenFloor(a, 1); // one office, so one hire fills the floor
    expect((await hireExecutive(db.db, own(a), first!.id)).ok).toBe(true);
    const full = await hireExecutive(db.db, own(a), second!.id);
    expect(full).toEqual({ ok: false, code: 'no_free_office' });
  });

  it('frees an office when a C-Suite member is let go', async () => {
    const a = await fixtures.create();
    await seedOpenFloor(a, 1);
    await hireExecutive(db.db, own(a), first!.id);
    // Full: the second is refused...
    expect((await hireExecutive(db.db, own(a), second!.id)).ok).toBe(false);
    // ...until the first is dismissed, freeing the office.
    expect(await dismissExecutive(db.db, own(a), first!.id)).toEqual({ dismissed: true });
    const now = await hireExecutive(db.db, own(a), second!.id);
    expect(now.ok).toBe(true);
    expect(now.ok && now.state.hires.map((h) => h.candidateId)).toEqual([second!.id]);
  });

  it('places a hire in the office the player clicked, not the first free one', async () => {
    const a = await fixtures.create();
    await seedOpenFloor(a, 4);
    // Offices 0 and 1 are empty; hiring into office 2 must land in office 2.
    const result = await hireExecutive(db.db, own(a), first!.id, 2);
    expect(result.ok).toBe(true);
    expect(result.ok && result.state.hires).toEqual([
      expect.objectContaining({ candidateId: first!.id, officeIndex: 2 }),
    ]);
  });

  it('refuses a hire into an office that is already taken', async () => {
    const a = await fixtures.create();
    await seedOpenFloor(a, 4);
    await hireExecutive(db.db, own(a), first!.id, 2);
    const clash = await hireExecutive(db.db, own(a), second!.id, 2);
    expect(clash).toEqual({ ok: false, code: 'office_occupied' });
  });

  it('falls back to the lowest free office when none is named', async () => {
    const a = await fixtures.create();
    await seedOpenFloor(a, 4);
    await hireExecutive(db.db, own(a), first!.id, 1); // office 1 taken
    const auto = await hireExecutive(db.db, own(a), second!.id); // no office named
    // Lowest free is office 0.
    expect(auto.ok && auto.state.hires.find((h) => h.candidateId === second!.id)?.officeIndex).toBe(
      0,
    );
  });
});
