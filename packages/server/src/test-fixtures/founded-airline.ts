import { randomInt, randomUUID } from 'node:crypto';

import { eq } from 'drizzle-orm';

import { FLAGSHIP_CONFIG, type Airline, type AirlineHub, type WorldConfig } from '@tailfin/shared';

import { rankedAirlineCodeCandidates } from '../airline/codes';
import { foundAirline } from '../airline/found';
import { type Database } from '../db/client';
import { airline, airport, player, world, type WorldRow } from '../db/schema';
import { createWorld } from '../world/lifecycle';

type PlayerRow = typeof player.$inferSelect;
type AirportRow = typeof airport.$inferSelect;

export interface FoundedAirlineFixtureOptions {
  /** Reuse an open world. Omit it to create an isolated open world. */
  worldId?: string;
  /** Reuse a player. Omit it to create an isolated owner. */
  playerId?: string;
  /** Reuse an airport as the founder hub. Omit it to create one. */
  hubIdent?: string;
  /** Applied only when the fixture creates its uniquely named world. */
  worldConfig?: Partial<Omit<WorldConfig, 'name'>>;
  displayName?: string;
  name?: string;
  iataCode?: string;
  icaoCode?: string;
  callsign?: string;
  baseCountry?: string;
}

export interface FoundedAirlineFixture {
  world: WorldRow;
  player: PlayerRow;
  airline: Airline;
  hub: AirlineHub;
  hubAirport: AirportRow;
  /** Idempotent, identity-scoped cleanup for this fixture only. */
  cleanup(): Promise<void>;
}

export interface FoundedAirlineFixtureHarness {
  create(options?: FoundedAirlineFixtureOptions): Promise<FoundedAirlineFixture>;
  /** Cleans every outstanding fixture in reverse creation order. */
  cleanup(): Promise<void>;
}

interface OwnedRows {
  airlineId?: string;
  airportId?: string;
  playerId?: string;
  worldId?: string;
  cleaned: boolean;
}

async function cleanupOwnedRows(db: Database, owned: OwnedRows): Promise<void> {
  if (owned.cleaned) return;

  // Delete the airline first even when the world is ours. That also removes its
  // hub, movements and operational graph before the restrictive airport/player
  // references are considered. Every predicate is an id, never a table-wide
  // operation: another test's rows are outside this fixture's authority.
  if (owned.airlineId !== undefined) {
    await db.delete(airline).where(eq(airline.id, owned.airlineId));
  }
  if (owned.worldId !== undefined) {
    await db.delete(world).where(eq(world.id, owned.worldId));
  }
  if (owned.airportId !== undefined) {
    await db.delete(airport).where(eq(airport.id, owned.airportId));
  }
  if (owned.playerId !== undefined) {
    await db.delete(player).where(eq(player.id, owned.playerId));
  }
  owned.cleaned = true;
}

async function existingWorld(db: Database, id: string): Promise<WorldRow> {
  const rows = await db.select().from(world).where(eq(world.id, id)).limit(1);
  const row = rows[0];
  if (!row) throw new Error(`Founded-airline fixture could not find world ${id}`);
  return row;
}

async function existingPlayer(db: Database, id: string): Promise<PlayerRow> {
  const rows = await db.select().from(player).where(eq(player.id, id)).limit(1);
  const row = rows[0];
  if (!row) throw new Error(`Founded-airline fixture could not find player ${id}`);
  return row;
}

async function existingAirport(db: Database, ident: string): Promise<AirportRow> {
  const rows = await db.select().from(airport).where(eq(airport.ident, ident)).limit(1);
  const row = rows[0];
  if (!row) throw new Error(`Founded-airline fixture could not find hub ${ident}`);
  return row;
}

/**
 * A real founded airline for database tests (AIR-11).
 *
 * Defaults create the whole reachable precondition: an open world, a player, a
 * medium founder hub, the airline, and its configured opening cash movement.
 * Callers may provide an existing world/player/hub for multi-airline scenarios;
 * the cleanup record then deliberately does not own those rows.
 *
 * Generated codes are proposed to `foundAirline`, not inserted. A named unique
 * constraint remains the authority, and a collision advances only the generated
 * namespace that collided before retrying. Tests therefore cannot accidentally
 * share a live code even when they deliberately share a world.
 */
export function createFoundedAirlineFixtureHarness(db: Database): FoundedAirlineFixtureHarness {
  const outstanding: FoundedAirlineFixture[] = [];

  return {
    async create(options = {}) {
      const owned: OwnedRows = { cleaned: false };

      try {
        const tag = randomUUID().replaceAll('-', '').slice(0, 12).toUpperCase();
        const createdWorld =
          options.worldId === undefined
            ? await createWorld(db, {
                ...FLAGSHIP_CONFIG,
                ...options.worldConfig,
                name: `fixture-world-${tag}`,
              })
            : undefined;
        if (createdWorld !== undefined && !createdWorld.created) {
          throw new Error(`Founded-airline fixture did not create world ${createdWorld.world.id}`);
        }
        const selectedWorld = createdWorld?.world ?? (await existingWorld(db, options.worldId!));
        if (options.worldId === undefined) {
          owned.worldId = selectedWorld.id;
          const opened = await db
            .update(world)
            .set({ status: 'open' })
            .where(eq(world.id, selectedWorld.id))
            .returning();
          if (!opened[0]) throw new Error('Founded-airline fixture could not open its world');
          Object.assign(selectedWorld, opened[0]);
        }

        const selectedPlayer =
          options.playerId === undefined
            ? (
                await db
                  .insert(player)
                  .values({ displayName: options.displayName ?? `Fixture Founder ${tag}` })
                  .returning()
              )[0]
            : await existingPlayer(db, options.playerId);
        if (!selectedPlayer) throw new Error('Founded-airline fixture inserted no player');
        if (options.playerId === undefined) owned.playerId = selectedPlayer.id;

        const selectedHub =
          options.hubIdent === undefined
            ? (
                await db
                  .insert(airport)
                  .values({
                    // OurAirports ids are positive. A random negative integer is
                    // visibly synthetic and cannot overlap a real import.
                    sourceId: randomInt(-2_147_483_648, 0),
                    ident: `TFX-${tag}`,
                    icaoCode: null,
                    name: `Fixture Hub ${tag}`,
                    isoCountry: options.baseCountry ?? 'NL',
                    kind: 'medium_airport',
                    latitude: 52,
                    longitude: 4,
                    scheduledService: true,
                    hasRunwayData: false,
                    tier: 'medium',
                    slotLevel: 2,
                  })
                  .returning()
              )[0]
            : await existingAirport(db, options.hubIdent);
        if (!selectedHub) throw new Error('Founded-airline fixture inserted no hub');
        if (options.hubIdent === undefined) owned.airportId = selectedHub.id;

        const name = options.name ?? `Fixture Air ${tag}`;
        const iataCandidates =
          options.iataCode === undefined
            ? rankedAirlineCodeCandidates(name, 'iata')
            : [options.iataCode];
        const icaoCandidates =
          options.icaoCode === undefined
            ? rankedAirlineCodeCandidates(name, 'icao')
            : [options.icaoCode];
        let iataIndex = 0;
        let icaoIndex = 0;

        for (;;) {
          const iataCode = iataCandidates[iataIndex];
          const icaoCode = icaoCandidates[icaoIndex];
          if (iataCode === undefined || icaoCode === undefined) {
            throw new Error(
              `Founded-airline fixture exhausted the code namespace in world ${selectedWorld.id}`,
            );
          }

          const result = await foundAirline(db, selectedPlayer.id, {
            worldId: selectedWorld.id,
            name,
            iataCode,
            icaoCode,
            callsign: options.callsign ?? `FIXTURE ${tag}`,
            baseCountry: options.baseCountry ?? 'NL',
            hubIdent: selectedHub.ident,
          });

          if (result.ok) {
            owned.airlineId = result.airline.id;
            const fixture: FoundedAirlineFixture = {
              world: selectedWorld,
              player: selectedPlayer,
              airline: result.airline,
              hub: result.hub,
              hubAirport: selectedHub,
              cleanup: () => cleanupOwnedRows(db, owned),
            };
            outstanding.push(fixture);
            return fixture;
          }

          if (result.kind === 'code-taken' || result.kind === 'code-reserved') {
            if (result.codeKind === 'iata' && options.iataCode === undefined) {
              iataIndex += 1;
              continue;
            }
            if (result.codeKind === 'icao' && options.icaoCode === undefined) {
              icaoIndex += 1;
              continue;
            }
          }

          throw new Error(`Founded-airline fixture was refused: ${result.kind}`);
        }
      } catch (error) {
        await cleanupOwnedRows(db, owned);
        throw error;
      }
    },

    async cleanup() {
      const failures: unknown[] = [];
      for (const fixture of outstanding.splice(0).reverse()) {
        try {
          await fixture.cleanup();
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length > 0) {
        throw new AggregateError(failures, 'Failed to clean founded-airline test fixtures');
      }
    },
  };
}
