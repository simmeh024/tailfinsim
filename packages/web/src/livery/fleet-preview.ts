import type { LiveryLayer } from '@tailfin/shared';

import { aircraftVisual, type AircraftVisualAsset } from '../fleet/aircraft-visuals';

const VISUAL_DESIGNATION_BY_FAMILY = Object.freeze({
  'ATR 72': 'ATR 72-600',
  'Dash 8': 'Dash 8-400',
  'E-Jet E2': 'E190-E2',
  A220: 'A220-300',
  '737NG': '737-800',
  '737 MAX': '737 MAX 8',
  A320neo: 'A320neo',
  '787': '787-9',
  A350: 'A350-900',
  '777': '777-300ER',
  '777X': '777-9',
  A380: 'A380-800',
  '747': '747-8F',
} satisfies Readonly<Record<string, string>>);

/**
 * M6 authors one document per aircraft family, while the fleet catalogue owns
 * model-specific renders. Use the launch model that best represents each
 * family so the studio can share the catalogue's visual language and assets.
 */
export function liveryFamilyVisual(family: string): AircraftVisualAsset | null {
  const designation =
    VISUAL_DESIGNATION_BY_FAMILY[family as keyof typeof VISUAL_DESIGNATION_BY_FAMILY];
  return designation === undefined ? null : aircraftVisual(designation);
}

function gradientStops(layer: Extract<LiveryLayer, { type: 'gradient' }>): string {
  return layer.gradient.stops
    .map((stop) => `${stop.color} ${String(Math.round(stop.offset * 10_000) / 100)}%`)
    .join(', ');
}

/**
 * Convert the canonical fill into CSS paint for the illustrative fleet render.
 * The exact zone clipping still comes from the SVG paint map; this projection
 * intentionally preserves the catalogue render's light, panel and window data.
 */
export function fleetPreviewPaint(layer: LiveryLayer): string | null {
  if (layer.type === 'fill') return layer.style.fill;
  if (layer.type !== 'gradient') return null;

  const stops = gradientStops(layer);
  if (layer.gradient.kind === 'radial') {
    const { center } = layer.gradient;
    return `radial-gradient(circle at ${String(center.x * 100)}% ${String(center.y * 100)}%, ${stops})`;
  }

  const { from, to } = layer.gradient;
  const angle = Math.round((Math.atan2(to.y - from.y, to.x - from.x) * 180) / Math.PI + 90);
  return `linear-gradient(${String(angle)}deg, ${stops})`;
}

export function fleetPreviewBlendMode(layer: LiveryLayer): string {
  return layer.blendMode === 'normal' ? 'color' : layer.blendMode;
}
