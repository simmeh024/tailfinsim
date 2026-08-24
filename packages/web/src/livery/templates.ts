import b737MaxSide from '../../../shared/assets/livery/templates/v1/737-max-side.svg?url';
import b737MaxTop from '../../../shared/assets/livery/templates/v1/737-max-top.svg?url';
import b737ngSide from '../../../shared/assets/livery/templates/v1/737ng-side.svg?url';
import b737ngTop from '../../../shared/assets/livery/templates/v1/737ng-top.svg?url';
import b747Side from '../../../shared/assets/livery/templates/v1/747-side.svg?url';
import b747Top from '../../../shared/assets/livery/templates/v1/747-top.svg?url';
import b777Side from '../../../shared/assets/livery/templates/v1/777-side.svg?url';
import b777Top from '../../../shared/assets/livery/templates/v1/777-top.svg?url';
import b777xSide from '../../../shared/assets/livery/templates/v1/777x-side.svg?url';
import b777xTop from '../../../shared/assets/livery/templates/v1/777x-top.svg?url';
import b787Side from '../../../shared/assets/livery/templates/v1/787-side.svg?url';
import b787Top from '../../../shared/assets/livery/templates/v1/787-top.svg?url';
import a220Side from '../../../shared/assets/livery/templates/v1/a220-side.svg?url';
import a220Top from '../../../shared/assets/livery/templates/v1/a220-top.svg?url';
import a320neoSide from '../../../shared/assets/livery/templates/v1/a320neo-side.svg?url';
import a320neoTop from '../../../shared/assets/livery/templates/v1/a320neo-top.svg?url';
import a350Side from '../../../shared/assets/livery/templates/v1/a350-side.svg?url';
import a350Top from '../../../shared/assets/livery/templates/v1/a350-top.svg?url';
import a380Side from '../../../shared/assets/livery/templates/v1/a380-side.svg?url';
import a380Top from '../../../shared/assets/livery/templates/v1/a380-top.svg?url';
import atr72Side from '../../../shared/assets/livery/templates/v1/atr-72-side.svg?url';
import atr72Top from '../../../shared/assets/livery/templates/v1/atr-72-top.svg?url';
import dash8Side from '../../../shared/assets/livery/templates/v1/dash-8-side.svg?url';
import dash8Top from '../../../shared/assets/livery/templates/v1/dash-8-top.svg?url';
import eJetE2Side from '../../../shared/assets/livery/templates/v1/e-jet-e2-side.svg?url';
import eJetE2Top from '../../../shared/assets/livery/templates/v1/e-jet-e2-top.svg?url';

export const LIVERY_TEMPLATE_VERSION = 'v1' as const;
export const LIVERY_TEMPLATE_WIDTH = 1_200 as const;
export const LIVERY_TEMPLATE_HEIGHT = 400 as const;

export type LiveryTemplateProjection = 'side' | 'top';

export interface AircraftLiveryTemplate {
  id: string;
  family: string;
  slug: string;
  version: typeof LIVERY_TEMPLATE_VERSION;
  projection: LiveryTemplateProjection;
  width: typeof LIVERY_TEMPLATE_WIDTH;
  height: typeof LIVERY_TEMPLATE_HEIGHT;
  src: string;
}

export interface AircraftLiveryTemplatePair {
  family: string;
  slug: string;
  side: AircraftLiveryTemplate;
  top: AircraftLiveryTemplate;
}

function asset(
  family: string,
  slug: string,
  projection: LiveryTemplateProjection,
  src: string,
): AircraftLiveryTemplate {
  return Object.freeze({
    id: `${slug}-${projection}-${LIVERY_TEMPLATE_VERSION}`,
    family,
    slug,
    version: LIVERY_TEMPLATE_VERSION,
    projection,
    width: LIVERY_TEMPLATE_WIDTH,
    height: LIVERY_TEMPLATE_HEIGHT,
    src,
  });
}

function pair(family: string, slug: string, side: string, top: string): AircraftLiveryTemplatePair {
  return Object.freeze({
    family,
    slug,
    side: asset(family, slug, 'side', side),
    top: asset(family, slug, 'top', top),
  });
}

/**
 * One pair per family in the v1 launch catalogue, in catalogue order.
 *
 * The URLs are the only browser-specific part. The SVG sources live under
 * `packages/shared/assets`, where M6-06's server renderer can consume the exact
 * same files without importing the web package.
 */
export const AIRCRAFT_LIVERY_TEMPLATES: readonly AircraftLiveryTemplatePair[] = Object.freeze([
  pair('ATR 72', 'atr-72', atr72Side, atr72Top),
  pair('Dash 8', 'dash-8', dash8Side, dash8Top),
  pair('E-Jet E2', 'e-jet-e2', eJetE2Side, eJetE2Top),
  pair('A220', 'a220', a220Side, a220Top),
  pair('737NG', '737ng', b737ngSide, b737ngTop),
  pair('737 MAX', '737-max', b737MaxSide, b737MaxTop),
  pair('A320neo', 'a320neo', a320neoSide, a320neoTop),
  pair('787', '787', b787Side, b787Top),
  pair('A350', 'a350', a350Side, a350Top),
  pair('777', '777', b777Side, b777Top),
  pair('777X', '777x', b777xSide, b777xTop),
  pair('A380', 'a380', a380Side, a380Top),
  pair('747', '747', b747Side, b747Top),
]);

const templatesByFamily = new Map(
  AIRCRAFT_LIVERY_TEMPLATES.map((templatePair) => [templatePair.family, templatePair]),
);

export function aircraftLiveryTemplate(
  family: string,
  projection: LiveryTemplateProjection,
): AircraftLiveryTemplate | null {
  return templatesByFamily.get(family)?.[projection] ?? null;
}
