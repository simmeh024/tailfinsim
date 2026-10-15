import { randomUUID } from 'node:crypto';

import { asc, count, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AcademiesResponse } from '@tailfin/shared';

import { seedAircraftCatalogue } from '../aircraft/catalogue';
import { moveAirlineCash } from '../airline/cash';
import { openCrewBase } from '../crew/store';
import { createDatabase, type DatabaseHandle } from '../db/client';
import {
  academy,
  academyModule,
  airline,
  airport,
  cashMovement,
  crewBase,
  ledgerEntry,
} from '../db/schema';
import { type ServerEnv } from '../env';
import { createAirportIdentities } from '../test-fixtures/airport-codes';
import { makeAuthedTestEnv } from '../test-fixtures/env';
import { createOwnershipTestSuite, type OwnershipTestSuite } from '../test-fixtures/ownership';
import { ABSENT_RESOURCE_UUID } from '../test-fixtures/resource-id';
import { worldGameNow } from '../world/game-now';

import { completeDueAcademyBuilds } from './store';

import type { FoundedAirlineFixture } from '../test-fixtures/founded-airline';
import type { LightMyRequestResponse } from 'fastify';

/**
 * The academy's writes over HTTP: what a refusal leaves behind (SURFACE-10).
 *
 * SURFACE-10 puts Found, Build level and Build module buttons on the Crew page,
 * and its acceptance criterion is that **a refused build or upgrade leaves cash,
 * ledger and academies provably unchanged** — the page tells the player
 * *"nothing was charged and nothing changed"*, and this is the proof. Every code
 * in the closed `AcademyRefusal` set, plus the schema's 400, is met at the API
 * boundary and checked against the balance, the AIR-06 movements, the ledger
 * lines and every academy and module row the airline holds. The cross-owner
 * concealment is `routes.test.ts`'s; the codes here are the ones a player meets
 * at their own bases.
 *
 * `insufficient_funds` is the one that matters most and had no test at all: it
 * is refused **after** `moveAirlineCash` has written the movement, by throwing
 * inside the transaction, so it is the code where a regression would charge the
 * capital and still answer 409.
 *
 * Requires `DATABASE_URL`; CI provides it.
 */

const url = process.env.DATABASE_URL;
if (!url) console.warn('\n  [academy/routes-refusals.test] DATABASE_URL not set — skipping.\n');
const describeDb = url ? describe : describe.skip;

const env: ServerEnv = makeAuthedTestEnv();
const nextAirport = createAirportIdentities('academy/routes-refusals');

type Actor = 'playerA' | 'playerB';

/** Each case walks several HTTP writes and sweeps; generous, so a busy machine is not a failure. */
const CASE_TIMEOUT_MS = 30_000;

describeDb('academy refusals over HTTP', () => {
  let db: DatabaseHandle;
  let suite: OwnershipTestSuite;
  const madeAirports: string[] = [];

  beforeAll(async () => {
    db = createDatabase();
    // The full-flight sim's family picker reads the world's catalogue.
    await seedAircraftCatalogue(db.db);
    suite = await createOwnershipTestSuite({ db, env, suite: 'academy-refusals' });
  }, 60_000);

  afterAll(async () => {
    // Bases cascade from the airline and academies from the base, so the
    // airlines go first and the airports they stood on after.
    await suite.cleanup();
    for (const id of madeAirports.splice(0)) await db.db.delete(airport).where(eq(airport.id, id));
    await db.close();
  });

  function fixtureOf(actor: Actor): FoundedAirlineFixture {
    return actor === 'playerA' ? suite.airlineA : suite.airlineB;
  }

  /** A crew base at a fresh airport with an ICAO code, as `crew_base` requires. */
  async function openBase(actor: Actor): Promise<string> {
    const identity = nextAirport();
    const [created] = await db.db
      .insert(airport)
      .values({
        sourceId: identity.sourceId,
        ident: identity.ident,
        icaoCode: identity.icaoCode,
        name: `Academy Refusal Field ${identity.icaoCode}`,
        isoCountry: 'NL',
        kind: 'medium_airport',
        latitude: 52,
        longitude: 4,
        scheduledService: true,
        hasRunwayData: false,
        tier: 'medium',
        slotLevel: 2,
      })
      .returning({ id: airport.id });
    if (!created) throw new Error('airport was not created');
    madeAirports.push(created.id);

    const fixture = fixtureOf(actor);
    const opened = await openCrewBase(db.db, {
      worldId: fixture.world.id,
      airlineId: fixture.airline.id,
      airportIcao: identity.icaoCode,
    });
    if (!opened.ok) throw new Error(`could not open a base: ${opened.refusal}`);
    return opened.value.crewBaseId;
  }

  /** Move cash through AIR-06 — never `update airline set cash_minor`. */
  async function moveCash(actor: Actor, amountMinor: number): Promise<void> {
    const fixture = fixtureOf(actor);
    await db.db.transaction(async (tx) =>
      moveAirlineCash(tx, {
        airlineId: fixture.airline.id,
        amountMinor,
        cause: 'admin_adjustment',
        reference: `academy-refusals:${randomUUID()}`,
        occurredAt: await worldGameNow(tx, fixture.world.id),
      }),
    );
  }

  async function cashOf(actor: Actor): Promise<number> {
    const [row] = await db.db
      .select({ cashMinor: airline.cashMinor })
      .from(airline)
      .where(eq(airline.id, fixtureOf(actor).airline.id));
    return row?.cashMinor ?? 0;
  }

  /** Everything an academy write could touch for one airline. */
  async function snapshot(actor: Actor) {
    const airlineId = fixtureOf(actor).airline.id;
    const [movements] = await db.db
      .select({ n: count() })
      .from(cashMovement)
      .where(eq(cashMovement.airlineId, airlineId));
    const [lines] = await db.db
      .select({ n: count() })
      .from(ledgerEntry)
      .where(eq(ledgerEntry.airlineId, airlineId));
    const academies = await db.db
      .select()
      .from(academy)
      .where(eq(academy.airlineId, airlineId))
      .orderBy(asc(academy.id));
    const modules =
      academies.length === 0
        ? []
        : await db.db
            .select()
            .from(academyModule)
            .where(
              inArray(
                academyModule.academyId,
                academies.map((row) => row.id),
              ),
            )
            .orderBy(asc(academyModule.id));
    return {
      cash: await cashOf(actor),
      movements: movements?.n,
      lines: lines?.n,
      academies,
      modules,
    };
  }

  function send(
    actor: Actor,
    path: string,
    payload?: Record<string, unknown>,
  ): Promise<LightMyRequestResponse> {
    return suite.as(
      { actor, worldId: fixtureOf(actor).world.id },
      { method: 'POST', url: path, ...(payload === undefined ? {} : { payload }) },
    );
  }

  /** A write the server refuses, and the proof it left this airline exactly as it was. */
  async function expectRefused(
    actor: Actor,
    request: () => Promise<LightMyRequestResponse>,
    status: number,
    code: string,
  ): Promise<void> {
    const before = await snapshot(actor);
    const response = await request();
    expect(response.statusCode, response.body).toBe(status);
    expect(response.json<{ code: string }>().code).toBe(code);
    expect(await snapshot(actor)).toEqual(before);
  }

  /** Sweep the world to the instant this academy's build was promised for. */
  async function commission(academyId: string): Promise<void> {
    const [row] = await db.db
      .select({ readyAt: academy.constructionReadyAt, worldId: academy.worldId })
      .from(academy)
      .where(eq(academy.id, academyId));
    if (!row?.readyAt) throw new Error('nothing is under construction');
    await completeDueAcademyBuilds(db.db, row.worldId, row.readyAt);
  }

  /** Found through the endpoint the page calls, and read the id back out of the whole state. */
  async function foundOverHttp(actor: Actor, crewBaseId: string): Promise<string> {
    const response = await send(actor, '/api/academies', { crewBaseId });
    expect(response.statusCode, response.body).toBe(200);
    const state = AcademiesResponse.parse(response.json());
    const founded = state.academies.find((row) => row.crewBaseId === crewBaseId);
    if (!founded) throw new Error('the answer did not carry the new academy');
    expect(founded.level).toBe(0);
    expect(state.sites.some((site) => site.crewBaseId === crewBaseId)).toBe(false);
    return founded.id;
  }

  let ownAcademyId: string;
  let rivalBaseId: string;

  it(
    'refuses a second academy, a stranger’s base, a closed base and a malformed body — and changes nothing',
    async () => {
      // Enough for every level and module, so the rule rather than the purse is
      // what each refusal below exercises.
      await moveCash('playerA', 300_000_000);
      const baseId = await openBase('playerA');
      const closedBaseId = await openBase('playerA');
      rivalBaseId = await openBase('playerB');
      ownAcademyId = await foundOverHttp('playerA', baseId);

      await expectRefused(
        'playerA',
        () => send('playerA', '/api/academies', { crewBaseId: baseId }),
        409,
        'academy_exists',
      );
      await expectRefused(
        'playerA',
        () => send('playerA', '/api/academies', { crewBaseId: rivalBaseId }),
        404,
        'base_absent',
      );

      // No player route closes a base; the row is arranged here so the code the
      // page would show is still proven to leave everything as it was.
      await db.db.update(crewBase).set({ status: 'closed' }).where(eq(crewBase.id, closedBaseId));
      await expectRefused(
        'playerA',
        () => send('playerA', '/api/academies', { crewBaseId: closedBaseId }),
        409,
        'base_closed',
      );
      await expectRefused(
        'playerA',
        () => send('playerA', '/api/academies', { crewBaseId: 'not-a-base' }),
        400,
        'invalid_input',
      );
    },
    CASE_TIMEOUT_MS,
  );

  it(
    'refuses a module the academy cannot take, and changes nothing',
    async () => {
      await commission(ownAcademyId);
      const modules = `/api/academies/${ownAcademyId}/modules`;

      // The fixed-base sim arrives at level 3; this is level 1.
      await expectRefused(
        'playerA',
        () => send('playerA', modules, { kind: 'fixed_base_sim' }),
        409,
        'module_level',
      );
      await expectRefused(
        'playerA',
        () => send('playerA', modules, { kind: 'full_flight_sim', family: 'Nonexistent' }),
        409,
        'unknown_family',
      );
      await expectRefused(
        'playerA',
        () => send('playerA', modules, { kind: 'cbt_suite', family: 'A320' }),
        400,
        'invalid_input',
      );

      const built = await send('playerA', modules, { kind: 'cbt_suite' });
      expect(built.statusCode, built.body).toBe(200);
      // Still being built is still held: a second one is refused, not queued.
      await expectRefused(
        'playerA',
        () => send('playerA', modules, { kind: 'cbt_suite' }),
        409,
        'module_exists',
      );
    },
    CASE_TIMEOUT_MS,
  );

  it(
    'refuses a level while one is building, past the top, or on an academy that is not there',
    async () => {
      const levels = `/api/academies/${ownAcademyId}/levels`;
      const started = await send('playerA', levels);
      expect(started.statusCode, started.body).toBe(200);
      await expectRefused('playerA', () => send('playerA', levels), 409, 'already_building');

      await expectRefused(
        'playerA',
        () => send('playerA', `/api/academies/${ABSENT_RESOURCE_UUID}/levels`),
        404,
        'academy_absent',
      );

      // Up the ladder to the Centre of Excellence, one commissioned level at a time.
      await commission(ownAcademyId);
      for (let level = 3; level <= 5; level += 1) {
        const next = await send('playerA', levels);
        expect(next.statusCode, next.body).toBe(200);
        await commission(ownAcademyId);
      }
      const [top] = await db.db
        .select({ level: academy.level, pendingLevel: academy.pendingLevel })
        .from(academy)
        .where(eq(academy.id, ownAcademyId));
      expect(top).toEqual({ level: 5, pendingLevel: null });

      await expectRefused('playerA', () => send('playerA', levels), 409, 'max_level');
    },
    CASE_TIMEOUT_MS,
  );

  it(
    'refuses what the airline cannot afford — after the movement is written — and changes nothing',
    async () => {
      const academyId = await foundOverHttp('playerB', rivalBaseId);
      await commission(academyId);
      const site = await openBase('playerB');

      // Leave less than the cheapest thing on offer.
      await moveCash('playerB', -((await cashOf('playerB')) - 100));
      expect(await cashOf('playerB')).toBe(100);

      await expectRefused(
        'playerB',
        () => send('playerB', '/api/academies', { crewBaseId: site }),
        409,
        'insufficient_funds',
      );
      await expectRefused(
        'playerB',
        () => send('playerB', `/api/academies/${academyId}/levels`),
        409,
        'insufficient_funds',
      );
      await expectRefused(
        'playerB',
        () => send('playerB', `/api/academies/${academyId}/modules`, { kind: 'cbt_suite' }),
        409,
        'insufficient_funds',
      );

      // And the site is still offered, at the price it was: nothing was taken.
      const read = await suite.as(
        { actor: 'playerB', worldId: suite.worldMain.id },
        { method: 'GET', url: '/api/academies' },
      );
      const state = AcademiesResponse.parse(read.json());
      expect(state.sites.map((row) => row.crewBaseId)).toEqual([site]);
      expect(state.academies.find((row) => row.id === academyId)?.level).toBe(1);
    },
    CASE_TIMEOUT_MS,
  );
});
