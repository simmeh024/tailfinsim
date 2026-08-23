import b737_800_1440 from './assets/aircraft/v1/737-800-1440.webp';
import b737_800_720 from './assets/aircraft/v1/737-800-720.webp';
import b737max8_1440 from './assets/aircraft/v1/737-max-8-1440.webp';
import b737max8_720 from './assets/aircraft/v1/737-max-8-720.webp';
import b747_8f_1440 from './assets/aircraft/v1/747-8f-1440.webp';
import b747_8f_720 from './assets/aircraft/v1/747-8f-720.webp';
import b777_300er_1440 from './assets/aircraft/v1/777-300er-1440.webp';
import b777_300er_720 from './assets/aircraft/v1/777-300er-720.webp';
import b777_9_1440 from './assets/aircraft/v1/777-9-1440.webp';
import b777_9_720 from './assets/aircraft/v1/777-9-720.webp';
import b777f_1440 from './assets/aircraft/v1/777f-1440.webp';
import b777f_720 from './assets/aircraft/v1/777f-720.webp';
import b787_9_1440 from './assets/aircraft/v1/787-9-1440.webp';
import b787_9_720 from './assets/aircraft/v1/787-9-720.webp';
import a220_300_1440 from './assets/aircraft/v1/a220-300-1440.webp';
import a220_300_720 from './assets/aircraft/v1/a220-300-720.webp';
import a320neo_1440 from './assets/aircraft/v1/a320neo-1440.webp';
import a320neo_720 from './assets/aircraft/v1/a320neo-720.webp';
import a321neo_1440 from './assets/aircraft/v1/a321neo-1440.webp';
import a321neo_720 from './assets/aircraft/v1/a321neo-720.webp';
import a321xlr_1440 from './assets/aircraft/v1/a321xlr-1440.webp';
import a321xlr_720 from './assets/aircraft/v1/a321xlr-720.webp';
import a350_1000_1440 from './assets/aircraft/v1/a350-1000-1440.webp';
import a350_1000_720 from './assets/aircraft/v1/a350-1000-720.webp';
import a350_900_1440 from './assets/aircraft/v1/a350-900-1440.webp';
import a350_900_720 from './assets/aircraft/v1/a350-900-720.webp';
import a380_800_1440 from './assets/aircraft/v1/a380-800-1440.webp';
import a380_800_720 from './assets/aircraft/v1/a380-800-720.webp';
import atr72_600_1440 from './assets/aircraft/v1/atr-72-600-1440.webp';
import atr72_600_720 from './assets/aircraft/v1/atr-72-600-720.webp';
import atr72_600f_1440 from './assets/aircraft/v1/atr-72-600f-1440.webp';
import atr72_600f_720 from './assets/aircraft/v1/atr-72-600f-720.webp';
import dash8_400_1440 from './assets/aircraft/v1/dash-8-400-1440.webp';
import dash8_400_720 from './assets/aircraft/v1/dash-8-400-720.webp';
import e190e2_1440 from './assets/aircraft/v1/e190-e2-1440.webp';
import e190e2_720 from './assets/aircraft/v1/e190-e2-720.webp';

/**
 * Type-identity imagery only.
 *
 * This is intentionally a component-independent registry. A later M6 livery,
 * HIST airframe portrait or VIS scene can implement the same contract without
 * changing the catalogue card or detail panel.
 */
export interface AircraftVisualAsset {
  id: string;
  version: 'v1';
  width: 1440;
  height: 960;
  src: string;
  srcSet: string;
  fallback: 'type-silhouette';
}

const visual = (id: string, standard: string, retina: string): AircraftVisualAsset => ({
  id,
  version: 'v1',
  width: 1440,
  height: 960,
  src: standard,
  srcSet: `${standard} 720w, ${retina} 1440w`,
  fallback: 'type-silhouette',
});

export const AIRCRAFT_VISUALS: Readonly<Record<string, AircraftVisualAsset>> = Object.freeze({
  'ATR 72-600': visual('neutral-atr-72-600', atr72_600_720, atr72_600_1440),
  'Dash 8-400': visual('neutral-dash-8-400', dash8_400_720, dash8_400_1440),
  'E190-E2': visual('neutral-e190-e2', e190e2_720, e190e2_1440),
  'A220-300': visual('neutral-a220-300', a220_300_720, a220_300_1440),
  '737-800': visual('neutral-737-800', b737_800_720, b737_800_1440),
  '737 MAX 8': visual('neutral-737-max-8', b737max8_720, b737max8_1440),
  A320neo: visual('neutral-a320neo', a320neo_720, a320neo_1440),
  A321neo: visual('neutral-a321neo', a321neo_720, a321neo_1440),
  A321XLR: visual('neutral-a321xlr', a321xlr_720, a321xlr_1440),
  '787-9': visual('neutral-787-9', b787_9_720, b787_9_1440),
  'A350-900': visual('neutral-a350-900', a350_900_720, a350_900_1440),
  'A350-1000': visual('neutral-a350-1000', a350_1000_720, a350_1000_1440),
  '777-300ER': visual('neutral-777-300er', b777_300er_720, b777_300er_1440),
  '777-9': visual('neutral-777-9', b777_9_720, b777_9_1440),
  'A380-800': visual('neutral-a380-800', a380_800_720, a380_800_1440),
  '777F': visual('neutral-777f', b777f_720, b777f_1440),
  '747-8F': visual('neutral-747-8f', b747_8f_720, b747_8f_1440),
  'ATR 72-600F': visual('neutral-atr-72-600f', atr72_600f_720, atr72_600f_1440),
});

export function aircraftVisual(designation: string): AircraftVisualAsset | null {
  return AIRCRAFT_VISUALS[designation] ?? null;
}
