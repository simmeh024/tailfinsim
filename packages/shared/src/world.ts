import { z } from 'zod';

import { Timestamp, Uuid } from './primitives';

/**
 * A world — the top-level container. Multiple worlds run in parallel (§22.2).
 *
 * Mirrors the `world` table from M0-06. The one thing worth understanding here
 * is what is *absent*: there is no current-date field. In-game time is derived
 * from `epoch`, `launchDate` and `speedMultiplier` and never stored, which is
 * what makes an admin reset a two-field update rather than a data migration.
 * See ADR-0005 and `inGameDate()` in `@tailfin/sim`.
 */

export const WorldStatus = z.enum(['staging', 'open', 'locked', 'archived']);
export type WorldStatus = z.infer<typeof WorldStatus>;

export const World = z.object({
  id: Uuid,
  name: z.string().min(1).max(120),

  /** Where the in-game calendar begins — `2024-10-20T00:00:00Z` for the flagship world (§3.1b). */
  epoch: Timestamp,

  /** The real instant this world's clock started running. Reset moves this, never `epoch`. */
  launchDate: Timestamp,

  /** 2 for the flagship world (§3.1). */
  speedMultiplier: z.number().positive(),

  status: WorldStatus,

  /** Pinned, so retuning aircraft or economy cannot retroactively change a running world. */
  aircraftCatalogueVersion: z.string().min(1),
  economyConfigVersion: z.string().min(1),

  /** `null` means uncapped. */
  playerCap: z.number().int().positive().nullable(),

  createdAt: Timestamp,
});
export type World = z.infer<typeof World>;

/**
 * A world's clock as the client sees it. Sent by the server rather than computed
 * in the browser, because the server is authoritative about time as it is about
 * everything else (§21) — a client with a skewed clock must not disagree about
 * what day it is.
 */
export const WorldClock = z.object({
  worldId: Uuid,
  /** The server's real time when this was produced, so a client can interpolate between polls. */
  serverTime: Timestamp,
  inGameTime: Timestamp,
  speedMultiplier: z.number().positive(),
});
export type WorldClock = z.infer<typeof WorldClock>;
