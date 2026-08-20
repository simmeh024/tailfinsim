/**
 * Versioned economy configuration consumed when an airline is founded (AIR-03).
 *
 * A world already pins `economy_config_version`; resolving through that pin is
 * what keeps two airlines founded months apart in the same world on the same
 * starting terms. M3-11 will make these records live-editable. Until then this
 * registry is the source of truth, rather than a literal in the founding path.
 */

export interface EconomyConfig {
  version: string;
  airlineStartingPosition: {
    /**
     * Integer minor units of the world's still-unnamed currency.
     *
     * The design writes "$500K", but M8-02 owns the currency decision. Calling
     * this dollars here would quietly decide that debt early.
     */
    openingCashMinor: number;
    /** App. B.5 grants the first hub at any tier. */
    freeHubAllowance: number;
  };
}

export const ECONOMY_CONFIG_V1: EconomyConfig = {
  version: 'v1',
  airlineStartingPosition: {
    openingCashMinor: 50_000_000,
    freeHubAllowance: 1,
  },
};

const ECONOMY_CONFIGS = new Map<string, EconomyConfig>([
  [ECONOMY_CONFIG_V1.version, ECONOMY_CONFIG_V1],
]);

/** The config a world pinned, or null if the server does not know that version. */
export function economyConfigFor(version: string): EconomyConfig | null {
  return ECONOMY_CONFIGS.get(version) ?? null;
}
