import { randomUUID } from 'node:crypto';

import { and, eq, isNull } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase, type DatabaseHandle } from '../db/client';
import { airport, alert, alertState, flight, flightResult, runway } from '../db/schema';
import { openRoute } from '../network/open-route';
import {
  createFoundedAirlineFixtureHarness,
  type FoundedAirlineFixture,
  type FoundedAirlineFixtureHarness,
} from '../test-fixtures/founded-airline';
import { worldGameNow } from '../world/game-now';

import { digestWindowFor, markDigestRead, readDigest } from './digest';
import { sweepAirlineAlerts, sweepWorldAlerts } from './evaluate';
import { readOpenAlerts } from './store';

import type { ResolvedPlayerAirline } from '../airline/context';

/**
 * §14.5's alerts and §3.2's digest against real PostgreSQL (M8-13).
 *
 * The rules themselves are proved without a database in
 * `packages/sim/src/alerts/rules.test.ts`. What needs Postgres is everything
 * around them, and all three of it are acceptance criteria:
 *
 * 1. the digest covers **the exact period since last seen** — which means the
 *    watermark, its clamps, and the window arithmetic against a real world clock;
 * 2. alerts are **deduplicated, not repeated every tick** — which is the partial
 *    unique index and the reconciliation, and can only be shown by sweeping
 *    twice against an unchanged world;
 * 3. each alert **links to a screen** — which is a column the sweep has to fill.
 *
 * Requires `DATABASE_URL`; CI provides it.
 */

const url = process.env.DATABASE_URL;
if (!url) console.warn('\n  [alerts/alerts-db.test] DATABASE_URL not set — skipping.\n');
const describeDb = url ? describe : describe.skip;

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

describeDb('the alert sweep and the offline digest', () => {
  let db: DatabaseHandle;
  let fixtures: FoundedAirlineFixtureHarness;
  let sequence = 0;
  const madeAirports: string[] = [];

  beforeAll(() => {
    db = createDatabase();
    fixtures = createFoundedAirlineFixtureHarness(db.db);
  });

  afterEach(async () => {
    await fixtures.cleanup();
    for (const id of madeAirports.splice(0)) {
      await db.db.delete(airport).where(eq(airport.id, id));
    }
  });

  afterAll(async () => {
    await db.close();
  });

  function own(fixture: FoundedAirlineFixture): ResolvedPlayerAirline {
    return { id: fixture.airline.id, worldId: fixture.world.id, status: 'active' };
  }

  async function makeAirport(latitude: number, longitude: number): Promise<string> {
    const n = sequence++;
    const icao = `Q${LETTERS[Math.floor(n / 26) % 26]}${LETTERS[n % 26]}${LETTERS[(n * 7) % 26]}`;
    const [created] = await db.db
      .insert(airport)
      .values({
        sourceId: -(9_310_000 + n),
        ident: icao,
        icaoCode: icao,
        name: `Alert test ${icao}`,
        isoCountry: 'US',
        kind: 'large_airport',
        latitude,
        longitude,
        scheduledService: true,
        hasRunwayData: true,
        tier: 'large',
        elevationFt: 0,
      })
      .returning({ id: airport.id });
    if (!created) throw new Error(`no airport ${icao}`);
    madeAirports.push(created.id);
    // Without a runway row `openRoute` refuses every pair as unreachable.
    await db.db.insert(runway).values({
      sourceId: -(9_310_000 + n),
      airportId: created.id,
      identifier: '09/27',
      lengthFt: 12_000,
      widthFt: 150,
      surface: 'asphalt',
      lighted: true,
      closed: false,
    });
    return icao;
  }

  async function openPair(
    fixture: FoundedAirlineFixture,
    longitude: number,
  ): Promise<{ routeId: string; from: string; to: string }> {
    const from = await makeAirport(5, longitude);
    const to = await makeAirport(5, longitude + 8);
    const opened = await openRoute(db.db, own(fixture), { originIcao: from, destinationIcao: to });
    if (!opened.ok) throw new Error(`route refused: ${JSON.stringify(opened)}`);
    return { routeId: opened.routeId, from, to };
  }

  /** One settled flight, written the way the worker would leave it. */
  async function flew(
    fixture: FoundedAirlineFixture,
    pair: { from: string; to: string },
    options: {
      daysAgo: number;
      passengers?: number;
      spilled?: number;
      revenueMinor: number;
      costMinor: number;
      airlineId?: string;
    },
  ): Promise<void> {
    const gameNow = await worldGameNow(db.db, fixture.world.id);
    const settledAt = new Date(gameNow.getTime() - options.daysAgo * DAY_MS);
    const off = new Date(settledAt.getTime() - 2 * HOUR_MS);
    const airlineId = options.airlineId ?? fixture.airline.id;
    const passengers = options.passengers ?? 120;
    const spilled = options.spilled ?? 0;

    const [created] = await db.db
      .insert(flight)
      .values({
        worldId: fixture.world.id,
        airlineId,
        airframeId: randomUUID(),
        originIcao: pair.from,
        destinationIcao: pair.to,
        phase: 'turnaround',
        scheduledDeparture: off,
        estimatedArrival: settledAt,
        actualDeparture: off,
        actualArrival: settledAt,
        load: '{}',
      })
      .returning({ id: flight.id });
    if (!created) throw new Error('flight was not created');

    await db.db.insert(flightResult).values({
      worldId: fixture.world.id,
      flightId: created.id,
      airlineId,
      kind: 'scheduled',
      // Spill is only legal on a full aeroplane (App. A.5), so a spilling
      // fixture has to fill every seat.
      seats: spilled > 0 ? passengers : 180,
      passengers,
      spilledPassengers: spilled,
      cargoKg: 0,
      revenueMinor: options.revenueMinor,
      costMinor: options.costMinor,
      netMinor: options.revenueMinor - options.costMinor,
      blockSeconds: 7_200,
      arrivalDelayMinutes: 0,
      breakdown: '{}',
      settlementVersion: 'test',
      settledAt,
    });
  }

  async function sweep(fixture: FoundedAirlineFixture) {
    const gameNow = await worldGameNow(db.db, fixture.world.id);
    return sweepAirlineAlerts(db.db, own(fixture), fixture.airline.name, gameNow);
  }

  async function openRows(fixture: FoundedAirlineFixture) {
    return db.db
      .select()
      .from(alert)
      .where(and(eq(alert.airlineId, fixture.airline.id), isNull(alert.resolvedAt)));
  }

  /* ------------------------------------------------------------------ AC2 */

  it('raises a loss-making route once, not once per tick (AC2)', async () => {
    const fixture = await fixtures.create();
    const pair = await openPair(fixture, -120);

    // Four days of trading, every one of them losing money.
    for (const daysAgo of [1, 2, 3, 4]) {
      await flew(fixture, pair, { daysAgo, revenueMinor: 100_000, costMinor: 400_000 });
    }

    const first = await sweep(fixture);
    const losses = (await openRows(fixture)).filter((row) => row.kind === 'route_loss_making');
    expect(losses).toHaveLength(1);
    expect(first.raised).toBeGreaterThanOrEqual(1);

    /*
     * The criterion, measured rather than asserted. The world has not changed, so
     * the second sweep must raise nothing at all — and the row must still carry
     * its original `raised_at`, because re-dating an open alert would make it look
     * new to the digest every hour.
     */
    const raisedAt = losses[0]?.raisedAt;
    const second = await sweep(fixture);
    expect(second.raised).toBe(0);

    const after = (await openRows(fixture)).filter((row) => row.kind === 'route_loss_making');
    expect(after).toHaveLength(1);
    expect(after[0]?.raisedAt.getTime()).toBe(raisedAt?.getTime());
  });

  /**
   * The index, not the reconciliation.
   *
   * `reconcileAlerts` would already prevent this, so the point of the test is
   * that the **database** prevents it too: two workers racing through a handover
   * both read an empty open set and both insert. A direct insert is the only way
   * to reproduce that without two processes.
   */
  it('refuses a second open row for the same subject at the database (AC2)', async () => {
    const fixture = await fixtures.create();
    const gameNow = await worldGameNow(db.db, fixture.world.id);

    const row = {
      worldId: fixture.world.id,
      airlineId: fixture.airline.id,
      kind: 'cash_runway',
      severity: 'critical',
      subjectType: 'airline',
      subjectId: fixture.airline.id,
      subjectLabel: fixture.airline.name,
      subjectKey: fixture.airline.id,
      title: 'Cash runs out in 3 day(s)',
      detail: 'A duplicate would be indistinguishable from this one.',
      screen: 'finance',
      raisedAt: gameNow,
    };

    await db.db.insert(alert).values(row);
    await expect(db.db.insert(alert).values(row)).rejects.toThrow();

    // Resolved, the constraint lets the condition be raised again — which is what
    // makes an alert that comes back a second piece of news rather than silence.
    await db.db
      .update(alert)
      .set({ resolvedAt: gameNow })
      .where(eq(alert.airlineId, fixture.airline.id));
    await expect(db.db.insert(alert).values(row)).resolves.not.toThrow();
  });

  it('resolves an alert when its condition goes away (AC2)', async () => {
    const fixture = await fixtures.create();
    const pair = await openPair(fixture, -60);

    for (const daysAgo of [1, 2, 3]) {
      await flew(fixture, pair, { daysAgo, revenueMinor: 100_000, costMinor: 400_000 });
    }
    await sweep(fixture);
    expect((await openRows(fixture)).map((row) => row.kind)).toContain('route_loss_making');

    // One profitable day in the window and the route is no longer losing.
    await flew(fixture, pair, { daysAgo: 0, revenueMinor: 900_000, costMinor: 100_000 });
    const cleared = await sweep(fixture);
    expect(cleared.resolved).toBeGreaterThanOrEqual(1);
    expect((await openRows(fixture)).map((row) => row.kind)).not.toContain('route_loss_making');
  });

  /* ------------------------------------------------------------------ AC3 */

  it('fills the screen every alert links to (AC3)', async () => {
    const fixture = await fixtures.create();
    const pair = await openPair(fixture, 20);
    for (const daysAgo of [1, 2, 3]) {
      await flew(fixture, pair, { daysAgo, revenueMinor: 100_000, costMinor: 400_000 });
    }
    await sweep(fixture);

    const response = await readOpenAlerts(db.db, own(fixture));
    expect(response.alerts.length).toBeGreaterThan(0);
    for (const entry of response.alerts) {
      expect(entry.screen).toBeTruthy();
      expect(entry.subjectId).toBeTruthy();
      expect(entry.subjectLabel).toBeTruthy();
    }

    const loss = response.alerts.find((entry) => entry.kind === 'route_loss_making');
    // The link is the route, so the network page can open the right diagnosis.
    expect(loss?.screen).toBe('network');
    expect(loss?.subjectId).toBe(pair.routeId);
  });

  /**
   * The difference between *nothing is wrong* and *nothing has run*.
   *
   * This is the missing-worker trap in one assertion: before any sweep the alert
   * list is empty **and** `evaluatedAt` is null, which is exactly the state a
   * production world is in permanently.
   */
  it('says whether the rules have ever run', async () => {
    const fixture = await fixtures.create();

    const before = await readOpenAlerts(db.db, own(fixture));
    expect(before.alerts).toEqual([]);
    expect(before.evaluatedAt).toBeNull();

    await sweep(fixture);

    const after = await readOpenAlerts(db.db, own(fixture));
    expect(after.evaluatedAt).not.toBeNull();
  });

  it('orders critical alerts above warnings, oldest first inside a severity', async () => {
    const fixture = await fixtures.create();
    const gameNow = await worldGameNow(db.db, fixture.world.id);

    const base = {
      worldId: fixture.world.id,
      airlineId: fixture.airline.id,
      subjectType: 'airline' as const,
      subjectId: fixture.airline.id,
      subjectLabel: fixture.airline.name,
      detail: 'Ordering fixture.',
      screen: 'finance' as const,
    };
    await db.db.insert(alert).values([
      {
        ...base,
        kind: 'route_spill',
        severity: 'warning',
        subjectKey: 'old-warning',
        title: 'Old warning',
        raisedAt: new Date(gameNow.getTime() - 10 * DAY_MS),
      },
      {
        ...base,
        kind: 'cash_runway',
        severity: 'critical',
        subjectKey: 'new-critical',
        title: 'New critical',
        raisedAt: gameNow,
      },
      {
        ...base,
        kind: 'dscr_headroom',
        severity: 'critical',
        subjectKey: 'old-critical',
        title: 'Old critical',
        raisedAt: new Date(gameNow.getTime() - 20 * DAY_MS),
      },
    ]);

    const response = await readOpenAlerts(db.db, own(fixture));
    expect(response.alerts.map((entry) => entry.title)).toEqual([
      'Old critical',
      'New critical',
      'Old warning',
    ]);
  });

  /* ------------------------------------------------------------------ AC1 */

  it('covers the exact period since the last acknowledgement (AC1)', async () => {
    const fixture = await fixtures.create();
    const pair = await openPair(fixture, 60);
    const gameNow = await worldGameNow(db.db, fixture.world.id);

    // Six days ago, before the acknowledgement; two days ago, after it.
    await flew(fixture, pair, { daysAgo: 6, revenueMinor: 500_000, costMinor: 100_000 });
    await flew(fixture, pair, { daysAgo: 2, revenueMinor: 500_000, costMinor: 100_000 });

    await markDigestRead(db.db, own(fixture), new Date(gameNow.getTime() - 4 * DAY_MS));

    const digest = await readDigest(db.db, own(fixture));
    expect(new Date(digest.window.fromAt).getTime()).toBe(gameNow.getTime() - 4 * DAY_MS);
    expect(digest.window.days).toBeCloseTo(4, 5);
    expect(digest.window.first).toBe(false);
    // The flight before the watermark is not in the window. That is the whole
    // criterion: the player has already been shown it.
    expect(digest.activity.flightsFlown).toBe(1);
  });

  /**
   * A read must not consume the feed.
   *
   * `session.last_seen_at` is touched on every authenticated request, which is
   * why the watermark is not that column; the same failure would reappear here if
   * the GET advanced it, and a stray page refresh would destroy a week of news.
   */
  it('does not advance the watermark when the digest is read (AC1)', async () => {
    const fixture = await fixtures.create();
    const pair = await openPair(fixture, -20);
    const gameNow = await worldGameNow(db.db, fixture.world.id);
    await flew(fixture, pair, { daysAgo: 1, revenueMinor: 500_000, costMinor: 100_000 });

    /*
     * Acknowledged first, so the window's lower bound is pinned by the watermark
     * rather than by the clock. Without that the two reads would legitimately
     * differ: the world clock advances between them, and a *first* visit's
     * window opens one capped span back from wherever the clock has got to.
     */
    const acknowledged = new Date(gameNow.getTime() - 3 * DAY_MS);
    await markDigestRead(db.db, own(fixture), acknowledged);

    const first = await readDigest(db.db, own(fixture));
    const second = await readDigest(db.db, own(fixture));

    expect(new Date(first.window.fromAt).getTime()).toBe(acknowledged.getTime());
    expect(second.window.fromAt).toBe(first.window.fromAt);
    expect(second.activity.flightsFlown).toBe(first.activity.flightsFlown);
    expect(second.activity.flightsFlown).toBe(1);

    // The watermark is exactly where the acknowledgement left it. Two reads
    // moved it nowhere.
    const stored = await db.db
      .select({ coveredThroughAt: alertState.digestCoveredThroughAt })
      .from(alertState)
      .where(eq(alertState.airlineId, fixture.airline.id));
    expect(stored[0]?.coveredThroughAt?.getTime()).toBe(acknowledged.getTime());
  });

  it('never moves the watermark backwards or past the world clock (AC1)', async () => {
    const fixture = await fixtures.create();
    const gameNow = await worldGameNow(db.db, fixture.world.id);
    const recent = new Date(gameNow.getTime() - 2 * DAY_MS);

    await markDigestRead(db.db, own(fixture), recent);

    // A stale acknowledgement arriving late must not replay a dismissed period.
    const backwards = await markDigestRead(
      db.db,
      own(fixture),
      new Date(gameNow.getTime() - 20 * DAY_MS),
    );
    expect(new Date(backwards.coveredThroughAt).getTime()).toBe(recent.getTime());

    // A future one must not swallow a period whose events have not happened.
    const forwards = await markDigestRead(
      db.db,
      own(fixture),
      new Date(gameNow.getTime() + 500 * DAY_MS),
    );
    expect(new Date(forwards.coveredThroughAt).getTime()).toBeLessThanOrEqual(
      // The clock advances between the two reads, so this is an upper bound
      // rather than an equality — the point is that it was clamped at all.
      Date.now() + DAY_MS,
    );
    expect(new Date(forwards.coveredThroughAt).getTime()).toBeGreaterThan(recent.getTime());
  });

  it('carries the alerts raised and resolved inside the window (AC1)', async () => {
    const fixture = await fixtures.create();
    const pair = await openPair(fixture, 100);
    for (const daysAgo of [1, 2, 3]) {
      await flew(fixture, pair, { daysAgo, revenueMinor: 100_000, costMinor: 400_000 });
    }
    await sweep(fixture);

    const raised = await readDigest(db.db, own(fixture));
    expect(raised.raised.map((entry) => entry.kind)).toContain('route_loss_making');
    expect(raised.resolved).toEqual([]);
    expect(raised.open.map((entry) => entry.kind)).toContain('route_loss_making');

    await flew(fixture, pair, { daysAgo: 0, revenueMinor: 900_000, costMinor: 100_000 });
    await sweep(fixture);

    const cleared = await readDigest(db.db, own(fixture));
    // Good news is in the feed too: a digest that only ever reported problems
    // would show a player who fixed a route what it shows one who fixed none.
    expect(cleared.resolved.map((entry) => entry.kind)).toContain('route_loss_making');
    expect(cleared.open.map((entry) => entry.kind)).not.toContain('route_loss_making');
  });

  it('reports the activity behind the feed, and null rather than zero on an empty week', async () => {
    const fixture = await fixtures.create();
    const digest = await readDigest(db.db, own(fixture));

    expect(digest.window.first).toBe(true);
    expect(digest.activity.flightsFlown).toBe(0);
    // Zero would claim every flight was late. Null says nothing flew.
    expect(digest.activity.onTimeRate).toBeNull();
    // Founding's own AIR-06 movement is inside the window, so the cash change is
    // the opening balance rather than nothing — the ledger is the source.
    expect(digest.activity.cashChangeMinor).toBeGreaterThan(0);
  });

  /* -------------------------------------------------------- spill and rivals */

  it('raises spill on a route turning passengers away', async () => {
    const fixture = await fixtures.create();
    const pair = await openPair(fixture, 140);

    for (const daysAgo of [1, 2, 3, 4, 5, 6]) {
      await flew(fixture, pair, {
        daysAgo,
        passengers: 180,
        spilled: 60,
        revenueMinor: 900_000,
        costMinor: 100_000,
      });
    }
    await sweep(fixture);

    const spill = (await openRows(fixture)).find((row) => row.kind === 'route_spill');
    expect(spill).toBeDefined();
    expect(spill?.severity).toBe('warning');
    expect(spill?.subjectId).toBe(pair.routeId);
    // The count leads, as §14.5's parenthesis asks: *you're turning away money*.
    expect(spill?.title).toContain('360');
  });

  /**
   * *Entered* means started flying, and the test that matters is the negative
   * one: a rival with older history on the pair is the market the player is
   * already in, and reporting it would open every alert list with a history
   * lesson.
   */
  it('reports a rival that has just started flying, and not one that always has', async () => {
    const fixture = await fixtures.create();
    const rival = await fixtures.create({ worldId: fixture.world.id });
    const pair = await openPair(fixture, -160);

    await flew(fixture, pair, { daysAgo: 1, revenueMinor: 500_000, costMinor: 100_000 });
    await flew(fixture, pair, {
      daysAgo: 2,
      revenueMinor: 500_000,
      costMinor: 100_000,
      airlineId: rival.airline.id,
    });

    await sweep(fixture);
    const entered = (await openRows(fixture)).filter(
      (row) => row.kind === 'competitor_entered_route',
    );
    expect(entered).toHaveLength(1);
    expect(entered[0]?.subjectKey).toBe(`${pair.routeId}:${rival.airline.id}`);
    expect(entered[0]?.subjectId).toBe(pair.routeId);

    // Give the rival history older than the lookback and the alert resolves on
    // its own, with nothing having had to expire it.
    await flew(fixture, pair, {
      daysAgo: 40,
      revenueMinor: 500_000,
      costMinor: 100_000,
      airlineId: rival.airline.id,
    });
    await sweep(fixture);
    expect(
      (await openRows(fixture)).filter((row) => row.kind === 'competitor_entered_route'),
    ).toHaveLength(0);
  });

  /* ------------------------------------------------------------- the sweep */

  it('sweeps a world once per game hour and stamps every airline', async () => {
    const fixture = await fixtures.create();
    const gameNow = await worldGameNow(db.db, fixture.world.id);

    const first = await sweepWorldAlerts(db.db, fixture.world.id, gameNow);
    expect(first.airlinesSwept).toBeGreaterThanOrEqual(1);

    // Immediately again: the watermark holds everyone back.
    const second = await sweepWorldAlerts(db.db, fixture.world.id, gameNow);
    expect(second.airlinesSwept).toBe(0);

    // A game hour later they are due again.
    const third = await sweepWorldAlerts(
      db.db,
      fixture.world.id,
      new Date(gameNow.getTime() + HOUR_MS + 1),
    );
    expect(third.airlinesSwept).toBeGreaterThanOrEqual(1);
  });

  it('conceals another airline’s alerts entirely', async () => {
    const fixture = await fixtures.create();
    const stranger = await fixtures.create();
    const gameNow = await worldGameNow(db.db, fixture.world.id);

    await db.db.insert(alert).values({
      worldId: stranger.world.id,
      airlineId: stranger.airline.id,
      kind: 'cash_runway',
      severity: 'critical',
      subjectType: 'airline',
      subjectId: stranger.airline.id,
      subjectLabel: stranger.airline.name,
      subjectKey: stranger.airline.id,
      title: 'Not yours',
      detail: 'Owner-scoped by query, never by a post-query check (ADR-0020).',
      screen: 'finance',
      raisedAt: gameNow,
    });

    const mine = await readOpenAlerts(db.db, own(fixture));
    expect(mine.alerts).toEqual([]);

    const digest = await readDigest(db.db, own(fixture));
    expect(digest.open).toEqual([]);
    expect(digest.raised).toEqual([]);
  });
});

/* ----------------------------------------------------------- pure arithmetic */

describe('the digest window', () => {
  const gameNow = new Date('2026-06-01T00:00:00.000Z');

  it('opens one capped span back on a first visit', () => {
    const window = digestWindowFor(null, gameNow);
    expect(window.first).toBe(true);
    expect(window.truncated).toBe(false);
    expect(window.days).toBe(30);
  });

  it('truncates a long absence and says so', () => {
    const window = digestWindowFor(new Date('2026-01-01T00:00:00.000Z'), gameNow);
    expect(window.truncated).toBe(true);
    expect(window.days).toBe(30);
  });

  it('is exactly the watermark to now on a normal return', () => {
    const window = digestWindowFor(new Date('2026-05-25T00:00:00.000Z'), gameNow);
    expect(window.truncated).toBe(false);
    expect(window.first).toBe(false);
    expect(window.days).toBe(7);
  });

  /**
   * A world reset (ADR-0005) winds the clock back to the epoch while the
   * acknowledgement stays where it was. The window collapses rather than going
   * negative, which would select every row ever written.
   */
  it('collapses to nothing when the watermark is ahead of the clock', () => {
    const window = digestWindowFor(new Date('2027-01-01T00:00:00.000Z'), gameNow);
    expect(window.days).toBe(0);
    expect(window.fromAt).toBe(window.toAt);
  });
});
