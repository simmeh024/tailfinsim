import { z } from 'zod';

import { MinorUnits } from './primitives';

/** The economy version pinned by every world created from the shipped config. */
export const ECONOMY_CONFIG_V1_VERSION = 'v1' as const;

/**
 * The part of economy configuration needed before an airline can exist (AIR-03).
 *
 * M3-11 grows this schema into the complete live-editable economy payload. It
 * starts in shared now so config loaded from code today and JSON tomorrow has
 * one runtime contract rather than a server-only interface that trusts casts.
 */
export const EconomyConfig = z
  .object({
    version: z.string().min(1),
    airlineStartingPosition: z
      .object({
        /** Integer minor units of the world's still-unnamed currency (M8-02). */
        openingCashMinor: MinorUnits.nonnegative(),
        /** Number of hub purchases waived when the airline is founded. */
        freeHubAllowance: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict();
export type EconomyConfig = z.infer<typeof EconomyConfig>;
