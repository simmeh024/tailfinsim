import { z } from 'zod';

import { ECONOMY_CONFIG_V1_VERSION } from './economy-config';

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

/**
 * The largest speed multiplier a world can hold, and it is a storage fact rather
 * than a game-design one: `world.speed_multiplier` is `numeric(4,2)`, so 99.99 is
 * the last value that fits.
 *
 * This bound read 100 until M1A-03. Nothing had tried it, but a world created at
 * exactly 100 would have been refused by Postgres with a numeric overflow —
 * which is not a constraint violation, so it would have escaped the translation
 * in `admin/worlds.ts` and surfaced as a 500 with no explanation. Two decimal
 * places, for the same reason: anything finer is silently rounded on the way in.
 */
export const MAX_SPEED_MULTIPLIER = 99.99;
export const SPEED_MULTIPLIER_DECIMALS = 2;

export const WorldConfig = z.object({
  name: z.string().min(1).max(64),

  /**
   * Where the in-game calendar begins. **Never a current or future date** —
   * see the note on the flagship epoch above.
   */
  epoch: z.iso.datetime(),

  /** 2 for the flagship world. Game time runs at this multiple of wall clock. */
  speedMultiplier: z.number().positive().max(MAX_SPEED_MULTIPLIER),

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
  economyConfigVersion: ECONOMY_CONFIG_V1_VERSION,
  playerCap: null,
};

/* ------------------------------------------------- era presets (M11-02) ---- */

/**
 * A named starting configuration (§22.2).
 *
 * A preset is **a `WorldConfig` with a label on it**, and deliberately nothing
 * more. It is not a second way to create a world: the console offers one of
 * these, the operator edits the name or the speed if they want to, and posts the
 * result to the ordinary create endpoint. That keeps exactly one path into
 * `world`, so a preset cannot acquire powers the create endpoint does not have.
 */
export const WorldPreset = z.object({
  /** Stable identifier, safe in a URL or a radio group. */
  id: z.string().min(1),
  label: z.string().min(1),
  /** What the era plays like, in one sentence, for the operator choosing. */
  description: z.string().min(1),
  config: WorldConfig,
});
export type WorldPreset = z.infer<typeof WorldPreset>;

export const WorldPresetsResponse = z.object({ presets: z.array(WorldPreset) });
export type WorldPresetsResponse = z.infer<typeof WorldPresetsResponse>;

/** Every preset shares the shipped catalogue and economy; only the era differs. */
function eraConfig(name: string, epoch: string, speedMultiplier = 2): WorldConfig {
  return {
    name,
    epoch,
    speedMultiplier,
    aircraftCatalogueVersion: 'v1',
    economyConfigVersion: ECONOMY_CONFIG_V1_VERSION,
    playerCap: null,
  };
}

/**
 * §22.2's era presets.
 *
 * The epoch is what makes these different worlds rather than differently named
 * ones: M4-02 gates the aircraft catalogue on the world's own clock, so a 1950
 * world genuinely lists piston airliners and cannot see a jet, and a 1978 world
 * opens with the fleet deregulation was fought with. Nothing else in the config
 * has to change for that to be true, which is why these are so small.
 *
 * Sandbox is the exception and is honest about it: the flagship epoch at eight
 * times speed, for trying something quickly rather than for playing.
 */
export const ERA_PRESETS: readonly WorldPreset[] = [
  {
    id: 'piston-prop-1950',
    label: 'Piston & Prop (1950)',
    description:
      'Propliners, short sectors and frequent fuel stops. No jets exist yet, so the network is built out of range rather than speed.',
    config: eraConfig('Piston & Prop', '1950-01-01T00:00:00.000Z'),
  },
  {
    id: 'jet-age-1958',
    label: 'Jet Age (1958)',
    description:
      'The first jets enter service alongside the propliners they replace. Long-haul stops being a relay.',
    config: eraConfig('Jet Age', '1958-01-01T00:00:00.000Z'),
  },
  {
    id: 'widebody-1970',
    label: 'Widebody (1970)',
    description:
      'Mass long-haul: seat costs fall, capacity arrives in units too large to fill by accident.',
    config: eraConfig('Widebody', '1970-01-01T00:00:00.000Z'),
  },
  {
    id: 'deregulation-1978',
    label: 'Deregulation (1978)',
    description:
      'Route authority loosens and hubs matter. The era where a network decision beats an aircraft decision.',
    config: eraConfig('Deregulation', '1978-01-01T00:00:00.000Z'),
  },
  {
    id: 'modern-2024',
    label: 'Modern (2024)',
    description:
      'The flagship era: the full catalogue, current economics, and the tightest margins.',
    config: eraConfig('Modern', FLAGSHIP_CONFIG.epoch),
  },
  {
    id: 'sandbox',
    label: 'Sandbox',
    description:
      'The modern era at 8× speed, for trying something and seeing the consequence the same afternoon. Not a world to play in.',
    config: eraConfig('Sandbox', FLAGSHIP_CONFIG.epoch, 8),
  },
];
