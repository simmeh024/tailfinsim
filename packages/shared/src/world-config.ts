import { z } from 'zod';

/**
 * A world, as configuration (M1-09, §22.2).
 *
 * "Worlds are defined entirely by config so they are reproducible from source."
 * That is the whole point of this file: a world's identity is a JSON object, and
 * creating one from that object twice gives the same world twice. It is also
 * what makes a full reset safe to run repeatedly — the config is the source of
 * truth, and the database is a projection of it.
 */

/**
 * The flagship world (§3.1b).
 *
 * The epoch is fixed at 2024-10-20 and never moves. ADR-0005 is built on that:
 * a reset returns the calendar to the epoch *by definition*, because it sets
 * `launch_date` to now and leaves `epoch` alone. An epoch that drifted to "now"
 * would make a reset mean nothing.
 */
export const FLAGSHIP_WORLD_NAME = 'Flagship';

export const WorldConfig = z.object({
  name: z.string().min(1).max(64),

  /**
   * Where the in-game calendar begins. **Never a current or future date** —
   * see the note on the flagship epoch above.
   */
  epoch: z.iso.datetime(),

  /** 2 for the flagship world. Game time runs at this multiple of wall clock. */
  speedMultiplier: z.number().positive().max(100),

  /** Pinned so retuning aircraft or economy does not change a running world (§22.2, §22.5). */
  aircraftCatalogueVersion: z.string().min(1),
  economyConfigVersion: z.string().min(1),

  /** Null means uncapped. */
  playerCap: z.number().int().positive().nullable(),
});
export type WorldConfig = z.infer<typeof WorldConfig>;

/**
 * The standard configuration, and the one M1-09 asks to be seeded.
 *
 * A constant rather than a migration: a migration runs once, and this needs to
 * run again every time a world is recreated from scratch, which during testing
 * is often.
 */
export const FLAGSHIP_CONFIG: WorldConfig = {
  name: FLAGSHIP_WORLD_NAME,
  epoch: '2024-10-20T00:00:00.000Z',
  speedMultiplier: 2,
  aircraftCatalogueVersion: 'v1',
  economyConfigVersion: 'v1',
  playerCap: null,
};
