import { and, asc, eq, inArray } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { FLAGSHIP_CONFIG } from '@tailfin/shared';

import { createSession } from '../auth/session';
import { createDatabase, type DatabaseHandle } from '../db/client';
import {
  adminAudit,
  adminGrant,
  airline,
  airlineStatusTransition,
  airport,
  flight,
  flightResult,
  player,
  playerIdentity,
  route,
  schedule,
  session,
  world,
} from '../db/schema';
import { createWorld } from '../world/lifecycle';

import { anonymizePlayerForWorldHistory } from './anonymize-player';
import { liveAirlineWhere, transitionAirlineStatus } from './lifecycle';

const url = process.env.DATABASE_URL;
if (!url) console.warn('\n  [lifecycle.test] DATABASE_URL not set — skipping AIR-09 tests.\n');
const describeDb = url ? describe : describe.skip;

describeDb('airline lifecycle and historical retention', () => {
  let db: DatabaseHandle;
  const madeWorlds: string[] = [];
  const madePlayers: string[] = [];
  const madeAirports: string[] = [];
  let sequence = 0;

  beforeAll(() => {
    db = createDatabase();
  });

  afterEach(async () => {
    if (madeWorlds.length > 0) {
      await db.db.delete(world).where(inArray(world.id, madeWorlds.splice(0)));
    }
    if (madeAirports.length > 0) {
      await db.db.delete(airport).where(inArray(airport.id, madeAirports.splice(0)));
    }
    if (madePlayers.length > 0) {
      await db.db.delete(player).where(inArray(player.id, madePlayers.splice(0)));
    }
  });

  afterAll(async () => {
    await db.close();
  });

  async function makePlayer(label = 'lifecycle owner'): Promise<string> {
    const rows = await db.db
      .insert(player)
      .values({ displayName: `${label} ${String(sequence++)}` })
      .returning({ id: player.id });
    const id = rows[0]?.id;
    if (!id) throw new Error('no player created');
    madePlayers.push(id);
    return id;
  }

  async function makeWorld(): Promise<string> {
    const result = await createWorld(db.db, {
      ...FLAGSHIP_CONFIG,
      name: `lifecycle-world-${String(sequence++)}`,
    });
    madeWorlds.push(result.world.id);
    return result.world.id;
  }

  async function makeAirline(
    worldId: string,
    playerId: string,
    codes: { iata: string; icao: string } = { iata: 'LC', icao: 'LFC' },
  ): Promise<string> {
    const n = sequence++;
    const rows = await db.db
      .insert(airline)
      .values({
        worldId,
        playerId,
        name: `Lifecycle Air ${String(n)}`,
        iataCode: codes.iata,
        icaoCode: codes.icao,
        callsign: `LIFECYCLE ${String(n)}`,
        baseCountry: 'NL',
      })
      .returning({ id: airline.id });
    const id = rows[0]?.id;
    if (!id) throw new Error('no airline created');
    return id;
  }

  async function makeAirport(icaoCode: string): Promise<void> {
    const n = sequence++;
    const rows = await db.db
      .insert(airport)
      .values({
        sourceId: 9_800_000 + n,
        ident: icaoCode,
        icaoCode,
        name: `Lifecycle Airport ${icaoCode}`,
        isoCountry: 'NL',
        kind: 'medium_airport',
        latitude: 52 + n / 10_000,
        longitude: 4 + n / 10_000,
        scheduledService: true,
        hasRunwayData: false,
        tier: 'medium',
      })
      .returning({ id: airport.id });
    const id = rows[0]?.id;
    if (!id) throw new Error('no airport created');
    madeAirports.push(id);
  }

  it('records the recoverable ladder and makes cessation terminal', async () => {
    const worldId = await makeWorld();
    const airlineId = await makeAirline(worldId, await makePlayer());
    const restrictedAt = new Date('2026-08-21T10:00:00.000Z');

    const restricted = await transitionAirlineStatus(
      db.db,
      airlineId,
      { to: 'restricted', reason: 'cash runway exhausted' },
      restrictedAt,
    );
    expect(restricted).toMatchObject({ kind: 'transitioned', airline: { status: 'restricted' } });

    const recovered = await transitionAirlineStatus(
      db.db,
      airlineId,
      { to: 'active', reason: 'administration plan satisfied' },
      new Date('2026-08-21T11:00:00.000Z'),
    );
    expect(recovered).toMatchObject({ kind: 'transitioned', airline: { status: 'active' } });

    const ceased = await transitionAirlineStatus(
      db.db,
      airlineId,
      { to: 'ceased', reason: 'owner ended operations' },
      new Date('2026-08-21T12:00:00.000Z'),
    );
    expect(ceased).toMatchObject({
      kind: 'transitioned',
      airline: { status: 'ceased', ceasedAt: new Date('2026-08-21T12:00:00.000Z') },
    });
    await expect(
      transitionAirlineStatus(db.db, airlineId, { to: 'active', reason: 'too late' }),
    ).rejects.toThrow(/cannot transition from ceased to active/);

    const transitions = await db.db
      .select()
      .from(airlineStatusTransition)
      .where(eq(airlineStatusTransition.airlineId, airlineId))
      .orderBy(asc(airlineStatusTransition.recordedAt));
    expect(transitions.map((entry) => [entry.fromStatus, entry.toStatus, entry.reason])).toEqual([
      ['active', 'restricted', 'cash runway exhausted'],
      ['restricted', 'active', 'administration plan satisfied'],
      ['active', 'ceased', 'owner ended operations'],
    ]);
  });

  it('anonymizes a player end to end while keeping airline, flight, result and audit history', async () => {
    const worldId = await makeWorld();
    const playerId = await makePlayer('Amelia History');
    const airlineId = await makeAirline(worldId, playerId, { iata: 'AH', icao: 'AHY' });
    await makeAirport('AHA1');
    await makeAirport('AHA2');

    await db.db.insert(playerIdentity).values({
      playerId,
      provider: 'google',
      subject: `history-${String(sequence++)}`,
      email: 'amelia@example.test',
    });
    await createSession(db.db, playerId, 1);
    await db.db.insert(adminGrant).values({ playerId });
    await db.db.insert(adminAudit).values({
      actorPlayerId: playerId,
      actorLabel: 'Amelia History',
      action: 'player.viewed',
      subjectType: 'player',
      subjectId: playerId,
    });

    const routes = await db.db
      .insert(route)
      .values({
        worldId,
        airlineId,
        originIcao: 'AHA1',
        destinationIcao: 'AHA2',
        greatCircleNm: 200,
      })
      .returning({ id: route.id });
    const schedules = await db.db
      .insert(schedule)
      .values({
        worldId,
        airlineId,
        airframeId: '11111111-2222-4333-8444-555555555555',
        repeatKind: 'daily',
      })
      .returning({ id: schedule.id });
    const flights = await db.db
      .insert(flight)
      .values({
        worldId,
        airlineId,
        scheduleId: schedules[0]?.id,
        airframeId: '11111111-2222-4333-8444-555555555555',
        originIcao: 'AHA1',
        destinationIcao: 'AHA2',
        phase: 'idle',
        scheduledDeparture: new Date('2026-08-21T09:00:00.000Z'),
        actualDeparture: new Date('2026-08-21T09:02:00.000Z'),
        estimatedArrival: new Date('2026-08-21T10:00:00.000Z'),
        actualArrival: new Date('2026-08-21T10:03:00.000Z'),
      })
      .returning({ id: flight.id });
    const flightId = flights[0]?.id;
    if (!flightId) throw new Error('no flight created');
    await db.db.insert(flightResult).values({
      worldId,
      flightId,
      airlineId,
      revenueMinor: 20_000,
      costMinor: 12_000,
      netMinor: 8_000,
      seats: 50,
      passengers: 40,
      blockSeconds: 3_600,
      breakdown: '{}',
      settlementVersion: 'v1',
      settledAt: new Date('2026-08-21T10:03:00.000Z'),
    });

    const result = await anonymizePlayerForWorldHistory(
      db.db,
      playerId,
      new Date('2026-08-21T12:00:00.000Z'),
    );
    expect(result).toEqual({
      kind: 'anonymized',
      alreadyAnonymized: false,
      airlinesCeased: 1,
      identitiesRemoved: 1,
      sessionsRemoved: 1,
      adminGrantsRemoved: 1,
    });

    const storedPlayer = await db.db.select().from(player).where(eq(player.id, playerId));
    expect(storedPlayer[0]).toMatchObject({
      displayName: 'Deleted player',
      avatarUrl: null,
      anonymizedAt: new Date('2026-08-21T12:00:00.000Z'),
    });
    expect(
      await db.db.select().from(playerIdentity).where(eq(playerIdentity.playerId, playerId)),
    ).toEqual([]);
    expect(await db.db.select().from(session).where(eq(session.playerId, playerId))).toEqual([]);
    expect(await db.db.select().from(adminGrant).where(eq(adminGrant.playerId, playerId))).toEqual(
      [],
    );

    const storedAirline = await db.db.select().from(airline).where(eq(airline.id, airlineId));
    expect(storedAirline[0]).toMatchObject({
      status: 'ceased',
      iataCode: 'AH',
      icaoCode: 'AHY',
      ceasedAt: new Date('2026-08-21T12:00:00.000Z'),
    });
    expect(await db.db.select().from(route).where(eq(route.id, routes[0]!.id))).toEqual([
      expect.objectContaining({ active: false }),
    ]);
    expect(await db.db.select().from(schedule).where(eq(schedule.id, schedules[0]!.id))).toEqual([
      expect.objectContaining({ active: false }),
    ]);
    const history = await db.db
      .select({ flightId: flight.id, airlineName: airline.name, netMinor: flightResult.netMinor })
      .from(flight)
      .innerJoin(airline, eq(airline.id, flight.airlineId))
      .innerJoin(flightResult, eq(flightResult.flightId, flight.id))
      .where(eq(flight.id, flightId));
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ flightId, netMinor: 8_000 });
    expect(history[0]?.airlineName).toMatch(/Lifecycle Air/);
    expect(
      await db.db.select().from(adminAudit).where(eq(adminAudit.actorPlayerId, playerId)),
    ).toEqual([expect.objectContaining({ actorLabel: 'Amelia History' })]);

    // The ceased row remains unambiguous by UUID, but no longer consumes the
    // live namespace or the live-statistics predicate.
    expect(
      await db.db
        .select()
        .from(airline)
        .where(and(eq(airline.worldId, worldId), liveAirlineWhere())),
    ).toEqual([]);
    const successorPlayerId = await makePlayer('Successor');
    await expect(
      makeAirline(worldId, successorPlayerId, { iata: 'AH', icao: 'AHY' }),
    ).resolves.toBeTruthy();
  });
});
