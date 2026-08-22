export type WorldProjection = 'flat' | 'globe';

export const WORLD_PROJECTION_STORAGE_KEY = 'tailfin.world.projection';

export interface ProjectionDeviceSignals {
  stored: string | null;
  narrowOrCoarse: boolean;
  deviceMemoryGb: number | undefined;
  hardwareConcurrency: number | undefined;
}

export interface InitialProjection {
  projection: WorldProjection;
  lowPower: boolean;
  source: 'stored' | 'device-default';
}

export function isWorldProjection(value: string | null): value is WorldProjection {
  return value === 'flat' || value === 'globe';
}

export function isLowPowerDevice({
  deviceMemoryGb,
  hardwareConcurrency,
}: Pick<ProjectionDeviceSignals, 'deviceMemoryGb' | 'hardwareConcurrency'>): boolean {
  return (
    (deviceMemoryGb !== undefined && deviceMemoryGb <= 4) ||
    (hardwareConcurrency !== undefined && hardwareConcurrency <= 4)
  );
}

export function chooseInitialProjection(signals: ProjectionDeviceSignals): InitialProjection {
  const lowPower = isLowPowerDevice(signals);
  if (isWorldProjection(signals.stored)) {
    return { projection: signals.stored, lowPower, source: 'stored' };
  }
  return {
    projection: signals.narrowOrCoarse || lowPower ? 'flat' : 'globe',
    lowPower,
    source: 'device-default',
  };
}

function storedProjection(): string | null {
  try {
    return globalThis.localStorage?.getItem(WORLD_PROJECTION_STORAGE_KEY) ?? null;
  } catch {
    return null;
  }
}

/** Browser signals used only for the first-run default; a saved choice always wins. */
export function readInitialProjection(): InitialProjection {
  const browserNavigator = globalThis.navigator as Navigator & { deviceMemory?: number };
  return chooseInitialProjection({
    stored: storedProjection(),
    narrowOrCoarse:
      globalThis.matchMedia?.('(max-width: 48rem), (pointer: coarse)').matches ?? false,
    deviceMemoryGb: browserNavigator.deviceMemory,
    hardwareConcurrency: browserNavigator.hardwareConcurrency,
  });
}

export function persistProjection(projection: WorldProjection): void {
  try {
    globalThis.localStorage?.setItem(WORLD_PROJECTION_STORAGE_KEY, projection);
  } catch {
    // A private-mode or policy-disabled store must not make the renderer unusable.
  }
}
