import { ACTIVE_WORLD_HEADER } from '../airline/context';

import { createAuthorizationTestSuite, type AuthorizationTestSuite } from './authorization';
import {
  createFoundedAirlineFixtureHarness,
  type FoundedAirlineFixture,
  type FoundedAirlineFixtureHarness,
} from './founded-airline';

import type { DatabaseHandle } from '../db/client';
import type { ServerEnv } from '../env';
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';

/**
 * The cross-player ownership fixture (SEC-05).
 *
 * There is a whole class of bug the route guard cannot catch: the caller *is*
 * signed in, the handler acts on the id it was handed, and the id belongs to
 * somebody else. Catching it needs a second player who owns a second thing, and
 * the test that would write it is the one nobody writes — because writing it
 * means founding a second airline. So this founds it once, here, for everyone.
 *
 * ## What it lays out
 *
 * Two players, each owning a real founded airline in **one shared world**, plus
 * a third airline owned by the first player in a **second world**:
 *
 * ```
 *   worldMain   ─┬─ airlineA        owned by playerA
 *                └─ airlineB        owned by playerB
 *   worldOther  ─── airlineAOther   owned by playerA
 * ```
 *
 * `airlineB` is the cross-*player* case: playerA must not reach it. `airlineAOther`
 * is the cross-*world* case, and it is the subtle one — the player id matches, so
 * a guard that checks only the player and forgets the world lets it through. An
 * airline is a player's presence in one world, and ownership is therefore two
 * parts; this fixture exists to make the second part testable.
 *
 * ## Built from the two harnesses that already exist, not a third
 *
 * The identities, their sessions and the app come from
 * {@link createAuthorizationTestSuite} (SEC-02); the airlines come from
 * {@link createFoundedAirlineFixtureHarness} (AIR-11). An airline here is
 * **founded, never inserted** — CLAUDE.md's rule, and the reason cleanup can
 * trust that every row it made is a row `foundAirline` would have made.
 *
 * The founded harness is given `playerA`/`playerB` rather than inventing its own,
 * so it does not own those players and does not delete them; the authorization
 * suite does. That ordering is the whole of the cleanup contract below.
 */

export interface OwnershipTestSuiteOptions {
  db: DatabaseHandle;
  env: ServerEnv;
  /** Stable and unique within the test file; the deterministic fixture namespace. */
  suite: string;
}

/** How a request is addressed: as which player, in which world. */
export interface AsOwnerOptions {
  /** `'playerA'` or `'playerB'`; the guest and admin come from the suite directly. */
  actor: 'playerA' | 'playerB';
  /** The world to name in the `x-tailfin-world-id` header. Omit to send none. */
  worldId?: string;
}

export interface OwnershipTestSuite {
  app: FastifyInstance;
  /** The identities, sessions and cleanup from the authorization suite. */
  authorization: AuthorizationTestSuite;
  /** The world both playerA and playerB have an airline in. */
  worldMain: FoundedAirlineFixture['world'];
  /** A second world, where only playerA has an airline. */
  worldOther: FoundedAirlineFixture['world'];
  /** playerA's airline in `worldMain`. */
  airlineA: FoundedAirlineFixture;
  /** playerB's airline in `worldMain` — the cross-player case. */
  airlineB: FoundedAirlineFixture;
  /** playerA's airline in `worldOther` — the cross-world case, same player id. */
  airlineAOther: FoundedAirlineFixture;
  /**
   * Inject a request as one of the owners, with its session cookie and the
   * active-world header already set. The one place a test says "as playerA, in
   * worldMain" without re-deriving the cookie and header each time.
   */
  as(who: AsOwnerOptions, request: InjectOptions): Promise<LightMyRequestResponse>;
  /** Idempotent, identity-scoped cleanup for this suite only. */
  cleanup(): Promise<void>;
}

/**
 * Create the ownership fixtures.
 *
 * `foundAirline` needs an open world, so `airlineA` is founded first without a
 * world and creates one; `airlineB` reuses it, so they share `worldMain`.
 * `airlineAOther` is founded without a world too, so it gets its own `worldOther`.
 */
export async function createOwnershipTestSuite({
  db,
  env,
  suite,
}: OwnershipTestSuiteOptions): Promise<OwnershipTestSuite> {
  const authorization = await createAuthorizationTestSuite({ db, env, suite });
  const airlines: FoundedAirlineFixtureHarness = createFoundedAirlineFixtureHarness(db.db);

  try {
    const playerA = authorization.identities.playerA.playerId;
    const playerB = authorization.identities.playerB.playerId;
    if (playerA === null || playerB === null) {
      throw new Error('Ownership fixture expected the authorization suite to seat two players');
    }

    // playerA in a fresh, opened world.
    const airlineA = await airlines.create({ playerId: playerA });
    // playerB in the same world: the cross-player case shares a world so that a
    // guard keying on the world alone would still be wrong.
    const airlineB = await airlines.create({ playerId: playerB, worldId: airlineA.world.id });
    // playerA again, in a different world: the cross-world case, same player id.
    const airlineAOther = await airlines.create({ playerId: playerA });

    const cookieFor = (actor: 'playerA' | 'playerB') => authorization.identities[actor].cookie;

    return {
      app: authorization.app,
      authorization,
      worldMain: airlineA.world,
      worldOther: airlineAOther.world,
      airlineA,
      airlineB,
      airlineAOther,
      async as({ actor, worldId }, request) {
        const headers: Record<string, string> = {
          ...(request.headers as Record<string, string> | undefined),
        };
        const cookie = cookieFor(actor);
        if (cookie !== undefined) headers.cookie = cookie;
        if (worldId !== undefined) headers[ACTIVE_WORLD_HEADER] = worldId;
        return authorization.app.inject({ ...request, headers });
      },
      async cleanup() {
        // Airlines before players, always. The airline → player reference is
        // `ON DELETE RESTRICT`, so deleting a player the authorization suite owns
        // while its founded airline still stands would throw — and the founded
        // harness does not own these players, so it will not do it for us.
        await airlines.cleanup();
        await authorization.cleanup();
      },
    };
  } catch (error) {
    await airlines.cleanup();
    await authorization.cleanup();
    throw error;
  }
}
