import { z } from 'zod';

import { auditMeshyGeometry } from './meshy-geometry';

const Axis = z.enum(['+x', '-x', '+y', '-y', '+z', '-z']);

export const MeshyAxisReview = z
  .object({
    format: z.literal('tailfin-meshy-axis-review'),
    formatVersion: z.literal(1),
    operationId: z.string().regex(/^candidate-[1-4]$/),
    sourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
    reviewedAt: z.iso.datetime({ offset: true }),
    reviewedBy: z.literal('local-operator'),
    sourceAxes: z.object({ right: Axis, up: Axis, forward: Axis }).strict(),
    evidence: z
      .array(
        z
          .object({
            sha256: z.string().regex(/^[a-f0-9]{64}$/),
            description: z.string().trim().min(1).max(240),
          })
          .strict(),
      )
      .min(2)
      .max(16),
  })
  .strict();

export type MeshyAxisReview = z.infer<typeof MeshyAxisReview>;

const TARGET = {
  aircraftFamily: 'A320neo',
  lengthMetres: 37.57,
  wingspanMetres: 35.8,
  overallHeightMetres: 11.76,
  source: {
    publisher: 'Airbus',
    title: 'A320 Family Facts and Figures — June 2026',
    url: 'https://mediaassets.airbus.com/pm_38_914_914157-tlwvtuuhjj.pdf?fileName=airbus-a320-family-facts-and-figures-june-2026.pdf',
  },
} as const;

const DIMENSION_TOLERANCE = 0.02;
type Point = readonly [number, number, number];

function vector(axis: z.infer<typeof Axis>): Point {
  const sign = axis.startsWith('+') ? 1 : -1;
  const result: [number, number, number] = [0, 0, 0];
  result['xyz'.indexOf(axis[1]!)] = sign;
  return result;
}

const dot = (a: Point, b: Point) => a.reduce((sum, n, i) => sum + n * b[i]!, 0);
const cross = (a: Point, b: Point): Point => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

function mappedBounds(min: readonly number[], max: readonly number[], matrix: readonly Point[]) {
  const points: Point[] = [];
  for (const x of [min[0]!, max[0]!])
    for (const y of [min[1]!, max[1]!]) for (const z of [min[2]!, max[2]!]) points.push([x, y, z]);
  const mapped = points.map((point) => matrix.map((row) => dot(row, point)) as unknown as Point);
  const mappedMin = [0, 1, 2].map((axis) => Math.min(...mapped.map((p) => p[axis]!)));
  const mappedMax = [0, 1, 2].map((axis) => Math.max(...mapped.map((p) => p[axis]!)));
  return {
    min: mappedMin,
    max: mappedMax,
    extent: mappedMin.map((n, axis) => mappedMax[axis]! - n),
  };
}

/** Assessment only: computes a proposed canonical frame but never mutates candidate geometry. */
export function assessA320neoCanonicalFrame(source: Uint8Array, review: MeshyAxisReview) {
  const right = vector(review.sourceAxes.right);
  const up = vector(review.sourceAxes.up);
  const forward = vector(review.sourceAxes.forward);
  if (dot(right, up) !== 0 || dot(right, forward) !== 0 || dot(up, forward) !== 0)
    throw new Error('Canonical frame assessment refused: axes must be orthogonal.');
  if (cross(right, up).some((n, i) => n !== -forward[i]!))
    throw new Error('Canonical frame assessment refused: axes must form a right-handed frame.');

  const audit = auditMeshyGeometry(source);
  const back = forward.map((n) => (n === 0 ? 0 : -n)) as unknown as Point;
  const matrix: readonly Point[] = [right, up, back];
  const oriented = mappedBounds(
    audit.metrics.boundsSourceUnits.min,
    audit.metrics.boundsSourceUnits.max,
    matrix,
  );
  const [span, height, length] = oriented.extent;
  const scaleMetresPerSourceUnit =
    (length! * TARGET.lengthMetres + span! * TARGET.wingspanMetres) /
    (length! * length! + span! * span!);
  const scaled = {
    lengthMetres: length! * scaleMetresPerSourceUnit,
    wingspanMetres: span! * scaleMetresPerSourceUnit,
    visibleHeightMetres: height! * scaleMetresPerSourceUnit,
  };
  const deviations = {
    lengthFraction: (scaled.lengthMetres - TARGET.lengthMetres) / TARGET.lengthMetres,
    wingspanFraction: (scaled.wingspanMetres - TARGET.wingspanMetres) / TARGET.wingspanMetres,
  };
  const dimensionFit =
    Math.abs(deviations.lengthFraction) <= DIMENSION_TOLERANCE &&
    Math.abs(deviations.wingspanFraction) <= DIMENSION_TOLERANCE;
  const scaledMin = oriented.min.map((n) => n * scaleMetresPerSourceUnit);
  const scaledMax = oriented.max.map((n) => n * scaleMetresPerSourceUnit);
  const translationMetres = [
    -(scaledMin[0]! + scaledMax[0]!) / 2,
    -scaledMin[1]!,
    -(scaledMin[2]! + scaledMax[2]!) / 2,
  ];

  return {
    format: 'tailfin-meshy-canonical-frame-assessment',
    formatVersion: 1,
    algorithm: 'reviewed-axis-uniform-least-squares-v1',
    state: 'quarantine',
    canonicalTransformApplied: false,
    eligibleForCanonicalTransform: dimensionFit,
    target: TARGET,
    policies: {
      canonicalAxes: '+X right, +Y up, -Z forward',
      uniformScaleOnly: true,
      lengthAndWingspanToleranceFraction: DIMENSION_TOLERANCE,
      heightComparison: 'not-applicable-gear-up-source',
      groundReference: 'lowest-visible-geometry-y; no landing-gear contact certified',
    },
    axisReview: review,
    sourceBounds: audit.metrics.boundsSourceUnits,
    sourceToCanonicalAxisMatrix: matrix,
    proposedUniformScaleMetresPerSourceUnit: scaleMetresPerSourceUnit,
    proposedTranslationMetres: translationMetres,
    proposedDimensions: scaled,
    deviations,
    blockingReasons: dimensionFit
      ? []
      : [
          'A single uniform scale cannot bring both length and wingspan within the 2% canonical tolerance.',
          'Non-uniform scaling is forbidden because it would silently distort aircraft geometry.',
        ],
    pendingChecks: [
      'semantic-partition',
      'protected-materials',
      'outward-winding-and-topology-repair',
      'canonical-livery-uvs',
      'licensing-review',
      'visual-and-performance-admission',
    ],
  };
}
