import type { LiveryLayer, LiveryZone } from '@tailfin/shared';

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

export type FleetPreviewZoneShape =
  | { kind: 'polygon'; points: string }
  | { kind: 'ellipse'; cx: number; cy: number; rx: number; ry: number };

const polygon = (points: string): FleetPreviewZoneShape => ({ kind: 'polygon', points });
const ellipse = (cx: number, cy: number, rx: number, ry: number): FleetPreviewZoneShape => ({
  kind: 'ellipse',
  cx,
  cy,
  rx,
  ry,
});

const BODY_ZONE_SHAPES: Readonly<
  Record<
    Exclude<LiveryZone, 'wings' | 'winglets' | 'engine_nacelles'>,
    readonly FleetPreviewZoneShape[]
  >
> = Object.freeze({
  fuselage: [polygon('0,0.48 0.18,0.41 0.68,0.42 0.87,0.46 0.84,0.60 0.67,0.63 0.07,0.70 0,0.63')],
  nose: [polygon('0,0.47 0.25,0.41 0.27,0.67 0,0.71')],
  belly: [polygon('0.02,0.57 0.85,0.52 0.81,0.67 0.07,0.73')],
  tail_fin: [polygon('0.65,0.08 0.87,0.07 0.89,0.53 0.66,0.52')],
  cheatline_band: [polygon('0.01,0.49 0.84,0.44 0.84,0.52 0.01,0.58')],
  door_surrounds: [
    ellipse(0.2, 0.53, 0.024, 0.075),
    ellipse(0.43, 0.51, 0.021, 0.07),
    ellipse(0.69, 0.5, 0.022, 0.068),
  ],
  registration_area: [polygon('0.59,0.45 0.72,0.44 0.73,0.53 0.59,0.55')],
});

interface FleetPreviewSurfaceGeometry {
  wings: readonly FleetPreviewZoneShape[];
  winglets: readonly FleetPreviewZoneShape[];
  engine_nacelles: readonly FleetPreviewZoneShape[];
}

const surfaceGeometry = (
  wings: readonly FleetPreviewZoneShape[],
  winglets: readonly FleetPreviewZoneShape[],
  engineNacelles: readonly FleetPreviewZoneShape[],
): FleetPreviewSurfaceGeometry => ({ wings, winglets, engine_nacelles: engineNacelles });

/**
 * The fleet catalogue renders are intentionally art-directed rather than one
 * mechanically repeated camera. Keep the visible surfaces registered to each
 * family instead of stretching one generic aircraft mask over every image.
 */
const SURFACE_GEOMETRY_BY_FAMILY = Object.freeze({
  'ATR 72': surfaceGeometry(
    [
      polygon('0.13,0.37 0.31,0.40 0.43,0.47 0.39,0.50 0.14,0.44'),
      polygon('0.48,0.45 0.95,0.56 0.94,0.60 0.52,0.54'),
    ],
    [],
    [
      polygon('0.25,0.42 0.31,0.42 0.34,0.48 0.30,0.51 0.25,0.47'),
      polygon('0.49,0.45 0.55,0.47 0.57,0.53 0.52,0.56 0.48,0.51'),
    ],
  ),
  'Dash 8': surfaceGeometry(
    [
      polygon('0.14,0.39 0.33,0.41 0.45,0.47 0.41,0.50 0.14,0.43'),
      polygon('0.49,0.45 0.95,0.51 0.94,0.55 0.52,0.53'),
    ],
    [],
    [
      polygon('0.25,0.43 0.34,0.43 0.37,0.49 0.33,0.52 0.26,0.49'),
      polygon('0.49,0.43 0.58,0.44 0.61,0.51 0.56,0.56 0.49,0.52'),
    ],
  ),
  'E-Jet E2': surfaceGeometry(
    [
      polygon('0.25,0.40 0.30,0.39 0.47,0.49 0.43,0.52 0.28,0.45'),
      polygon('0.43,0.53 0.97,0.55 0.96,0.60 0.48,0.59'),
    ],
    [
      polygon('0.25,0.37 0.27,0.36 0.30,0.42 0.28,0.45'),
      polygon('0.94,0.53 0.98,0.51 0.97,0.60 0.94,0.60'),
    ],
    [ellipse(0.49, 0.64, 0.055, 0.07)],
  ),
  A220: surfaceGeometry(
    [
      polygon('0.27,0.35 0.31,0.34 0.48,0.48 0.44,0.51 0.29,0.42'),
      polygon('0.43,0.55 0.96,0.56 0.95,0.61 0.48,0.61'),
    ],
    [
      polygon('0.27,0.32 0.29,0.31 0.31,0.37 0.29,0.42'),
      polygon('0.91,0.55 0.97,0.51 0.96,0.61 0.92,0.62'),
    ],
    [ellipse(0.48, 0.65, 0.055, 0.07)],
  ),
  '737NG': surfaceGeometry(
    [
      polygon('0.29,0.32 0.33,0.31 0.47,0.50 0.43,0.53 0.31,0.39'),
      polygon('0.41,0.55 0.95,0.57 0.92,0.66 0.46,0.62'),
    ],
    [
      polygon('0.29,0.30 0.31,0.29 0.33,0.34 0.31,0.39'),
      polygon('0.91,0.56 0.96,0.52 0.94,0.66 0.91,0.66'),
    ],
    [ellipse(0.45, 0.68, 0.052, 0.068)],
  ),
  '737 MAX': surfaceGeometry(
    [
      polygon('0.23,0.37 0.26,0.37 0.46,0.49 0.42,0.52 0.25,0.43'),
      polygon('0.42,0.52 0.97,0.54 0.94,0.60 0.47,0.58'),
    ],
    [
      polygon('0.23,0.34 0.25,0.34 0.26,0.39 0.25,0.43'),
      polygon('0.91,0.52 0.97,0.47 0.96,0.60 0.92,0.59'),
    ],
    [ellipse(0.49, 0.64, 0.055, 0.07)],
  ),
  A320neo: surfaceGeometry(
    [
      polygon('0.17,0.14 0.21,0.12 0.45,0.45 0.40,0.49 0.20,0.28'),
      polygon('0.38,0.54 0.98,0.62 0.95,0.70 0.44,0.63'),
    ],
    [
      polygon('0.17,0.10 0.20,0.08 0.22,0.17 0.20,0.28'),
      polygon('0.92,0.60 0.98,0.54 0.96,0.70 0.92,0.69'),
    ],
    [ellipse(0.46, 0.69, 0.065, 0.085)],
  ),
  '787': surfaceGeometry(
    [
      polygon('0.31,0.24 0.34,0.22 0.45,0.47 0.41,0.50 0.33,0.38'),
      polygon('0.38,0.54 0.96,0.62 0.94,0.68 0.44,0.61'),
    ],
    [],
    [ellipse(0.49, 0.66, 0.065, 0.08), ellipse(0.27, 0.47, 0.035, 0.045)],
  ),
  A350: surfaceGeometry(
    [
      polygon('0.29,0.31 0.32,0.29 0.45,0.48 0.41,0.51 0.31,0.39'),
      polygon('0.40,0.55 0.98,0.57 0.95,0.63 0.45,0.61'),
    ],
    [
      polygon('0.29,0.29 0.31,0.28 0.32,0.33 0.31,0.39'),
      polygon('0.95,0.56 0.99,0.53 0.97,0.63 0.95,0.63'),
    ],
    [ellipse(0.52, 0.65, 0.055, 0.07)],
  ),
  '777': surfaceGeometry(
    [
      polygon('0.29,0.32 0.32,0.31 0.42,0.49 0.38,0.52 0.31,0.40'),
      polygon('0.38,0.53 0.98,0.53 0.95,0.61 0.43,0.60'),
    ],
    [],
    [ellipse(0.46, 0.67, 0.06, 0.08)],
  ),
  '777X': surfaceGeometry(
    [
      polygon('0.30,0.33 0.33,0.31 0.45,0.46 0.41,0.49 0.32,0.39'),
      polygon('0.39,0.52 0.98,0.51 0.95,0.59 0.44,0.58'),
    ],
    [],
    [ellipse(0.48, 0.61, 0.06, 0.075)],
  ),
  A380: surfaceGeometry(
    [
      polygon('0.32,0.36 0.37,0.35 0.46,0.51 0.41,0.54 0.34,0.43'),
      polygon('0.29,0.55 0.98,0.60 0.95,0.67 0.34,0.62'),
    ],
    [polygon('0.95,0.58 0.98,0.57 0.97,0.67 0.95,0.66')],
    [ellipse(0.45, 0.68, 0.047, 0.065), ellipse(0.61, 0.7, 0.047, 0.065)],
  ),
  '747': surfaceGeometry(
    [
      polygon('0.29,0.38 0.32,0.37 0.43,0.48 0.39,0.51 0.31,0.43'),
      polygon('0.33,0.54 0.99,0.52 0.96,0.63 0.38,0.62'),
    ],
    [],
    [ellipse(0.51, 0.66, 0.05, 0.065), ellipse(0.7, 0.61, 0.045, 0.06)],
  ),
} satisfies Readonly<
  Record<keyof typeof VISUAL_DESIGNATION_BY_FAMILY, FleetPreviewSurfaceGeometry>
>);

/**
 * Perspective projection needs semantic shapes rather than one rectangle per
 * zone. Body zones are broad semantic bands constrained by the render-derived
 * luminance mask. Wings, tips and nacelles use family-registered shapes because
 * those surfaces move substantially between the catalogue's camera poses.
 */
export function fleetPreviewZoneShapes(
  family: string,
  zone: LiveryZone,
): readonly FleetPreviewZoneShape[] {
  if (zone === 'wings' || zone === 'winglets' || zone === 'engine_nacelles') {
    const geometry = SURFACE_GEOMETRY_BY_FAMILY[family as keyof typeof SURFACE_GEOMETRY_BY_FAMILY];
    return geometry?.[zone] ?? [];
  }
  return BODY_ZONE_SHAPES[zone];
}

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
