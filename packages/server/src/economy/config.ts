import {
  ECONOMY_CONFIG_V1_VERSION,
  EconomyConfig,
  type EconomyConfig as EconomyConfigContract,
} from '@tailfin/shared';

/** An economy version is immutable once a world can pin it. */
export type PinnedEconomyConfig = Readonly<
  Omit<EconomyConfigContract, 'airlineStartingPosition' | 'airlineIdentity'> & {
    airlineStartingPosition: Readonly<EconomyConfigContract['airlineStartingPosition']>;
    airlineIdentity: Readonly<EconomyConfigContract['airlineIdentity']>;
  }
>;

/** Parse at the registry boundary and freeze both levels players' terms read. */
function defineEconomyConfig(input: unknown): PinnedEconomyConfig {
  const parsed = EconomyConfig.parse(input);
  return Object.freeze({
    ...parsed,
    airlineStartingPosition: Object.freeze({ ...parsed.airlineStartingPosition }),
    airlineIdentity: Object.freeze({ ...parsed.airlineIdentity }),
  });
}

/**
 * The first versioned economy payload (AIR-03).
 *
 * The design writes "$500K", but §24 leaves the accounting currency open and
 * M8-02 owns that decision. This is therefore 50,000,000 integer minor units of
 * the world's deliberately unnamed currency, not an assumption of dollars.
 */
export const ECONOMY_CONFIG_V1 = defineEconomyConfig({
  version: ECONOMY_CONFIG_V1_VERSION,
  airlineStartingPosition: {
    openingCashMinor: 50_000_000,
    freeHubAllowance: 1,
  },
  airlineIdentity: {
    // 25,000 major units: meaningful beside the 500,000 opening position without being punitive.
    rebrandCostMinor: 2_500_000,
  },
});

const ECONOMY_CONFIGS: ReadonlyMap<string, PinnedEconomyConfig> = new Map([
  [ECONOMY_CONFIG_V1.version, ECONOMY_CONFIG_V1],
]);

/** The immutable config a world pinned, or null rather than a silent fallback. */
export function economyConfigFor(version: string): PinnedEconomyConfig | null {
  return ECONOMY_CONFIGS.get(version) ?? null;
}
