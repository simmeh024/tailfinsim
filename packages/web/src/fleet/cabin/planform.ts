/**
 * The aircraft *planform* — the top-down shape drawn behind the seat map (M6-08).
 *
 * §tech-notes makes the cabin builder an SVG vector editor precisely so it stays
 * resolution-independent and asset-free; a per-type photo backdrop would cut
 * against that and would only ever cover the types that had art. So the recognis-
 * able aeroplane behind the cabin — swept wings and underwing engines for a
 * narrowbody, a straight high wing with turboprops for a regional, big swept
 * wings for a widebody — is drawn from a handful of numbers here. Every one of
 * the eighteen catalogue types gets a sensible silhouette from its cabin width
 * alone, and a preset may override for a distinctive shape.
 */

import type { CabinFrame } from './types';

export type EngineKind = 'underwing' | 'turboprop' | 'rear' | 'none';

export interface Planform {
  /** Leading-edge sweep in degrees; near zero for a straight turboprop wing. */
  wingSweepDeg: number;
  /** Root and tip chord in metres (along the fuselage). */
  wingRootChordM: number;
  wingTipChordM: number;
  /** Half-span as a multiple of the drawn cabin width — kept proportionate to the
   *  plan rather than true metres, which would dwarf the cabin. */
  wingSpanFactor: number;
  /** Root leading-edge position along the cabin, 0 (nose) … 1 (tail). */
  wingXFraction: number;
  engine: EngineKind;
  /** Total engines across both wings (or fuselage sides for a rear mount). */
  engineCount: number;
  /** Horizontal stabiliser, same idea as the wing but smaller and near the tail. */
  hStabSpanFactor: number;
  hStabChordM: number;
  hStabXFraction: number;
}

const NARROWBODY: Planform = {
  wingSweepDeg: 25,
  wingRootChordM: 5.4,
  wingTipChordM: 1.7,
  wingSpanFactor: 1.55,
  wingXFraction: 0.44,
  engine: 'underwing',
  engineCount: 2,
  hStabSpanFactor: 0.82,
  hStabChordM: 2.6,
  hStabXFraction: 1.03,
};

const WIDEBODY: Planform = {
  wingSweepDeg: 31,
  wingRootChordM: 9.5,
  wingTipChordM: 2.4,
  wingSpanFactor: 2,
  wingXFraction: 0.42,
  engine: 'underwing',
  engineCount: 2,
  hStabSpanFactor: 0.95,
  hStabChordM: 4.2,
  hStabXFraction: 1.02,
};

const REGIONAL: Planform = {
  wingSweepDeg: 4,
  wingRootChordM: 2.8,
  wingTipChordM: 1.5,
  wingSpanFactor: 1.35,
  wingXFraction: 0.34,
  engine: 'turboprop',
  engineCount: 2,
  hStabSpanFactor: 0.95,
  hStabChordM: 1.6,
  hStabXFraction: 1.04,
};

/** A silhouette for any frame — its own planform, or a default from cabin width. */
export function resolvePlanform(frame: CabinFrame): Planform {
  if (frame.planform !== undefined) return frame.planform;
  if (frame.maxAbreast <= 4) return REGIONAL;
  if (frame.maxAbreast >= 7) return WIDEBODY;
  return NARROWBODY;
}

export { NARROWBODY, WIDEBODY, REGIONAL };
