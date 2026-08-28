import { canonicalJson, sha256 } from './canonical';
import { auditMeshyGeometry, decodeMeshyGeometry } from './meshy-geometry';

type Point = readonly [number, number, number];
const REFUSED = 'Candidate review preparation refused: unsupported or ambiguous geometry.';

function bounds(points: readonly Point[]) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const p of points)
    for (let axis = 0; axis < 3; axis++) {
      min[axis] = Math.min(min[axis]!, p[axis]!);
      max[axis] = Math.max(max[axis]!, p[axis]!);
    }
  return { min, max, extent: min.map((n, i) => max[i]! - n) };
}

/** Review derivative only: no semantics, metre conversion, smoothing, hole filling or admission. */
export function prepareMeshyReview(source: Uint8Array) {
  try {
    const decoded = decodeMeshyGeometry(source);
    // Do not silently discard authored normals/UVs, or merge separately authored primitives.
    if (decoded.primitives !== 1 || decoded.normalsVertices || decoded.uvVertices)
      throw new Error(REFUSED);
    const before = auditMeshyGeometry(source);
    const span = Math.max(...before.metrics.boundsSourceUnits.extent);
    const vertices = new Map<string, number>();
    const unique: Point[] = [];
    const welded = decoded.positions.map((p) => {
      const key = p.join(',');
      let index = vertices.get(key);
      if (index === undefined) {
        index = unique.length;
        vertices.set(key, index);
        unique.push(p);
      }
      return index;
    });
    const kept: {
      sourceTriangle: number;
      vertices: number[];
      normal: Point;
      duplicateOf?: number;
    }[] = [];
    const removed: { sourceTriangle: number; reason: string; retainedSourceTriangle?: number }[] =
      [];
    const ambiguousCoincidentFaces: { sourceTriangle: number; otherSourceTriangle: number }[] = [];
    const seen = new Map<string, { oriented: string; sourceTriangle: number; keptIndex: number }>();
    for (const [sourceTriangle, triangle] of decoded.triangles.entries()) {
      const ids = triangle.map((i) => welded[i]!);
      const [a, b, c] = ids.map((i) => unique[i]!) as [Point, Point, Point];
      const u = b.map((n, i) => n - a[i]!);
      const v = c.map((n, i) => n - a[i]!);
      const cross: Point = [
        u[1]! * v[2]! - u[2]! * v[1]!,
        u[2]! * v[0]! - u[0]! * v[2]!,
        u[0]! * v[1]! - u[1]! * v[0]!,
      ];
      const area = Math.hypot(...cross);
      if (area === 0) {
        removed.push({ sourceTriangle, reason: 'exact-zero-area' });
        continue;
      }
      // Unlike the audit's measurement threshold, near-zero is NOT permission to delete.
      if (area / (span * span) <= 1e-12) throw new Error(REFUSED);
      const smallest = ids.indexOf(Math.min(...ids));
      const oriented = [...ids.slice(smallest), ...ids.slice(0, smallest)].join(',');
      const key = [...ids].sort((a, b) => a - b).join(',');
      const previous = seen.get(key);
      if (previous) {
        // Opposite-winding coincident faces might represent an intentional two-sided surface.
        if (previous.oriented !== oriented) {
          ambiguousCoincidentFaces.push({
            sourceTriangle,
            otherSourceTriangle: previous.sourceTriangle,
          });
        } else {
          removed.push({
            sourceTriangle,
            reason: 'same-winding-exact-duplicate',
            retainedSourceTriangle: previous.sourceTriangle,
          });
          continue;
        }
      }
      if (!previous) seen.set(key, { oriented, sourceTriangle, keptIndex: kept.length });
      kept.push({
        sourceTriangle,
        vertices: ids,
        normal: [cross[0] / area, cross[1] / area, cross[2] / area],
        ...(previous ? { duplicateOf: previous.keptIndex } : {}),
      });
    }
    // Corner-expanded flat normals deliberately fit the existing bounded audit profile.
    if (!kept.length || kept.length > 33_333) throw new Error(REFUSED);
    const parent = kept.map((_, i) => i);
    const find = (i: number): number => {
      while (parent[i] !== i) {
        parent[i] = parent[parent[i]!]!;
        i = parent[i]!;
      }
      return i;
    };
    const edges = new Map<string, { first: number; count: number; points: [Point, Point] }>();
    for (const [face, triangle] of kept.entries()) {
      if (triangle.duplicateOf !== undefined) {
        parent[find(face)] = find(triangle.duplicateOf);
        continue;
      }
      for (let i = 0; i < 3; i++) {
        const a = triangle.vertices[i]!;
        const b = triangle.vertices[(i + 1) % 3]!;
        const key = `${Math.min(a, b)},${Math.max(a, b)}`;
        const edge = edges.get(key);
        if (edge) {
          parent[find(face)] = find(edge.first);
          edge.count++;
        } else edges.set(key, { first: face, count: 1, points: [unique[a]!, unique[b]!] });
      }
    }
    const groups = new Map<number, number[]>();
    kept.forEach((_, i) => {
      const root = find(i);
      const group = groups.get(root) ?? [];
      group.push(i);
      groups.set(root, group);
    });
    // Stable for the exact source, ordered by the first retained source triangle, not size.
    const components = [...groups.values()].sort((a, b) => a[0]! - b[0]!);
    if (components.length > 64) throw new Error(REFUSED);
    const chunks: Buffer[] = [];
    const views: { buffer: number; byteOffset: number; byteLength: number; target: number }[] = [];
    const accessors: {
      bufferView: number;
      componentType: number;
      count: number;
      type: string;
      min?: number[];
      max?: number[];
    }[] = [];
    let offset = 0;
    const append = (points: readonly Point[], includeBounds: boolean): number => {
      const bytes = Buffer.alloc(points.length * 12);
      points.forEach((p, i) => p.forEach((n, axis) => bytes.writeFloatLE(n, i * 12 + axis * 4)));
      chunks.push(bytes);
      views.push({ buffer: 0, byteOffset: offset, byteLength: bytes.length, target: 34962 });
      offset += bytes.length;
      accessors.push({
        bufferView: views.length - 1,
        componentType: 5126,
        count: points.length,
        type: 'VEC3',
        ...(includeBounds ? { min: bounds(points).min, max: bounds(points).max } : {}),
      });
      return accessors.length - 1;
    };
    const parts = components.map((faces, index) => {
      const positions = faces.flatMap((face) => kept[face]!.vertices.map((i) => unique[i]!));
      const normals = faces.flatMap((face) => Array.from({ length: 3 }, () => kept[face]!.normal));
      const root = find(faces[0]!);
      return {
        id: `review_component_${String(index + 1).padStart(3, '0')}`,
        sourceTriangles: faces.map((face) => kept[face]!.sourceTriangle),
        boundsSourceUnits: bounds(positions),
        boundaryEdges: [...edges.values()]
          .filter((e) => e.count === 1 && find(e.first) === root)
          .map((e) => e.points),
        semanticClass: null,
        paintProtection: 'unassigned',
        attributes: { POSITION: append(positions, true), NORMAL: append(normals, false) },
      };
    });
    const binary = Buffer.concat(chunks);
    const json = Buffer.from(
      canonicalJson({
        asset: { version: '2.0', generator: 'Tailfin quarantine review v1' },
        scene: 0,
        scenes: [{ nodes: parts.map((_, i) => i) }],
        nodes: parts.map((p, mesh) => ({ mesh, name: p.id })),
        meshes: parts.map((p) => ({
          name: p.id,
          primitives: [{ attributes: p.attributes, mode: 4 }],
        })),
        accessors,
        bufferViews: views,
        buffers: [{ byteLength: binary.length }],
      }),
    );
    const jsonLength = Math.ceil(json.length / 4) * 4;
    const glb = Buffer.alloc(28 + jsonLength + binary.length);
    [0x46546c67, 2, glb.length, jsonLength, 0x4e4f534a].forEach((n, i) =>
      glb.writeUInt32LE(n, i * 4),
    );
    glb.fill(0x20, 20, 20 + jsonLength);
    json.copy(glb, 20);
    glb.writeUInt32LE(binary.length, 20 + jsonLength);
    glb.writeUInt32LE(0x004e4942, 24 + jsonLength);
    binary.copy(glb, 28 + jsonLength);
    const after = auditMeshyGeometry(glb);
    if (
      canonicalJson(before.metrics.boundsSourceUnits) !==
      canonicalJson(after.metrics.boundsSourceUnits)
    )
      throw new Error(REFUSED);
    return {
      glb,
      report: {
        format: 'tailfin-meshy-review-preparation',
        formatVersion: 1,
        algorithm: 'exact-cleanup-flat-component-review-v1',
        sourceSha256: sha256(source),
        sourceBytes: source.length,
        derivativeSha256: sha256(glb),
        derivativeBytes: glb.length,
        state: 'quarantine',
        runtimeAdmission: 'not-reviewed',
        liveryReady: false,
        creditsSpentByThisCommand: 0,
        removedTriangles: removed,
        ambiguousCoincidentFaces,
        components: parts.map((part) => ({
          id: part.id,
          sourceTriangles: part.sourceTriangles,
          boundsSourceUnits: part.boundsSourceUnits,
          boundaryEdges: part.boundaryEdges,
          semanticClass: part.semanticClass,
          paintProtection: part.paintProtection,
        })),
        before: before.metrics,
        after: after.metrics,
        pendingChecks: before.pendingChecks,
        limitations: [
          'Component IDs are scoped to this exact source, not stable aircraft semantics across versions.',
          'Exact-coordinate connectivity is analytical only; output corners remain split for flat normals.',
          'Face normals follow original winding; outward orientation and smooth shading are not certified.',
          'No holes filled, no vertices moved, no approximate weld, no winding flip, no scale/axes/origin change.',
          'Boundary segments and source triangle indices are review evidence, never automatic repair instructions.',
          'Opposite-winding coincident faces are preserved and flagged; component boundaries count coincident geometry once.',
          'No paintable/protected classes assigned; no UVs, PBR, LODs, licensing or runtime admission provided.',
        ],
      },
    };
  } catch {
    throw new Error(REFUSED);
  }
}
