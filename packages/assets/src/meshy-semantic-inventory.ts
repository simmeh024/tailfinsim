import { sha256 } from './canonical';
import { decodeMeshyGeometry } from './meshy-geometry';

type Point = readonly [number, number, number];

const semanticTargets = [
  ['fuselage', 'paintable', 'fuselage', true],
  ['cockpit_glass', 'protected', 'cockpit_glass', true],
  ['cabin_windows_left', 'protected', 'cabin_windows', true],
  ['cabin_windows_right', 'protected', 'cabin_windows', true],
  ['doors_left', 'decal_or_mask', null, true],
  ['doors_right', 'decal_or_mask', null, true],
  ['wing_left', 'paintable', 'wings', true],
  ['wing_right', 'paintable', 'wings', true],
  ['winglet_left', 'paintable', 'winglets', true],
  ['winglet_right', 'paintable', 'winglets', true],
  ['tail_fin', 'paintable', 'fin', true],
  ['horizontal_stabiliser_left', 'paintable', 'horizontal_stabilisers', true],
  ['horizontal_stabiliser_right', 'paintable', 'horizontal_stabilisers', true],
  ['nacelle_left', 'paintable', 'nacelle_exteriors', true],
  ['nacelle_right', 'paintable', 'nacelle_exteriors', true],
  ['engine_interiors_left', 'protected', 'engine_interiors', true],
  ['engine_interiors_right', 'protected', 'engine_interiors', true],
  ['lights', 'protected', 'lights', true],
  ['landing_gear', 'mixed_protected', null, false],
] as const;

function round(value: number) {
  return Number(value.toPrecision(10));
}

function bounds(points: readonly Point[]) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const point of points)
    for (let axis = 0; axis < 3; axis++) {
      min[axis] = Math.min(min[axis]!, point[axis]!);
      max[axis] = Math.max(max[axis]!, point[axis]!);
    }
  return {
    min: min.map(round),
    max: max.map(round),
    extent: min.map((value, axis) => round(max[axis]! - value)),
    centre: min.map((value, axis) => round((max[axis]! + value) / 2)),
  };
}

/**
 * Creates measurement evidence for semantic authoring without assigning aircraft meaning.
 * Component names remain scoped to this exact derivative.
 */
export function inventoryMeshySemanticComponents(correctionGlb: Uint8Array) {
  const geometry = decodeMeshyGeometry(correctionGlb);
  const names = geometry.parts.map((part) => part.name);
  if (
    geometry.positions.length !== geometry.triangles.length * 3 ||
    geometry.normalsVertices !== geometry.positions.length ||
    geometry.nonUnitNormals !== 0 ||
    geometry.uvVertices !== 0 ||
    new Set(names).size !== names.length ||
    geometry.parts.some(
      (part) =>
        part.indexed ||
        part.positionCount !== part.triangleCount * 3 ||
        !/^review_component_\d{3}$/.test(part.name ?? ''),
    )
  ) {
    throw new Error('Semantic inventory requires the corrected quarantine derivative.');
  }

  const aircraftBounds = bounds(geometry.positions);
  const epsilon = Math.max(...aircraftBounds.extent) * 1e-6;
  const components = geometry.parts.map((part) => {
    const measured = bounds(
      geometry.positions.slice(part.positionStart, part.positionStart + part.positionCount),
    );
    const centreX = measured.centre[0]!;
    const side =
      measured.min[0]! < -epsilon && measured.max[0]! > epsilon
        ? 'crosses_centre'
        : centreX < -epsilon
          ? 'left'
          : centreX > epsilon
            ? 'right'
            : 'centre';
    return {
      componentId: part.name!,
      sourceTriangleRange: {
        startInclusive: part.triangleStart,
        endExclusive: part.triangleStart + part.triangleCount,
      },
      triangles: part.triangleCount,
      boundsCanonicalMetres: measured,
      side,
      requiresManualTriangleLevelReview: side === 'crosses_centre',
    };
  });

  const span = aircraftBounds.extent.map((value) => Math.max(value, epsilon));
  const withCandidates = components.map((component) => {
    const opposite =
      component.side === 'left' ? 'right' : component.side === 'right' ? 'left' : null;
    const mirrorCandidates =
      opposite === null
        ? []
        : components
            .filter((candidate) => candidate.side === opposite)
            .map((candidate) => {
              const a = component.boundsCanonicalMetres;
              const b = candidate.boundsCanonicalMetres;
              const centreDelta = [
                Math.abs(Math.abs(a.centre[0]!) - Math.abs(b.centre[0]!)),
                Math.abs(a.centre[1]! - b.centre[1]!),
                Math.abs(a.centre[2]! - b.centre[2]!),
              ];
              const extentDelta = a.extent.map((value, axis) => Math.abs(value - b.extent[axis]!));
              const triangleDeltaRatio =
                Math.abs(component.triangles - candidate.triangles) /
                Math.max(component.triangles, candidate.triangles);
              const score =
                centreDelta.reduce((sum, value, axis) => sum + value / span[axis]!, 0) +
                extentDelta.reduce((sum, value, axis) => sum + value / span[axis]!, 0) +
                triangleDeltaRatio;
              return {
                componentId: candidate.componentId,
                evidenceScore: round(score),
                centreDeltaMetres: centreDelta.map(round),
                extentDeltaMetres: extentDelta.map(round),
                triangleDelta: Math.abs(component.triangles - candidate.triangles),
              };
            })
            .sort(
              (a, b) =>
                a.evidenceScore - b.evidenceScore || a.componentId.localeCompare(b.componentId),
            )
            .slice(0, 3);
    return { ...component, mirrorCandidates };
  });

  return {
    format: 'tailfin-meshy-semantic-inventory' as const,
    formatVersion: 1 as const,
    algorithm: 'canonical-component-bounds-and-mirror-evidence-v1' as const,
    derivativeSha256: sha256(correctionGlb),
    coordinateSystem: '+X right, +Y up, -Z forward' as const,
    coordinateUnits: 'metres' as const,
    state: 'quarantine' as const,
    semanticAssignmentsMade: false,
    runtimeAdmission: 'not-reviewed' as const,
    liveryReady: false,
    aircraftBoundsCanonicalMetres: aircraftBounds,
    components: withCandidates,
    requiredSemanticTargets: semanticTargets.map(([id, role, materialClass, required]) => ({
      id,
      role,
      materialClass,
      required,
      reviewStatus: 'unreviewed' as const,
    })),
    blockingReasons: [
      'No component or triangle range has been assigned an aircraft semantic.',
      'Components crossing the centre plane require triangle-level human review before splitting.',
      'A low mirror-evidence score is only geometric similarity and never a left/right semantic binding.',
      'Missing protected glazing, doors, lights or engine interiors must be modeled or supplied as canonical overlays; they cannot be inferred into existence.',
      'Topology, UV, material, rights, visual and performance gates remain independent.',
    ],
    creditsSpentByThisCommand: 0,
  };
}
