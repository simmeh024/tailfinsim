import { type WorldConfig } from '@tailfin/shared';

import { economyConfigFor } from '../economy/config';

/**
 * Rejects a config that would break the reset contract.
 *
 * The zod schema in `@tailfin/shared` gets the shape; this gets the meaning, and
 * lives here because it is a rule about how the server behaves rather than part
 * of the wire contract.
 *
 * An epoch at or after `now` makes `gameTime` start in the future and makes a
 * reset a no-op — the exact failure ADR-0005 exists to prevent, and one that
 * would be discovered weeks later by someone trying to reset.
 */
export function assertUsableConfig(config: WorldConfig, now: Date): void {
  const epochMs = Date.parse(config.epoch);
  if (Number.isNaN(epochMs)) {
    throw new Error(`Epoch ${config.epoch} is not a valid date`);
  }
  if (epochMs >= now.getTime()) {
    throw new Error(
      `Epoch ${config.epoch} is not in the past. A world's epoch is where its calendar ` +
        'begins, and a reset returns to it — so an epoch of "now" makes a reset ' +
        'meaningless (ADR-0005).',
    );
  }
  if (!economyConfigFor(config.economyConfigVersion)) {
    throw new Error(
      `Economy config ${config.economyConfigVersion} is not registered. ` +
        'A world must pin a known immutable version when it is created (AIR-03).',
    );
  }
}
