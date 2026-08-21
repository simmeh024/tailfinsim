import { type WorldConfig } from '@tailfin/shared';

/** Whether a version is one a world could pin. `economy/loader.ts` supplies it. */
export type EconomyVersionCheck = (version: string) => Promise<boolean>;

/**
 * The two pins a world carries, and the checks that say whether they resolve.
 *
 * Two, not one, and separately versioned on purpose: §22.5 versions the aircraft
 * catalogue and §22.3 the economy, and M3-11 records why they must not share a
 * number — a fare change and an aerodynamics change would become
 * indistinguishable in a `flight_result`.
 */
export interface WorldPinChecks {
  economyVersionExists: EconomyVersionCheck;
  catalogueVersionExists: EconomyVersionCheck;
}

/**
 * Rejects a config that would break the reset contract.
 *
 * The zod schema in `@tailfin/shared` gets the shape; this gets the meaning, and
 * lives here because it is a rule about how the server behaves rather than part
 * of the wire contract.
 *
 * Asynchronous since M3-11, because one of those meanings — is this a real
 * economy version? — became a fact about the database rather than about a
 * registry in code. The lookup is passed in rather than performed here, so this
 * stays a rule about worlds instead of becoming a second place that knows how
 * `economy_config` is stored.
 *
 * An epoch at or after `now` makes `gameTime` start in the future and makes a
 * reset a no-op — the exact failure ADR-0005 exists to prevent, and one that
 * would be discovered weeks later by someone trying to reset.
 */
export async function assertUsableConfig(
  config: WorldConfig,
  now: Date,
  checks: WorldPinChecks,
): Promise<void> {
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
  if (!(await checks.economyVersionExists(config.economyConfigVersion))) {
    throw new Error(
      `Economy config ${config.economyConfigVersion} is not in economy_config. ` +
        'A world must pin a version that exists when it is created (AIR-03, M3-11). ' +
        'The shipped version is seeded at startup; a tuned one is created through the admin API.',
    );
  }
  if (!(await checks.catalogueVersionExists(config.aircraftCatalogueVersion))) {
    throw new Error(
      `Aircraft catalogue ${config.aircraftCatalogueVersion} is not in aircraft_type. ` +
        'A world must pin a catalogue version that exists when it is created (M4-01, §22.5). ' +
        'The shipped version is seeded at startup.',
    );
  }
}
