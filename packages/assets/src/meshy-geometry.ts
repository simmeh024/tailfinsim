import { z } from 'zod';

import { sha256 } from './canonical';

const LIMIT = 100_000;
const Integer = z
  .number()
  .int()
  .min(0)
  .max(64 * 1024 * 1024);
const Index = z.number().int().min(0).max(1023);
const Name = z.string().max(256).optional();
const Identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const Scalar = z.number().finite().min(-1e6).max(1e6);
const Accessor = z
  .object({
    bufferView: Index,
    byteOffset: Integer.default(0),
    componentType: z.union([z.literal(5121), z.literal(5123), z.literal(5125), z.literal(5126)]),
    count: z
      .number()
      .int()
      .min(1)
      .max(LIMIT * 3),
    type: z.enum(['SCALAR', 'VEC2', 'VEC3']),
    normalized: z.literal(false).optional(),
    min: z.array(Scalar).max(3).optional(),
    max: z.array(Scalar).max(3).optional(),
    name: Name,
  })
  .strict();
const Primitive = z
  .object({
    attributes: z
      .object({ POSITION: Index, NORMAL: Index.optional(), TEXCOORD_0: Index.optional() })
      .strict(),
    indices: Index.optional(),
    mode: z.literal(4).default(4),
  })
  .strict();

// Intentionally a narrow untextured T2 profile, NOT a general glTF loader.
// Unknown extensions, resources, sparse accessors, morphs and transforms fail
// closed before allocation. No model-provided URI or code is ever evaluated.
const Profile = z
  .object({
    extensions: z.object({}).strict().optional(),
    asset: z.object({ version: z.literal('2.0'), generator: Name }).strict(),
    scene: z.literal(0).default(0),
    scenes: z
      .array(z.object({ nodes: z.array(Index).min(1).max(64), name: Name }).strict())
      .length(1),
    nodes: z
      .array(
        z
          .object({ mesh: Index, matrix: z.array(z.number()).length(16).optional(), name: Name })
          .strict(),
      )
      .min(1)
      .max(64),
    meshes: z
      .array(z.object({ primitives: z.array(Primitive).min(1).max(64), name: Name }).strict())
      .min(1)
      .max(64),
    accessors: z.array(Accessor).min(1).max(1024),
    bufferViews: z
      .array(
        z
          .object({
            buffer: z.literal(0),
            byteOffset: Integer.default(0),
            byteLength: Integer,
            byteStride: z.number().int().min(4).max(252).multipleOf(4).optional(),
            target: z.union([z.literal(34962), z.literal(34963)]).optional(),
            name: Name,
          })
          .strict(),
      )
      .min(1)
      .max(1024),
    buffers: z.array(z.object({ byteLength: Integer, name: Name }).strict()).length(1),
  })
  .strict();

type Point = readonly [number, number, number];
interface Geometry {
  positions: Point[];
  triangles: [number, number, number][];
  parts: {
    name: string | null;
    positionStart: number;
    positionCount: number;
    triangleStart: number;
    triangleCount: number;
    indexed: boolean;
  }[];
  primitives: number;
  normalsVertices: number;
  nonUnitNormals: number;
  uvVertices: number;
}

/** Shared bounded decoder for offline preparation; never exposes parser/provider text. */
export function decodeMeshyGeometry(bytes: Uint8Array): Geometry {
  try {
    return decode(bytes);
  } catch {
    throw new Error(REFUSED);
  }
}
const REFUSED = 'Geometry audit refused: unsupported or malformed bounded untextured GLB profile.';

/** Decode only flat, identity-transform triangle exports, with no external IO. */
function decode(bytes: Uint8Array): Geometry {
  if (bytes.byteLength < 28 || bytes.byteLength > 64 * 1024 * 1024) throw new Error(REFUSED);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const jsonLength = view.getUint32(12, true);
  const binHeader = 20 + jsonLength;
  if (
    view.getUint32(0, true) !== 0x46546c67 ||
    view.getUint32(4, true) !== 2 ||
    view.getUint32(8, true) !== bytes.byteLength ||
    view.getUint32(16, true) !== 0x4e4f534a ||
    jsonLength % 4 !== 0 ||
    jsonLength > 1024 * 1024 ||
    binHeader + 8 > bytes.byteLength
  )
    throw new Error(REFUSED);
  const binLength = view.getUint32(binHeader, true);
  if (
    view.getUint32(binHeader + 4, true) !== 0x004e4942 ||
    binLength % 4 !== 0 ||
    binHeader + 8 + binLength !== bytes.byteLength
  )
    throw new Error(REFUSED);
  const profile = Profile.parse(
    JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(20, binHeader)),
    ) as unknown,
  );
  const bufferLength = profile.buffers[0]!.byteLength;
  if (bufferLength > binLength || binLength - bufferLength > 3) throw new Error(REFUSED);
  const nodes = profile.scenes[0]!.nodes;
  if (
    nodes.length !== profile.nodes.length ||
    new Set(nodes).size !== nodes.length ||
    nodes.some((n) => n >= profile.nodes.length) ||
    profile.nodes.length !== profile.meshes.length ||
    new Set(profile.nodes.map((n) => n.mesh)).size !== profile.meshes.length ||
    profile.nodes.some(
      (n) => n.mesh >= profile.meshes.length || n.matrix?.some((v, i) => v !== Identity[i]),
    )
  )
    throw new Error(REFUSED);
  for (const v of profile.bufferViews)
    if (v.byteOffset + v.byteLength > bufferLength) throw new Error(REFUSED);
  const bin = new DataView(bytes.buffer, bytes.byteOffset + binHeader + 8, bufferLength);
  const attribute = (index: number, type: 'SCALAR' | 'VEC2' | 'VEC3'): number[] => {
    const a = profile.accessors[index];
    if (
      a?.type !== type ||
      (type !== 'SCALAR' && a.componentType !== 5126) ||
      (type === 'SCALAR' && a.componentType === 5126)
    )
      throw new Error(REFUSED);
    const v = profile.bufferViews[a.bufferView];
    if (!v) throw new Error(REFUSED);
    const size = a.componentType === 5121 ? 1 : a.componentType === 5123 ? 2 : 4;
    const components = type === 'SCALAR' ? 1 : type === 'VEC2' ? 2 : 3;
    const elementSize = size * components;
    const stride = v.byteStride ?? elementSize;
    if (
      stride < elementSize ||
      a.byteOffset % size !== 0 ||
      (v.byteOffset + a.byteOffset) % size !== 0 ||
      a.byteOffset + (a.count - 1) * stride + elementSize > v.byteLength
    )
      throw new Error(REFUSED);
    const values: number[] = [];
    for (let i = 0; i < a.count; i++)
      for (let c = 0; c < components; c++) {
        const offset = v.byteOffset + a.byteOffset + i * stride + c * size;
        const value =
          a.componentType === 5126
            ? bin.getFloat32(offset, true)
            : a.componentType === 5125
              ? bin.getUint32(offset, true)
              : a.componentType === 5123
                ? bin.getUint16(offset, true)
                : bin.getUint8(offset);
        if (!Number.isFinite(value) || (type !== 'SCALAR' && Math.abs(value) > 1e6))
          throw new Error(REFUSED);
        values.push(value);
      }
    return values;
  };
  const result: Geometry = {
    positions: [],
    triangles: [],
    parts: [],
    primitives: 0,
    normalsVertices: 0,
    nonUnitNormals: 0,
    uvVertices: 0,
  };
  for (const node of profile.nodes)
    for (const primitive of profile.meshes[node.mesh]!.primitives) {
      const count = profile.accessors[primitive.attributes.POSITION]?.count;
      if (
        count === undefined ||
        result.positions.length + count > LIMIT ||
        ++result.primitives > 256
      )
        throw new Error(REFUSED);
      const positions = attribute(primitive.attributes.POSITION, 'VEC3');
      const base = result.positions.length;
      const triangleStart = result.triangles.length;
      for (let i = 0; i < positions.length; i += 3)
        result.positions.push([positions[i]!, positions[i + 1]!, positions[i + 2]!]);
      const indexCount =
        primitive.indices === undefined ? count : profile.accessors[primitive.indices]?.count;
      if (
        indexCount === undefined ||
        indexCount % 3 !== 0 ||
        result.triangles.length + indexCount / 3 > LIMIT
      )
        throw new Error(REFUSED);
      const indices =
        primitive.indices === undefined
          ? Array.from({ length: count }, (_, i) => i)
          : attribute(primitive.indices, 'SCALAR');
      if (indices.some((i) => i >= count)) throw new Error(REFUSED);
      for (let i = 0; i < indices.length; i += 3)
        result.triangles.push([base + indices[i]!, base + indices[i + 1]!, base + indices[i + 2]!]);
      result.parts.push({
        name: node.name ?? profile.meshes[node.mesh]!.name ?? null,
        positionStart: base,
        positionCount: count,
        triangleStart,
        triangleCount: indices.length / 3,
        indexed: primitive.indices !== undefined,
      });
      for (const [name, type] of [
        ['NORMAL', 'VEC3'],
        ['TEXCOORD_0', 'VEC2'],
      ] as const) {
        const index = primitive.attributes[name];
        if (index === undefined) continue;
        if (profile.accessors[index]?.count !== count) throw new Error(REFUSED);
        const values = attribute(index, type);
        if (name === 'NORMAL') {
          result.normalsVertices += count;
          for (let i = 0; i < values.length; i += 3)
            if (Math.abs(Math.hypot(values[i]!, values[i + 1]!, values[i + 2]!) - 1) > 0.001)
              result.nonUnitNormals++;
        } else result.uvVertices += count;
      }
    }
  return result;
}

function bounds(points: readonly Point[]) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const p of points)
    for (let i = 0; i < 3; i++) {
      min[i] = Math.min(min[i]!, p[i]!);
      max[i] = Math.max(max[i]!, p[i]!);
    }
  return { min, max, extent: min.map((n, i) => max[i]! - n) };
}
function round(n: number): number {
  return Number(n.toPrecision(10));
}

function measure(g: Geometry) {
  const referenced = new Set(g.triangles.flat());
  const sourceBounds = bounds([...referenced].map((i) => g.positions[i]!));
  const span = Math.max(...sourceBounds.extent);
  const unique: Point[] = [];
  const vertexIds = new Map<string, number>();
  const welded = g.positions.map((p) => {
    const key = p.join(',');
    let id = vertexIds.get(key);
    if (id === undefined) {
      id = unique.length;
      vertexIds.set(key, id);
      unique.push(p);
    }
    return id;
  });
  const faces: [number, number, number][] = [];
  const seen = new Set<string>();
  let degenerate = 0;
  let duplicate = 0;
  for (const t of g.triangles) {
    const f = t.map((i) => welded[i]!) as [number, number, number];
    const [a, b, c] = f.map((i) => unique[i]!) as [Point, Point, Point];
    const u = b.map((v, i) => (v - a[i]!) / (span || 1));
    const v = c.map((v, i) => (v - a[i]!) / (span || 1));
    const doubleArea = Math.hypot(
      u[1]! * v[2]! - u[2]! * v[1]!,
      u[2]! * v[0]! - u[0]! * v[2]!,
      u[0]! * v[1]! - u[1]! * v[0]!,
    );
    if (new Set(f).size !== 3 || doubleArea <= 1e-12) {
      degenerate++;
      continue;
    }
    const key = [...f].sort((a, b) => a - b).join(',');
    if (seen.has(key)) {
      duplicate++;
      continue;
    }
    seen.add(key);
    faces.push(f);
  }
  const parent = faces.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]!]!;
      i = parent[i]!;
    }
    return i;
  };
  const edges = new Map<string, { face: number; direction: number }[]>();
  for (const [face, vertices] of faces.entries())
    for (let i = 0; i < 3; i++) {
      const a = vertices[i]!;
      const b = vertices[(i + 1) % 3]!;
      const key = `${Math.min(a, b)},${Math.max(a, b)}`;
      const incident = edges.get(key) ?? [];
      if (incident[0]) parent[find(face)] = find(incident[0].face);
      incident.push({ face, direction: a < b ? 1 : -1 });
      edges.set(key, incident);
    }
  let boundaryEdges = 0;
  let nonManifoldEdges = 0;
  let inconsistentWindingEdges = 0;
  for (const incident of edges.values()) {
    if (incident.length === 1) boundaryEdges++;
    if (incident.length > 2) nonManifoldEdges++;
    if (incident.length === 2 && incident[0]!.direction === incident[1]!.direction)
      inconsistentWindingEdges++;
  }
  const components = new Map<number, number>();
  faces.forEach((_, i) => {
    const root = find(i);
    components.set(root, (components.get(root) ?? 0) + 1);
  });
  const sizes = [...components.values()].sort((a, b) => b - a);
  const centre = sourceBounds.min.map((n, i) => (n + sourceBounds.max[i]!) / 2);
  const occupied = new Set(
    [...referenced].map((i) =>
      g.positions[i]!.map((n, axis) => {
        const cell = ((n - centre[axis]!) / (span || 1)) * 256;
        // Math.round alone rounds negative ties toward zero, breaking reflection.
        return Math.sign(cell) * Math.round(Math.abs(cell));
      }).join(','),
    ),
  );
  const reflection = [0, 1, 2].map((axis) => {
    let matched = 0;
    for (const cell of occupied) {
      const point = cell.split(',').map(Number);
      point[axis] = -point[axis]!;
      if (occupied.has(point.join(','))) matched++;
    }
    return {
      axis: ['x', 'y', 'z'][axis],
      planeSourceCoordinate: round(centre[axis]!),
      vertexVoxelReflectionIoU: span > 0 ? round(matched / (2 * occupied.size - matched)) : null,
    };
  });
  return {
    sourceVertices: g.positions.length,
    referencedSourceVertices: referenced.size,
    exactCoincidentVertices: g.positions.length - unique.length,
    sourceTriangles: g.triangles.length,
    degenerateTriangles: degenerate,
    duplicateTriangles: duplicate,
    analysedUniqueNondegenerateTriangles: faces.length,
    edgeTopology: {
      boundaryEdges,
      nonManifoldEdges,
      inconsistentWindingEdges,
      edgeConnectedComponents: sizes.length,
      largestComponentTriangleCounts: sizes.slice(0, 64),
      omittedComponents: Math.max(0, sizes.length - 64),
    },
    boundsSourceUnits: sourceBounds,
    axisExtentRatios: sourceBounds.extent.map((n) => (span > 0 ? round(n / span) : null)),
    symmetryIndicator: {
      method: 'referenced-vertex-voxel-reflection-iou',
      cellsPerLongestExtent: 256,
      occupiedCells: occupied.size,
      planes: reflection,
    },
    attributes: {
      primitives: g.primitives,
      normalVertices: g.normalsVertices,
      nonUnitNormals: g.nonUnitNormals,
      uvVertices: g.uvVertices,
      materialAssignedTriangles: 0,
    },
  };
}

/** Deterministic measurements only. Never repairs bytes, classifies engines or admits an asset. */
export function auditMeshyGeometry(bytes: Uint8Array) {
  try {
    const metrics = measure(decode(bytes));
    return {
      format: 'tailfin-meshy-geometry-audit',
      formatVersion: 1,
      algorithm: 'bounded-untextured-flat-triangles-v1',
      sourceSha256: sha256(bytes),
      sourceBytes: bytes.byteLength,
      state: 'quarantine',
      creditsSpentByThisCommand: 0,
      runtimeAdmission: 'not-reviewed',
      liveryReady: false,
      metrics,
      pendingChecks: [
        'licensing',
        'official-gltf-conformance',
        'canonical-aircraft-axes-and-real-world-dimensions',
        'silhouette',
        'engine-count-and-placement',
        'vertex-manifoldness-and-self-intersections',
        'outward-normals',
        'canonical-uv-overlap-padding-and-masks',
        'semantic-protected-materials',
        'visual-and-runtime-performance',
      ],
      limitations: [
        'Exact-coordinate welding is analytical only; coincident parts may touch without being one semantic part.',
        'Topology excludes duplicate and degenerate faces; zero edge defects is not a watertight/manifold certificate.',
        'Vertex voxel IoU is a density-sensitive indicator, not surface or silhouette symmetry; native axes are not inferred.',
        'UV presence is not canonical livery UV readiness. No material/part names are treated as semantic evidence.',
      ],
    };
  } catch {
    throw new Error(REFUSED);
  }
}
