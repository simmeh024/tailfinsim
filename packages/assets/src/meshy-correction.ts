import { canonicalJson, sha256 } from './canonical';
import { auditMeshyGeometry, decodeMeshyGeometry } from './meshy-geometry';

type Point = readonly [number, number, number];
const LENGTH_METRES = 37.57;
const WINGSPAN_METRES = 35.8;
const FUSELAGE_WIDTH_METRES = 3.95;

function bounds(points: readonly Point[]) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const point of points)
    for (let axis = 0; axis < 3; axis++) {
      min[axis] = Math.min(min[axis]!, point[axis]!);
      max[axis] = Math.max(max[axis]!, point[axis]!);
    }
  return { min, max, extent: min.map((n, axis) => max[axis]! - n) };
}

const dot = (a: Point, b: Point) => a.reduce((sum, n, axis) => sum + n * b[axis]!, 0);

export function buildFlatMeshyParts(
  parts: { id: string; positions: Point[] }[],
  generator = 'Tailfin quarantine proportion correction v1',
) {
  const chunks: Buffer[] = [];
  const bufferViews: { buffer: 0; byteOffset: number; byteLength: number; target: 34962 }[] = [];
  const accessors: {
    bufferView: number;
    componentType: 5126;
    count: number;
    type: 'VEC3';
    min?: number[];
    max?: number[];
  }[] = [];
  let byteOffset = 0;
  const append = (values: readonly Point[], includeBounds: boolean) => {
    const bytes = Buffer.alloc(values.length * 12);
    values.forEach((point, index) =>
      point.forEach((n, axis) => bytes.writeFloatLE(n, index * 12 + axis * 4)),
    );
    chunks.push(bytes);
    bufferViews.push({ buffer: 0, byteOffset, byteLength: bytes.length, target: 34962 });
    byteOffset += bytes.length;
    const measured = bounds(values);
    accessors.push({
      bufferView: bufferViews.length - 1,
      componentType: 5126,
      count: values.length,
      type: 'VEC3',
      ...(includeBounds ? { min: measured.min, max: measured.max } : {}),
    });
    return accessors.length - 1;
  };
  const meshes = parts.map((part) => {
    const normals: Point[] = [];
    for (let index = 0; index < part.positions.length; index += 3) {
      const [a, b, c] = part.positions.slice(index, index + 3) as [Point, Point, Point];
      const ab: Point = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
      const ac: Point = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
      const cross: Point = [
        ab[1] * ac[2] - ab[2] * ac[1],
        ab[2] * ac[0] - ab[0] * ac[2],
        ab[0] * ac[1] - ab[1] * ac[0],
      ];
      const length = Math.hypot(...cross);
      if (!length) throw new Error('Proportion correction created a degenerate face.');
      const normal: Point = [cross[0] / length, cross[1] / length, cross[2] / length];
      normals.push(normal, normal, normal);
    }
    return {
      name: part.id,
      primitives: [
        { attributes: { POSITION: append(part.positions, true), NORMAL: append(normals, false) } },
      ],
    };
  });
  const binary = Buffer.concat(chunks);
  const json = Buffer.from(
    canonicalJson({
      asset: { version: '2.0', generator },
      scene: 0,
      scenes: [{ nodes: parts.map((_, index) => index) }],
      nodes: parts.map((part, mesh) => ({ mesh, name: part.id })),
      meshes,
      accessors,
      bufferViews,
      buffers: [{ byteLength: binary.length }],
    }),
  );
  const jsonLength = Math.ceil(json.length / 4) * 4;
  const glb = Buffer.alloc(28 + jsonLength + binary.length);
  [0x46546c67, 2, glb.length, jsonLength, 0x4e4f534a].forEach((n, index) =>
    glb.writeUInt32LE(n, index * 4),
  );
  glb.fill(0x20, 20, 20 + jsonLength);
  json.copy(glb, 20);
  glb.writeUInt32LE(binary.length, 20 + jsonLength);
  glb.writeUInt32LE(0x004e4942, 24 + jsonLength);
  binary.copy(glb, 28 + jsonLength);
  return glb;
}

/** Explicit quarantined deformation: canonical frame plus centre-preserving outboard span correction. */
export function correctA320neoProportions(reviewGlb: Uint8Array, axisMatrix: readonly Point[]) {
  const [right, up, back] = axisMatrix;
  if (
    axisMatrix.length !== 3 ||
    axisMatrix.some((row) => row.length !== 3 || row.some((n) => ![-1, 0, 1].includes(n))) ||
    !right ||
    !up ||
    !back ||
    dot(right, up) !== 0 ||
    dot(right, back) !== 0 ||
    dot(up, back) !== 0 ||
    right[1] * up[2] - right[2] * up[1] !== back[0] ||
    right[2] * up[0] - right[0] * up[2] !== back[1] ||
    right[0] * up[1] - right[1] * up[0] !== back[2]
  )
    throw new Error('Proportion correction refused: invalid reviewed axis matrix.');
  const decoded = decodeMeshyGeometry(reviewGlb);
  const names = decoded.parts.map((part) => part.name);
  if (
    decoded.positions.length !== decoded.triangles.length * 3 ||
    decoded.normalsVertices !== decoded.positions.length ||
    decoded.nonUnitNormals !== 0 ||
    decoded.uvVertices !== 0 ||
    new Set(names).size !== names.length ||
    decoded.parts.some(
      (part) =>
        part.indexed ||
        part.positionCount !== part.triangleCount * 3 ||
        !/^review_component_\d{3}$/.test(part.name ?? ''),
    )
  )
    throw new Error('Proportion correction requires the corner-expanded review derivative.');
  const sourceBounds = bounds(decoded.positions);
  const orientedCorners: Point[] = [];
  for (const x of [sourceBounds.min[0]!, sourceBounds.max[0]!])
    for (const y of [sourceBounds.min[1]!, sourceBounds.max[1]!])
      for (const z of [sourceBounds.min[2]!, sourceBounds.max[2]!])
        orientedCorners.push(axisMatrix.map((row) => dot(row, [x, y, z])) as unknown as Point);
  const orientedBounds = bounds(orientedCorners);
  const scale = LENGTH_METRES / orientedBounds.extent[2]!;
  const origin: Point = [
    -((orientedBounds.min[0]! + orientedBounds.max[0]!) / 2) * scale,
    -orientedBounds.min[1]! * scale,
    -((orientedBounds.min[2]! + orientedBounds.max[2]!) / 2) * scale,
  ];
  const beforeHalfSpan = (orientedBounds.extent[0]! * scale) / 2;
  const targetHalfSpan = WINGSPAN_METRES / 2;
  const coreHalfWidth = FUSELAGE_WIDTH_METRES / 2;
  if (beforeHalfSpan <= targetHalfSpan || beforeHalfSpan <= coreHalfWidth)
    throw new Error(
      'Proportion correction refused: source does not require bounded span reduction.',
    );
  const outboardRatio = (targetHalfSpan - coreHalfWidth) / (beforeHalfSpan - coreHalfWidth);
  const warpSpan = (x: number) =>
    Math.abs(x) <= coreHalfWidth
      ? x
      : Math.sign(x) * (coreHalfWidth + (Math.abs(x) - coreHalfWidth) * outboardRatio);
  const canonical = decoded.positions.map((point) => {
    const mapped = axisMatrix.map((row) => dot(row, point));
    return mapped.map((n, axis) => n * scale + origin[axis]!) as unknown as Point;
  });
  const mainPart = decoded.parts.reduce((largest, part) =>
    part.triangleCount > largest.triangleCount ? part : largest,
  );
  let maxDisplacement = 0;
  const componentCorrections: {
    id: string;
    triangles: number;
    method: string;
    lateralShiftMetres: number | null;
    beforeBoundsCanonicalMetres: ReturnType<typeof bounds>;
    afterBoundsCanonicalMetres: ReturnType<typeof bounds>;
  }[] = [];
  const parts = decoded.parts.map((part, index) => {
    const id = part.name ?? `review_component_${String(index + 1).padStart(3, '0')}`;
    const original = canonical.slice(part.positionStart, part.positionStart + part.positionCount);
    const partBounds = bounds(original);
    const centreX = (partBounds.min[0]! + partBounds.max[0]!) / 2;
    const rigidDelta = warpSpan(centreX) - centreX;
    const positions = original.map((point) => {
      const x = part === mainPart ? warpSpan(point[0]) : point[0] + rigidDelta;
      maxDisplacement = Math.max(maxDisplacement, Math.abs(x - point[0]));
      return [x, point[1], point[2]] as Point;
    });
    componentCorrections.push({
      id,
      triangles: part.triangleCount,
      method: part === mainPart ? 'outboard-span-remap' : 'rigid-lateral-reposition',
      lateralShiftMetres: part === mainPart ? null : rigidDelta,
      beforeBoundsCanonicalMetres: partBounds,
      afterBoundsCanonicalMetres: bounds(positions),
    });
    return { id, positions };
  });
  const glb = buildFlatMeshyParts(parts);
  const after = auditMeshyGeometry(glb).metrics;
  if (
    Math.abs(after.boundsSourceUnits.extent[0]! - WINGSPAN_METRES) > 1e-4 ||
    Math.abs(after.boundsSourceUnits.extent[2]! - LENGTH_METRES) > 1e-4 ||
    after.sourceTriangles !== decoded.triangles.length
  )
    throw new Error('Proportion correction failed its dimensional invariant.');
  return {
    glb,
    report: {
      format: 'tailfin-meshy-proportion-correction',
      formatVersion: 1,
      algorithm: 'canonical-length-centre-preserving-outboard-span-v1',
      sourceReviewSha256: sha256(reviewGlb),
      derivativeSha256: sha256(glb),
      state: 'quarantine',
      runtimeAdmission: 'not-reviewed',
      liveryReady: false,
      canonicalFrameApplied: true,
      semanticPartsAssigned: false,
      targetDimensionsMet: true,
      coordinateUnits: 'metres',
      target: {
        lengthMetres: LENGTH_METRES,
        wingspanMetres: WINGSPAN_METRES,
        preservedCentreWidthMetres: FUSELAGE_WIDTH_METRES,
      },
      transform: {
        sourceToCanonicalAxisMatrix: axisMatrix,
        uniformScaleMetresPerSourceUnit: scale,
        originTranslationMetres: origin,
        outboardSpanRatio: outboardRatio,
        mainReviewComponent: mainPart.name,
        mainComponentDeformation: 'outboard-span-remap',
        otherComponentDeformation: 'rigid-lateral-reposition',
        maxVertexDisplacementMetres: maxDisplacement,
        componentCorrections,
      },
      after,
      limitations: [
        'This is an explicit geometric correction, not source preservation or semantic repair.',
        'The largest review component is deformed without claiming it is a clean fuselage/wing semantic mesh.',
        'Detached components are repositioned rigidly by bounds centre; identities remain source-scoped review IDs.',
        'Flat normals are regenerated; winding, boundary openings and the flagged coincident face remain unresolved.',
        'Visual silhouette, engine placement, protected surfaces, canonical UVs, licensing and runtime admission remain pending.',
      ],
    },
  };
}
