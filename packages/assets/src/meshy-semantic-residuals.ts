import { decodeMeshyGeometry } from './meshy-geometry';

import type { MeshySemanticReview } from './meshy-semantic-review';

type Point = readonly [number, number, number];

const round = (value: number) => Number(value.toPrecision(10));
const pointKey = (point: Point) => point.join(',');
function edgeKey(a: Point, b: Point) {
  const first = pointKey(a);
  const second = pointKey(b);
  return first < second ? `${first}|${second}` : `${second}|${first}`;
}
const triangleIdentity = (points: readonly Point[]) => points.map(pointKey).sort().join('|');
function triangleOrientation(points: readonly Point[]) {
  const keys = points.map(pointKey);
  return [
    `${keys[0]}|${keys[1]}|${keys[2]}`,
    `${keys[1]}|${keys[2]}|${keys[0]}`,
    `${keys[2]}|${keys[0]}|${keys[1]}`,
  ].sort()[0]!;
}
function ranges(indices: readonly number[]) {
  const result: { startInclusive: number; endExclusive: number }[] = [];
  for (const index of indices) {
    const last = result.at(-1);
    if (last?.endExclusive === index) last.endExclusive += 1;
    else result.push({ startInclusive: index, endExclusive: index + 1 });
  }
  return result;
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

/** Measure uncovered review patches without assigning meaning or modifying geometry. */
export function analyseMeshySemanticResiduals(
  correctionGlb: Uint8Array,
  review: MeshySemanticReview,
) {
  const geometry = decodeMeshyGeometry(correctionGlb);
  const covered = new Map(
    geometry.parts.map((part) => [part.name!, new Uint8Array(part.triangleCount)]),
  );
  for (const disposition of review.dispositions) {
    const component = covered.get(disposition.componentId);
    if (!component) throw new Error('Residual analysis review references an unknown component.');
    for (const range of disposition.ranges)
      for (let index = range.startInclusive; index < range.endExclusive; index += 1) {
        if (index >= component.length || component[index])
          throw new Error('Residual analysis review coverage is invalid.');
        component[index] = 1;
      }
  }

  const coincident = new Map<string, { orientation: string; triangle: number }[]>();
  for (const [triangle, vertices] of geometry.triangles.entries()) {
    const points = vertices.map((vertex) => geometry.positions[vertex]!) as Point[];
    const identity = triangleIdentity(points);
    const entries = coincident.get(identity) ?? [];
    entries.push({ orientation: triangleOrientation(points), triangle });
    coincident.set(identity, entries);
  }

  const patches: {
    componentId: string;
    localTriangleIndices: number[];
    globalTriangleIndices: number[];
  }[] = [];
  for (const part of geometry.parts) {
    const component = covered.get(part.name!)!;
    const residuals = [...component.keys()].filter((index) => component[index] === 0);
    const parent = new Map(residuals.map((index) => [index, index]));
    const find = (index: number): number => {
      let root = parent.get(index)!;
      while (root !== parent.get(root)) root = parent.get(root)!;
      while (index !== root) {
        const next = parent.get(index)!;
        parent.set(index, root);
        index = next;
      }
      return root;
    };
    const edgeOwners = new Map<string, number[]>();
    for (const local of residuals) {
      const vertices = geometry.triangles[part.triangleStart + local]!;
      const points = vertices.map((vertex) => geometry.positions[vertex]!) as Point[];
      for (let edge = 0; edge < 3; edge += 1) {
        const key = edgeKey(points[edge]!, points[(edge + 1) % 3]!);
        const owners = edgeOwners.get(key) ?? [];
        for (const owner of owners) parent.set(find(local), find(owner));
        owners.push(local);
        edgeOwners.set(key, owners);
      }
    }
    const groups = new Map<number, number[]>();
    for (const local of residuals) {
      const root = find(local);
      const group = groups.get(root) ?? [];
      group.push(local);
      groups.set(root, group);
    }
    for (const localTriangleIndices of groups.values()) {
      localTriangleIndices.sort((a, b) => a - b);
      patches.push({
        componentId: part.name!,
        localTriangleIndices,
        globalTriangleIndices: localTriangleIndices.map((value) => part.triangleStart + value),
      });
    }
  }
  patches.sort(
    (a, b) =>
      a.componentId.localeCompare(b.componentId) ||
      a.localTriangleIndices[0]! - b.localTriangleIndices[0]!,
  );

  const measured = patches.map((patch, index) => {
    const points: Point[] = [];
    const edges = new Map<string, number>();
    let area = 0;
    const normal = [0, 0, 0];
    let coincidentTriangles = 0;
    let oppositeWindingTriangles = 0;
    for (const triangle of patch.globalTriangleIndices) {
      const vertices = geometry.triangles[triangle]!;
      const face = vertices.map((vertex) => geometry.positions[vertex]!) as Point[];
      points.push(...face);
      const u = face[1]!.map((value, axis) => value - face[0]![axis]!);
      const v = face[2]!.map((value, axis) => value - face[0]![axis]!);
      const cross = [
        u[1]! * v[2]! - u[2]! * v[1]!,
        u[2]! * v[0]! - u[0]! * v[2]!,
        u[0]! * v[1]! - u[1]! * v[0]!,
      ];
      area += Math.hypot(...cross) / 2;
      for (let axis = 0; axis < 3; axis++) normal[axis] = normal[axis]! + cross[axis]!;
      for (let edge = 0; edge < 3; edge += 1) {
        const key = edgeKey(face[edge]!, face[(edge + 1) % 3]!);
        edges.set(key, (edges.get(key) ?? 0) + 1);
      }
      const group = coincident.get(triangleIdentity(face))!;
      if (group.length > 1) {
        coincidentTriangles += 1;
        const orientation = triangleOrientation(face);
        if (group.some((entry) => entry.triangle !== triangle && entry.orientation !== orientation))
          oppositeWindingTriangles += 1;
      }
    }
    const magnitude = Math.hypot(...normal);
    const unitNormal = normal.map((value) => round(magnitude ? value / magnitude : 0));
    const absolute = unitNormal.map(Math.abs);
    return {
      patchId: `residual_patch_${String(index + 1).padStart(3, '0')}`,
      componentId: patch.componentId,
      triangles: patch.localTriangleIndices.length,
      componentLocalTriangleRanges: ranges(patch.localTriangleIndices),
      boundsCanonicalMetres: bounds(points),
      surfaceAreaSquareMetres: round(area),
      areaWeightedUnitNormal: unitNormal,
      dominantAbsoluteNormalAxis: ['x', 'y', 'z'][absolute.indexOf(Math.max(...absolute))]!,
      boundaryEdges: [...edges.values()].filter((count) => count === 1).length,
      nonManifoldEdgesWithinPatch: [...edges.values()].filter((count) => count > 2).length,
      coincidentTriangles,
      oppositeWindingTriangles,
    };
  });
  return {
    algorithm: 'exact-coordinate-residual-edge-components-v1' as const,
    residualTriangles: measured.reduce((sum, patch) => sum + patch.triangles, 0),
    residualPatches: measured,
    patchesWithCoincidentTriangles: measured.filter((patch) => patch.coincidentTriangles > 0)
      .length,
    patchesWithOppositeWindingTriangles: measured.filter(
      (patch) => patch.oppositeWindingTriangles > 0,
    ).length,
    limitations: [
      'Exact-coordinate edge connectivity does not infer aircraft semantics or near-coincident seams.',
      'Patch normals are winding-dependent evidence and do not certify outward orientation.',
      'Coincident-triangle evidence is diagnostic only and never authorizes automatic deletion.',
    ],
  };
}
