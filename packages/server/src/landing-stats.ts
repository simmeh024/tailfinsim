import { sql } from 'drizzle-orm';

import { type Database } from './db/client';

/**
 * The two real numbers on the public landing page (LANDING-09).
 *
 * ## No public endpoint, and that is the whole design
 *
 * LANDING-09 calls itself *"the highest-risk issue in the milestone, because it
 * proposes the product's first unauthenticated data endpoint"*. It does not have
 * to. The landing page is **already** a public document this server renders, so
 * the numbers go into it — no new route, no `fetch`, no `connect-src` use, no
 * second thing to rate-limit, and no precedent that the next public endpoint can
 * be argued for on the grounds that the first exists.
 *
 * It also answers that issue's sharpest operational line — *"a landing page must
 * never make a database do work per visitor"* — completely rather than
 * carefully. The counts refresh on a timer, so the database sees at most one
 * query per {@link TTL_MS} no matter how many people are on the page. A hundred
 * visitors a second and an idle afternoon cost the same.
 *
 * And it means the numbers are in the HTML: they survive with JavaScript off,
 * they are there for whatever reads the page for a preview card, and the count-up
 * animation is decoration over a value that is already correct.
 *
 * ## What is counted, and what is deliberately not
 *
 * Two scalars. No world id, no airline id, no player id, no name, no per-world
 * or per-airline breakdown — the response is two integers and there is nothing
 * in it to correlate.
 *
 * **No growth deltas.** The mock wants *+128 today* under each figure, and
 * LANDING-09 is right that publishing a daily growth rate is a business
 * disclosure rather than a technical one: it tells a competitor the product's
 * real trajectory and its daily rhythm. Nobody has taken that decision, so it is
 * not shipped.
 *
 * **No liveness claim.** The labels are "Airlines" and "Aircraft types". Neither
 * says "live", which a five-minute cache could not support anyway.
 *
 * **Flights airborne and passengers today are still absent**, and that is
 * correct rather than unfinished: production has no worker (OPS-12), so both are
 * structurally zero there and always will be until it does. Rendering `0` beside
 * two real numbers would read as a measurement.
 */

/**
 * Five minutes.
 *
 * Longer than the document's own `max-age=60`, so the cache in front never
 * out-lives the data behind it, and long enough that the figures are useless for
 * inferring activity patterns — which is a security property as much as a
 * performance one. Neither number is interesting to the second: one changes when
 * somebody founds an airline, the other when a catalogue version is published.
 */
const TTL_MS = 5 * 60 * 1000;

export interface LandingStats {
  /**
   * Airlines a player founded, excluding ceased ones.
   *
   * **Players only.** NPC carriers are rows in the same table with
   * `kind = 'npc'`, generated per world by `npc:seed` — counting them would
   * inflate a public claim about the game's scale with things the game made
   * itself, which is the same lie as inventing the number, arrived at more
   * politely.
   *
   * `null` means *not known*, never zero.
   */
  airlines: number | null;
  /**
   * Distinct aircraft types in the catalogue.
   *
   * Read from `aircraft_type` rather than from the shipped
   * `AIRCRAFT_CATALOGUE_V1` constant, because those two can disagree and the
   * database is the one that decides what worlds actually fly — CLAUDE.md is
   * explicit that nothing falls back to the shipped catalogue. A build reporting
   * its own array length would be describing itself rather than the game.
   *
   * Distinct by designation across versions, so publishing a v2 does not double
   * the number, and so the figure discloses nothing about which versions exist.
   */
  aircraftTypes: number | null;
}

const UNKNOWN: LandingStats = { airlines: null, aircraftTypes: null };

let cached: { at: number; stats: LandingStats } | null = null;
let inFlight: Promise<LandingStats> | null = null;

/** For tests; not needed in normal operation. */
export function clearLandingStatsCache(): void {
  cached = null;
  inFlight = null;
}

async function query(db: Database): Promise<LandingStats> {
  /*
   * One round trip for both, and two scalar subqueries rather than a join —
   * the shape `countEverything` already uses in the admin overview, and the one
   * CLAUDE.md points at after a correlated subquery in a `select` *list* came
   * back empty against real Postgres. These are uncorrelated: each is a plain
   * aggregate over one table with no reference to an outer row.
   *
   * Bounded by construction. Two index-free counts over tables whose size is the
   * number of airlines and the number of catalogue rows — tens and tens — and
   * they run at most once every five minutes on a box that shares two vCPUs with
   * Postgres.
   */
  const result = await db.execute<{ airlines: number; aircraft_types: number }>(sql`
    select
      (select count(*)::int
         from airline
        where kind = 'player' and status <> 'ceased')      as airlines,
      (select count(distinct designation)::int
         from aircraft_type)                               as aircraft_types
  `);

  const row = result.rows[0];
  if (row === undefined) return UNKNOWN;
  return { airlines: row.airlines, aircraftTypes: row.aircraft_types };
}

/**
 * The current figures, from cache when it is warm.
 *
 * **Never throws, and never delays a second caller.** A landing page that 500s
 * because a count failed would be a worse page than one with two em-dashes, and
 * LANDING-09 requires the strip's failure to be invisible — so a broken query
 * yields the last good values if there are any and `null`s if there are not.
 *
 * The in-flight promise is shared, so a cold cache under load makes one query
 * rather than one per request. That matters here more than in most places: the
 * cold moment is a deploy, and a deploy is when traffic arrives all at once.
 */
export async function readLandingStats(db: Database, now = Date.now()): Promise<LandingStats> {
  if (cached !== null && now - cached.at < TTL_MS) return cached.stats;
  if (inFlight !== null) return inFlight;

  inFlight = query(db)
    .then((stats) => {
      cached = { at: now, stats };
      return stats;
    })
    .catch(() => {
      // Deliberately swallowed. Keep serving the last good numbers if we have
      // them; the caller renders em-dashes if we do not. Retried on the next
      // request rather than backed off, because the cost of a retry is one
      // count and the cost of a stale failure is a permanently blank strip.
      return cached?.stats ?? UNKNOWN;
    })
    .finally(() => {
      inFlight = null;
    });

  return inFlight;
}
