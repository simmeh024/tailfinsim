import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { Document, NodeIO, type Material, type Texture } from '@gltf-transform/core';
import { cloneDocument, getBounds, prune, simplifyPrimitive } from '@gltf-transform/functions';
import { MeshoptSimplifier } from 'meshoptimizer';
import sharp from 'sharp';
import * as watlas from 'watlas';

import {
  AIRCRAFT_ASSET_COVERAGE_V1,
  AIRCRAFT_ASSET_MANIFEST_FORMAT,
  AIRCRAFT_ASSET_MANIFEST_VERSION,
  AircraftAnchorId,
  AircraftAssetTechnicalManifest,
  AircraftLightSocketId,
  type AircraftAssetTechnicalManifest as AircraftAssetTechnicalManifestValue,
} from '@tailfin/shared';

import { canonicalJson, sha256 } from './canonical';
import { inspectTechnicalGlbCandidate } from './model';
import {
  AIRCRAFT_OPTIMISATION_DECISION_FORMAT,
  AIRCRAFT_OPTIMISATION_DECISION_VERSION,
  AircraftOptimisationDecision,
} from './schema';

export const A320NEO_SALVAGE_VERSION = '1.2.0' as const;

const TARGET_DIMENSIONS_M = { width: 35.8, length: 37.57, height: 11.76 } as const;
const LOD_RATIOS = [0.12, 0.05, 0.018] as const;
const TEXTURE_SIZE = 4_096;
const LIVERY_UV_PADDING_PX = 8;
const LIVERY_UV_SLOT_PADDING_PX = 16;
const LIVERY_UV_CHART_PADDING_PX = 32;
const LIVERY_UV_DEGENERATE_AREA_EPSILON = 2e-10;
const LIVERY_UV_PRECOMPRESSION_AREA_EPSILON = 2.5e-10;
const CONSERVATIVE_TEXTURE_MEMORY_BYTES = 178_956_976;

export const A320NEO_SURFACE_CLASSES = [
  'fuselage',
  'fin',
  'horizontal_stabilisers',
  'wings',
  'winglets',
  'nacelle_exteriors',
  'cockpit_glass',
  'cabin_windows',
  'rubber_tyres',
  'lights',
  'engine_interiors',
] as const;

export type A320neoSurfaceClass = (typeof A320NEO_SURFACE_CLASSES)[number];

const PAINTABLE_CLASSES = new Set<A320neoSurfaceClass>([
  'fuselage',
  'fin',
  'horizontal_stabilisers',
  'wings',
  'winglets',
  'nacelle_exteriors',
]);

const LIVERY_UV_SLOTS: Readonly<
  Partial<Record<A320neoSurfaceClass, readonly [column: number, row: number]>>
> = {
  fuselage: [0, 0],
  fin: [1, 0],
  horizontal_stabilisers: [2, 0],
  wings: [0, 1],
  winglets: [1, 1],
  nacelle_exteriors: [2, 1],
};

const CLASS_INDEX = new Map(
  A320NEO_SURFACE_CLASSES.map((surfaceClass, index) => [surfaceClass, index]),
);

const MATERIAL_NAMES: Record<A320neoSurfaceClass, string> = {
  fuselage: 'mat-fuselage',
  fin: 'mat-fin',
  horizontal_stabilisers: 'mat-horizontal-stabilisers',
  wings: 'mat-wings',
  winglets: 'mat-winglets',
  nacelle_exteriors: 'mat-nacelle-exteriors',
  cockpit_glass: 'mat-cockpit-glass',
  cabin_windows: 'mat-cabin-windows',
  rubber_tyres: 'mat-rubber-tyres',
  lights: 'mat-lights',
  engine_interiors: 'mat-engine-interiors',
};

const SURFACE_CLASS_BY_MATERIAL = new Map(
  A320NEO_SURFACE_CLASSES.map((surfaceClass) => [MATERIAL_NAMES[surfaceClass], surfaceClass]),
);

const SURFACE_COLOURS: Record<A320neoSurfaceClass, string> = {
  fuselage: '#d9e6f2',
  fin: '#4ea7df',
  horizontal_stabilisers: '#8bb8d8',
  wings: '#b8d3e5',
  winglets: '#f5a742',
  nacelle_exteriors: '#80c995',
  cockpit_glass: '#172a3b',
  cabin_windows: '#27394a',
  rubber_tyres: '#25272b',
  lights: '#ff5b5b',
  engine_interiors: '#15191e',
};

interface Vec3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

interface ComponentStats {
  readonly root: number;
  triangles: number;
  readonly min: [number, number, number];
  readonly max: [number, number, number];
}

interface ColourSampler {
  readonly data: Buffer;
  readonly width: number;
  readonly height: number;
  readonly channels: number;
}

interface SourceGeometry {
  readonly positions: Float32Array;
  readonly normals: Float32Array;
  readonly uv0: Float32Array;
  readonly indices: Uint32Array;
  readonly baseColourBytes: Uint8Array;
  readonly metallicRoughnessBytes: Uint8Array;
}

interface ClassificationResult {
  readonly indices: Readonly<Record<A320neoSurfaceClass, Uint32Array>>;
  readonly sourceTriangles: Readonly<Record<A320neoSurfaceClass, number>>;
  readonly fallbackAssignments: readonly A320neoSurfaceClass[];
  readonly componentCount: number;
}

interface UvCleanupEntry {
  duplicateFaces: number;
  degenerateUvFaces: number;
  overlappingUvFaces: number;
}

type UvCleanupStats = Record<string, UvCleanupEntry>;

function recordUvCleanup(
  stats: UvCleanupStats,
  level: number,
  surfaceClass: A320neoSurfaceClass,
  field: keyof UvCleanupEntry,
  count: number,
): void {
  const key = `lod${String(level)}.${surfaceClass}`;
  const entry = stats[key] ?? {
    duplicateFaces: 0,
    degenerateUvFaces: 0,
    overlappingUvFaces: 0,
  };
  entry[field] += count;
  stats[key] = entry;
}

export interface SalvageA320neoOptions {
  readonly inputPath: string;
  readonly outputDirectory: string;
  readonly reviewedAt: string;
}

export interface SalvageA320neoResult {
  readonly sourcePath: string;
  readonly lodPaths: readonly [string, string, string];
  readonly manifestDraftPath: string;
  readonly decisionPath: string;
  readonly reportPath: string;
  readonly previewPath: string;
  readonly sourceSha256: string;
  readonly sourceByteSize: number;
  readonly lodTriangles: readonly [number, number, number];
}

async function stagedLodBinary(document: Document, level: 0 | 1 | 2): Promise<Uint8Array> {
  const staged = cloneDocument(document);
  const stagedRoot = staged
    .getRoot()
    .listNodes()
    .find((node) => node.getName() === 'aircraft-root');
  if (!stagedRoot) throw new Error('Cannot stage an A320neo LOD without aircraft-root');

  for (const child of stagedRoot.listChildren()) {
    if (/^lod[0-2]$/.test(child.getName()) && child.getName() !== `lod${String(level)}`) {
      child.dispose();
    }
  }
  await staged.transform(prune());
  return new NodeIO().writeBinary(staged);
}

function hash(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function find(parent: Int32Array, input: number): number {
  let root = input;
  while (parent[root]! >= 0) root = parent[root]!;
  let current = input;
  while (current !== root) {
    const next = parent[current]!;
    parent[current] = root;
    current = next;
  }
  return root;
}

function union(parent: Int32Array, leftInput: number, rightInput: number): void {
  let left = find(parent, leftInput);
  let right = find(parent, rightInput);
  if (left === right) return;
  if (parent[left]! > parent[right]!) [left, right] = [right, left];
  parent[left] = parent[left]! + parent[right]!;
  parent[right] = left;
}

function componentStats(
  positions: Float32Array,
  indices: Uint32Array,
): {
  readonly roots: Int32Array;
  readonly components: ReadonlyMap<number, ComponentStats>;
} {
  const vertexCount = positions.length / 3;
  const parent = new Int32Array(vertexCount);
  parent.fill(-1);
  for (let offset = 0; offset < indices.length; offset += 3) {
    const left = indices[offset]!;
    const middle = indices[offset + 1]!;
    const right = indices[offset + 2]!;
    union(parent, left, middle);
    union(parent, left, right);
  }
  const roots = new Int32Array(vertexCount);
  const components = new Map<number, ComponentStats>();
  for (let vertex = 0; vertex < vertexCount; vertex += 1) {
    const root = find(parent, vertex);
    roots[vertex] = root;
    let component = components.get(root);
    if (!component) {
      component = {
        root,
        triangles: 0,
        min: [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY],
        max: [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY],
      };
      components.set(root, component);
    }
    for (let axis = 0; axis < 3; axis += 1) {
      const value = positions[vertex * 3 + axis]!;
      component.min[axis] = Math.min(component.min[axis]!, value);
      component.max[axis] = Math.max(component.max[axis]!, value);
    }
  }
  for (let offset = 0; offset < indices.length; offset += 3) {
    components.get(roots[indices[offset]!]!)!.triangles += 1;
  }
  return { roots, components };
}

async function colourSampler(bytes: Uint8Array): Promise<ColourSampler> {
  const { data, info } = await sharp(bytes)
    .resize(1_024, 1_024, { fit: 'fill' })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height, channels: info.channels };
}

function sampleColour(sampler: ColourSampler, uInput: number, vInput: number): Vec3 {
  const u = Math.max(0, Math.min(1, uInput));
  const v = Math.max(0, Math.min(1, vInput));
  const x = Math.floor(u * (sampler.width - 1));
  const y = Math.floor((1 - v) * (sampler.height - 1));
  const offset = (y * sampler.width + x) * sampler.channels;
  return {
    x: sampler.data[offset] ?? 255,
    y: sampler.data[offset + 1] ?? 255,
    z: sampler.data[offset + 2] ?? 255,
  };
}

function componentCentre(component: ComponentStats): Vec3 {
  return {
    x: (component.min[0] + component.max[0]) / 2,
    y: (component.min[1] + component.max[1]) / 2,
    z: (component.min[2] + component.max[2]) / 2,
  };
}

function componentSize(component: ComponentStats): Vec3 {
  return {
    x: component.max[0] - component.min[0],
    y: component.max[1] - component.min[1],
    z: component.max[2] - component.min[2],
  };
}

export function classifyA320neoSurface(input: {
  readonly centre: Vec3;
  readonly normal: Vec3;
  readonly colour: Vec3;
  readonly componentCentre: Vec3;
  readonly componentSize: Vec3;
  readonly componentTriangles: number;
}): A320neoSurfaceClass {
  const { centre, normal, colour, componentCentre: component, componentSize: size } = input;
  const absoluteX = Math.abs(centre.x);
  const componentAbsoluteX = Math.abs(component.x);
  const luminance = (colour.x + colour.y + colour.z) / 3;
  const saturation =
    Math.max(colour.x, colour.y, colour.z) - Math.min(colour.x, colour.y, colour.z);
  const nacelleZone =
    absoluteX >= 0.105 &&
    absoluteX <= 0.255 &&
    centre.z >= 0.015 &&
    centre.z <= 0.255 &&
    centre.y < -0.052;

  if (absoluteX > 0.493 && Math.abs(centre.z) < 0.075 && centre.y > -0.055) return 'lights';
  if (
    input.componentTriangles < 3_000 &&
    component.y < -0.135 &&
    componentAbsoluteX > 0.12 &&
    componentAbsoluteX < 0.24 &&
    Math.max(size.x, size.y, size.z) < 0.04
  ) {
    return 'rubber_tyres';
  }
  if (nacelleZone && (luminance < 112 || Math.abs(normal.z) > 0.72)) {
    return 'engine_interiors';
  }
  if (
    centre.z > 0.32 &&
    absoluteX < 0.065 &&
    luminance < 130 &&
    (Math.abs(normal.x) > 0.2 || normal.y > 0.15)
  ) {
    return 'cockpit_glass';
  }
  if (
    centre.z > -0.31 &&
    centre.z < 0.31 &&
    absoluteX < 0.075 &&
    luminance < 112 &&
    Math.abs(normal.x) > 0.35
  ) {
    return 'cabin_windows';
  }
  if (saturation > 65 && (absoluteX > 0.35 || (centre.z < -0.28 && centre.y > 0.04))) {
    return 'lights';
  }
  if (absoluteX > 0.39 && centre.y > -0.025 && centre.z > -0.24 && centre.z < 0.12) {
    return 'winglets';
  }
  if (absoluteX < 0.055 && centre.z < -0.28 && centre.y > 0.025) {
    return 'fin';
  }
  if (centre.z < -0.245 && absoluteX > 0.035) {
    return 'horizontal_stabilisers';
  }
  if (absoluteX > 0.075 && centre.z > -0.2 && centre.z < 0.2 && centre.y > -0.065) {
    return 'wings';
  }
  if (nacelleZone) return 'nacelle_exteriors';
  return 'fuselage';
}

function fallbackScore(surfaceClass: A320neoSurfaceClass, centre: Vec3, colour: Vec3): number {
  const luminance = (colour.x + colour.y + colour.z) / 3;
  switch (surfaceClass) {
    case 'lights':
      return Math.abs(Math.abs(centre.x) - 0.5) + Math.abs(centre.z) + Math.abs(centre.y + 0.01);
    case 'rubber_tyres':
      return (
        Math.abs(centre.y + 0.15) + Math.abs(Math.abs(centre.x) - 0.18) + Math.abs(centre.z - 0.13)
      );
    case 'engine_interiors':
      return (
        Math.abs(Math.abs(centre.x) - 0.18) +
        Math.abs(centre.y + 0.11) +
        Math.abs(centre.z - 0.17) +
        luminance / 500
      );
    case 'cockpit_glass':
      return Math.abs(centre.z - 0.44) + Math.abs(centre.x) + luminance / 500;
    case 'cabin_windows':
      return Math.abs(Math.abs(centre.x) - 0.05) + Math.abs(centre.y + 0.06) + luminance / 500;
    case 'winglets':
      return Math.abs(Math.abs(centre.x) - 0.48) + Math.abs(centre.y - 0.015);
    case 'fin':
      return Math.abs(centre.x) + Math.abs(centre.y - 0.1) + Math.abs(centre.z + 0.4);
    case 'horizontal_stabilisers':
      return Math.abs(Math.abs(centre.x) - 0.13) + Math.abs(centre.z + 0.4);
    case 'wings':
      return Math.abs(Math.abs(centre.x) - 0.32) + Math.abs(centre.z);
    case 'nacelle_exteriors':
      return (
        Math.abs(Math.abs(centre.x) - 0.18) + Math.abs(centre.y + 0.1) + Math.abs(centre.z - 0.16)
      );
    case 'fuselage':
      return Math.abs(centre.x) + Math.abs(centre.y + 0.07) + Math.abs(centre.z);
  }
}

async function classifyGeometry(source: SourceGeometry): Promise<ClassificationResult> {
  const sampler = await colourSampler(source.baseColourBytes);
  const { roots, components } = componentStats(source.positions, source.indices);
  const triangleCount = source.indices.length / 3;
  const assignments = new Uint8Array(triangleCount);
  const counts = new Uint32Array(A320NEO_SURFACE_CLASSES.length);
  const candidates = A320NEO_SURFACE_CLASSES.map(() => ({
    triangle: -1,
    score: Number.POSITIVE_INFINITY,
  }));

  for (let triangle = 0; triangle < triangleCount; triangle += 1) {
    const offset = triangle * 3;
    const vertices = [
      source.indices[offset]!,
      source.indices[offset + 1]!,
      source.indices[offset + 2]!,
    ] as const;
    const centre = { x: 0, y: 0, z: 0 };
    const normal = { x: 0, y: 0, z: 0 };
    let u = 0;
    let v = 0;
    for (const vertex of vertices) {
      centre.x += source.positions[vertex * 3]! / 3;
      centre.y += source.positions[vertex * 3 + 1]! / 3;
      centre.z += source.positions[vertex * 3 + 2]! / 3;
      normal.x += source.normals[vertex * 3]! / 3;
      normal.y += source.normals[vertex * 3 + 1]! / 3;
      normal.z += source.normals[vertex * 3 + 2]! / 3;
      u += source.uv0[vertex * 2]! / 3;
      v += source.uv0[vertex * 2 + 1]! / 3;
    }
    const colour = sampleColour(sampler, u, v);
    const componentStatsValue = components.get(roots[vertices[0]]!);
    if (!componentStatsValue) {
      throw new Error(`Missing connected-component statistics for triangle ${triangle}`);
    }
    const surfaceClass = classifyA320neoSurface({
      centre,
      normal,
      colour,
      componentCentre: componentCentre(componentStatsValue),
      componentSize: componentSize(componentStatsValue),
      componentTriangles: componentStatsValue.triangles,
    });
    const classIndex = CLASS_INDEX.get(surfaceClass)!;
    assignments[triangle] = classIndex;
    counts[classIndex] = counts[classIndex]! + 1;
    for (const [candidateIndex, candidateClass] of A320NEO_SURFACE_CLASSES.entries()) {
      const score = fallbackScore(candidateClass, centre, colour);
      if (score < candidates[candidateIndex]!.score) {
        candidates[candidateIndex] = { triangle, score };
      }
    }
  }

  const fallbackAssignments: A320neoSurfaceClass[] = [];
  for (const [classIndex, surfaceClass] of A320NEO_SURFACE_CLASSES.entries()) {
    if (counts[classIndex]! > 0) continue;
    const triangle = candidates[classIndex]!.triangle;
    if (triangle < 0) throw new Error(`Cannot create required ${surfaceClass} material group`);
    const previous = assignments[triangle]!;
    if (counts[previous]! <= 1) throw new Error(`Cannot reserve geometry for ${surfaceClass}`);
    counts[previous] = counts[previous]! - 1;
    counts[classIndex] = counts[classIndex]! + 1;
    assignments[triangle] = classIndex;
    fallbackAssignments.push(surfaceClass);
  }

  const classIndices = Object.fromEntries(
    A320NEO_SURFACE_CLASSES.map((surfaceClass, index) => [
      surfaceClass,
      new Uint32Array(counts[index]! * 3),
    ]),
  ) as Record<A320neoSurfaceClass, Uint32Array>;
  const cursors = new Uint32Array(A320NEO_SURFACE_CLASSES.length);
  for (let triangle = 0; triangle < triangleCount; triangle += 1) {
    const classIndex = assignments[triangle]!;
    const target = classIndices[A320NEO_SURFACE_CLASSES[classIndex]!];
    const cursor = cursors[classIndex]! * 3;
    const sourceOffset = triangle * 3;
    target[cursor] = source.indices[sourceOffset]!;
    target[cursor + 1] = source.indices[sourceOffset + 1]!;
    target[cursor + 2] = source.indices[sourceOffset + 2]!;
    cursors[classIndex] = cursors[classIndex]! + 1;
  }

  return {
    indices: classIndices,
    sourceTriangles: Object.fromEntries(
      A320NEO_SURFACE_CLASSES.map((surfaceClass, index) => [surfaceClass, counts[index]!]),
    ) as Record<A320neoSurfaceClass, number>,
    fallbackAssignments,
    componentCount: components.size,
  };
}

function normalizedGeometry(
  source: SourceGeometry,
): Pick<SourceGeometry, 'positions' | 'normals' | 'uv0'> {
  const positions = new Float32Array(source.positions.length);
  const normals = new Float32Array(source.normals.length);
  const vertexCount = source.positions.length / 3;
  const min = [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY];
  const max = [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY];
  for (let vertex = 0; vertex < vertexCount; vertex += 1) {
    for (let axis = 0; axis < 3; axis += 1) {
      const value = source.positions[vertex * 3 + axis]!;
      min[axis] = Math.min(min[axis]!, value);
      max[axis] = Math.max(max[axis]!, value);
    }
  }
  const scales = [
    TARGET_DIMENSIONS_M.width / (max[0]! - min[0]!),
    TARGET_DIMENSIONS_M.height / (max[1]! - min[1]!),
    TARGET_DIMENSIONS_M.length / (max[2]! - min[2]!),
  ] as const;
  const centreX = (min[0]! + max[0]!) / 2;
  for (let vertex = 0; vertex < vertexCount; vertex += 1) {
    const x = source.positions[vertex * 3]!;
    const y = source.positions[vertex * 3 + 1]!;
    const z = source.positions[vertex * 3 + 2]!;
    positions[vertex * 3] = (x - centreX) * scales[0];
    positions[vertex * 3 + 1] = (y - min[1]!) * scales[1];
    positions[vertex * 3 + 2] = -z * scales[2];

    const nx = source.normals[vertex * 3]! / scales[0];
    const ny = source.normals[vertex * 3 + 1]! / scales[1];
    const nz = -source.normals[vertex * 3 + 2]! / scales[2];
    const length = Math.hypot(nx, ny, nz) || 1;
    normals[vertex * 3] = nx / length;
    normals[vertex * 3 + 1] = ny / length;
    normals[vertex * 3 + 2] = nz / length;
  }
  return { positions, normals, uv0: new Float32Array(source.uv0) };
}

async function resizedTextures(source: SourceGeometry): Promise<{
  readonly baseColour: Buffer;
  readonly metallicRoughness: Buffer;
  readonly normal: Buffer;
}> {
  const baseColour = await sharp(source.baseColourBytes)
    .resize(TEXTURE_SIZE, TEXTURE_SIZE, { fit: 'fill' })
    .jpeg({ quality: 88, chromaSubsampling: '4:4:4', progressive: false, mozjpeg: false })
    .toBuffer();
  const metallicRoughness = await sharp(source.metallicRoughnessBytes)
    .resize(TEXTURE_SIZE, TEXTURE_SIZE, { fit: 'fill' })
    .jpeg({ quality: 90, chromaSubsampling: '4:4:4', progressive: false, mozjpeg: false })
    .toBuffer();
  const normal = await sharp({
    create: {
      width: 1,
      height: 1,
      channels: 3,
      background: { r: 128, g: 128, b: 255 },
    },
  })
    .png({ compressionLevel: 9, adaptiveFiltering: false })
    .toBuffer();
  return { baseColour, metallicRoughness, normal };
}

function makeMaterial(
  document: Document,
  surfaceClass: A320neoSurfaceClass,
  textures: {
    readonly base: Texture;
    readonly normal: Texture;
    readonly metallicRoughness: Texture;
  },
): Material {
  const material = document
    .createMaterial(MATERIAL_NAMES[surfaceClass])
    .setBaseColorTexture(textures.base)
    .setNormalTexture(textures.normal)
    .setMetallicRoughnessTexture(textures.metallicRoughness)
    .setMetallicFactor(0.18)
    .setRoughnessFactor(0.62);
  if (surfaceClass === 'cockpit_glass' || surfaceClass === 'cabin_windows') {
    material
      .setBaseColorFactor([0.2, 0.3, 0.42, 1])
      .setMetallicFactor(0.35)
      .setRoughnessFactor(0.2);
  } else if (surfaceClass === 'rubber_tyres') {
    material
      .setBaseColorFactor([0.08, 0.08, 0.09, 1])
      .setMetallicFactor(0)
      .setRoughnessFactor(0.92);
  } else if (surfaceClass === 'engine_interiors') {
    material
      .setBaseColorFactor([0.2, 0.21, 0.23, 1])
      .setMetallicFactor(0.7)
      .setRoughnessFactor(0.38);
  } else if (surfaceClass === 'lights') {
    material.setBaseColorFactor([1, 0.7, 0.58, 1]).setEmissiveFactor([0.4, 0.12, 0.08]);
  }
  return material;
}

function attachPrimitiveBuffer(
  primitive: ReturnType<Document['createPrimitive']>,
  buffer: ReturnType<Document['createBuffer']>,
): void {
  primitive.getIndices()?.setBuffer(buffer);
  for (const attribute of primitive.listAttributes()) attribute.setBuffer(buffer);
}

function simplifySemanticPrimitive(
  primitive: ReturnType<Document['createPrimitive']>,
  buffer: ReturnType<Document['createBuffer']>,
  ratio: number,
  lockBorder: boolean,
): void {
  const sourceIndexCount = primitive.getIndices()?.getCount() ?? 0;
  const minimumRatio = sourceIndexCount === 0 ? 1 : 3 / sourceIndexCount;
  simplifyPrimitive(primitive, {
    simplifier: MeshoptSimplifier,
    ratio: Math.min(1, Math.max(ratio, minimumRatio)),
    error: 1,
    // LOD0 is the persistent review model, so its semantic boundaries stay
    // fixed. Temporary lower LODs may relax them to reach their loading budget.
    lockBorder,
  });
  attachPrimitiveBuffer(primitive, buffer);
}

function removeDuplicateIndexTriangles(primitive: ReturnType<Document['createPrimitive']>): number {
  const indices = primitive.getIndices();
  const array = indices?.getArray();
  if (!indices || !array) return 0;
  const seen = new Set<string>();
  const retained: number[] = [];
  for (let offset = 0; offset < array.length; offset += 3) {
    const triangle = [array[offset]!, array[offset + 1]!, array[offset + 2]!].sort(
      (left, right) => left - right,
    );
    const key = triangle.join(':');
    if (seen.has(key)) continue;
    seen.add(key);
    retained.push(array[offset]!, array[offset + 1]!, array[offset + 2]!);
  }
  const removed = (array.length - retained.length) / 3;
  if (removed > 0) indices.setArray(new Uint32Array(retained));
  return removed;
}

function unwrapPrimitiveWithPadding(
  document: Document,
  buffer: ReturnType<Document['createBuffer']>,
  primitive: ReturnType<Document['createPrimitive']>,
  surfaceClass: A320neoSurfaceClass,
): void {
  const position = primitive.getAttribute('POSITION');
  const normal = primitive.getAttribute('NORMAL');
  const uv0 = primitive.getAttribute('TEXCOORD_0');
  const indices = primitive.getIndices();
  if (!position || !normal || !uv0 || !indices) {
    throw new Error(
      `${surfaceClass} cannot be unwrapped without indexed POSITION/NORMAL/TEXCOORD_0`,
    );
  }
  const positionArray = position.getArray();
  const normalArray = normal.getArray();
  const uv0Array = uv0.getArray();
  const indexArray = indices.getArray();
  if (
    !(positionArray instanceof Float32Array) ||
    !(normalArray instanceof Float32Array) ||
    !(uv0Array instanceof Float32Array) ||
    !indexArray
  ) {
    throw new Error(`${surfaceClass} unwrap inputs have unsupported component types`);
  }
  const atlas = new watlas.Atlas();
  try {
    atlas.addMesh({
      vertexPositionData: positionArray,
      vertexCount: position.getCount(),
      vertexPositionStride: 3 * Float32Array.BYTES_PER_ELEMENT,
      vertexNormalData: normalArray,
      vertexNormalStride: 3 * Float32Array.BYTES_PER_ELEMENT,
      vertexUvData: uv0Array,
      vertexUvStride: 2 * Float32Array.BYTES_PER_ELEMENT,
      indexData: new Uint32Array(indexArray),
      indexCount: indices.getCount(),
    });
    atlas.generate(
      { useInputMeshUvs: false, fixWinding: true },
      {
        padding: LIVERY_UV_CHART_PADDING_PX,
        resolution: TEXTURE_SIZE,
        bilinear: true,
        blockAlign: false,
        rotateCharts: true,
      },
    );
    if (atlas.meshCount !== 1 || atlas.atlasCount !== 1 || atlas.width <= 0 || atlas.height <= 0) {
      throw new Error(
        `${surfaceClass} unwrap produced ${String(atlas.atlasCount)} atlases at ${String(atlas.width)}x${String(atlas.height)}`,
      );
    }
    const atlasMesh = atlas.getMesh(0);
    for (const [semantic, source] of [
      ['POSITION', position],
      ['NORMAL', normal],
      ['TEXCOORD_0', uv0],
    ] as const) {
      const sourceArray = source.getArray();
      if (!(sourceArray instanceof Float32Array)) {
        throw new Error(`${surfaceClass}.${semantic} is not float32`);
      }
      const elementSize = source.getElementSize();
      const targetArray = new Float32Array(atlasMesh.vertexCount * elementSize);
      for (let vertex = 0; vertex < atlasMesh.vertexCount; vertex += 1) {
        const sourceVertex = atlasMesh.getVertex(vertex).xref;
        for (let component = 0; component < elementSize; component += 1) {
          targetArray[vertex * elementSize + component] =
            sourceArray[sourceVertex * elementSize + component]!;
        }
      }
      primitive.setAttribute(
        semantic,
        document
          .createAccessor(`lod0-${surfaceClass}-${semantic.toLowerCase()}`)
          .setType(source.getType())
          .setArray(targetArray)
          .setBuffer(buffer),
      );
      source.dispose();
    }
    const uv1Array = new Float32Array(atlasMesh.vertexCount * 2);
    for (let vertex = 0; vertex < atlasMesh.vertexCount; vertex += 1) {
      const atlasVertex = atlasMesh.getVertex(vertex);
      uv1Array[vertex * 2] = atlasVertex.uv[0] / atlas.width;
      uv1Array[vertex * 2 + 1] = atlasVertex.uv[1] / atlas.height;
    }
    primitive.setAttribute(
      'TEXCOORD_1',
      document
        .createAccessor(`lod0-${surfaceClass}-texcoord_1`)
        .setType('VEC2')
        .setArray(uv1Array)
        .setBuffer(buffer),
    );
    const targetIndices = new Uint32Array(atlasMesh.indexCount);
    atlasMesh.getIndexArray(targetIndices);
    primitive.setIndices(
      document
        .createAccessor(`lod0-${surfaceClass}-unwrapped-indices`)
        .setType('SCALAR')
        .setArray(targetIndices)
        .setBuffer(buffer),
    );
    indices.dispose();
  } finally {
    atlas.delete();
  }
}

function rescaleLiveryUv(
  primitive: ReturnType<Document['createPrimitive']>,
  surfaceClass: A320neoSurfaceClass,
): void {
  const slot = LIVERY_UV_SLOTS[surfaceClass];
  const uv = primitive.getAttribute('TEXCOORD_1');
  if (!slot || !uv) return;
  const array = uv.getArray();
  if (!(array instanceof Float32Array)) throw new Error(`${surfaceClass} livery UV is not float32`);
  let minU = Number.POSITIVE_INFINITY;
  let minV = Number.POSITIVE_INFINITY;
  let maxU = Number.NEGATIVE_INFINITY;
  let maxV = Number.NEGATIVE_INFINITY;
  for (let offset = 0; offset < array.length; offset += 2) {
    minU = Math.min(minU, array[offset]!);
    minV = Math.min(minV, array[offset + 1]!);
    maxU = Math.max(maxU, array[offset]!);
    maxV = Math.max(maxV, array[offset + 1]!);
  }
  if (maxU - minU < 1e-8 || maxV - minV < 1e-8) {
    throw new Error(`${surfaceClass} livery UV atlas is degenerate`);
  }
  const padding = LIVERY_UV_SLOT_PADDING_PX / TEXTURE_SIZE;
  const targetMinU = slot[0] / 3 + padding;
  const targetMaxU = (slot[0] + 1) / 3 - padding;
  const targetMinV = slot[1] / 2 + padding;
  const targetMaxV = (slot[1] + 1) / 2 - padding;
  for (let offset = 0; offset < array.length; offset += 2) {
    array[offset] =
      targetMinU + ((array[offset]! - minU) / (maxU - minU)) * (targetMaxU - targetMinU);
    array[offset + 1] =
      targetMinV + ((array[offset + 1]! - minV) / (maxV - minV)) * (targetMaxV - targetMinV);
  }
  uv.setArray(array);
}

function findDegenerateLiveryTriangles(
  primitive: ReturnType<Document['createPrimitive']>,
  epsilon = LIVERY_UV_DEGENERATE_AREA_EPSILON,
): readonly number[] {
  const uv = primitive.getAttribute('TEXCOORD_1');
  const indices = primitive.getIndices();
  if (!uv || !indices) return [];
  const uvArray = uv.getArray();
  const indexArray = indices.getArray();
  if (!(uvArray instanceof Float32Array) || !indexArray) return [];
  const findings: number[] = [];
  for (let offset = 0; offset < indexArray.length; offset += 3) {
    const a = indexArray[offset]! * 2;
    const b = indexArray[offset + 1]! * 2;
    const c = indexArray[offset + 2]! * 2;
    const area = Math.abs(
      (uvArray[b]! - uvArray[a]!) * (uvArray[c + 1]! - uvArray[a + 1]!) -
        (uvArray[b + 1]! - uvArray[a + 1]!) * (uvArray[c]! - uvArray[a]!),
    );
    // Slightly stricter than the validator because the repair reserves 10% of
    // the U range; near-zero faces must be isolated before that compression.
    if (area <= epsilon) findings.push(offset / 3);
  }
  return findings;
}

interface SalvageUvTriangle {
  readonly indices: readonly [number, number, number];
  readonly points: readonly [
    readonly [number, number],
    readonly [number, number],
    readonly [number, number],
  ];
}

function uvSignedArea(points: SalvageUvTriangle['points']): number {
  const [a, b, c] = points;
  return ((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) / 2;
}

function uvCross(
  a: readonly [number, number],
  b: readonly [number, number],
  c: readonly [number, number],
): number {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

function uvLineIntersection(
  a: readonly [number, number],
  b: readonly [number, number],
  c: readonly [number, number],
  d: readonly [number, number],
): readonly [number, number] {
  const denominator = (a[0] - b[0]) * (c[1] - d[1]) - (a[1] - b[1]) * (c[0] - d[0]);
  if (Math.abs(denominator) < 1e-12) return b;
  const left = a[0] * b[1] - a[1] * b[0];
  const right = c[0] * d[1] - c[1] * d[0];
  return [
    (left * (c[0] - d[0]) - (a[0] - b[0]) * right) / denominator,
    (left * (c[1] - d[1]) - (a[1] - b[1]) * right) / denominator,
  ];
}

function uvOverlapArea(
  left: SalvageUvTriangle['points'],
  rightInput: SalvageUvTriangle['points'],
): number {
  let polygon: readonly (readonly [number, number])[] = left;
  const right =
    uvSignedArea(rightInput) < 0 ? [rightInput[0], rightInput[2], rightInput[1]] : rightInput;
  for (let edge = 0; edge < 3; edge += 1) {
    const clipA = right[edge]!;
    const clipB = right[(edge + 1) % 3]!;
    const output: (readonly [number, number])[] = [];
    for (let index = 0; index < polygon.length; index += 1) {
      const current = polygon[index]!;
      const previous = polygon[(index + polygon.length - 1) % polygon.length]!;
      const currentInside = uvCross(clipA, clipB, current) >= -1e-10;
      const previousInside = uvCross(clipA, clipB, previous) >= -1e-10;
      if (currentInside !== previousInside) {
        output.push(uvLineIntersection(previous, current, clipA, clipB));
      }
      if (currentInside) output.push(current);
    }
    polygon = output;
    if (polygon.length === 0) return 0;
  }
  let area = 0;
  for (let index = 0; index < polygon.length; index += 1) {
    const current = polygon[index]!;
    const next = polygon[(index + 1) % polygon.length]!;
    area += current[0] * next[1] - current[1] * next[0];
  }
  return Math.abs(area) / 2;
}

function findOverlappingLiveryTriangles(
  primitive: ReturnType<Document['createPrimitive']>,
): readonly number[] {
  const uv = primitive.getAttribute('TEXCOORD_1');
  const indices = primitive.getIndices();
  const uvArray = uv?.getArray();
  const indexArray = indices?.getArray();
  if (!uv || !indices || !(uvArray instanceof Float32Array) || !indexArray) return [];
  const cells = 96;
  const grid = new Map<string, SalvageUvTriangle[]>();
  const findings: number[] = [];
  for (let offset = 0; offset < indexArray.length; offset += 3) {
    const vertexIndices = [
      indexArray[offset]!,
      indexArray[offset + 1]!,
      indexArray[offset + 2]!,
    ] as const;
    const points = vertexIndices.map((vertex) => [
      uvArray[vertex * 2]!,
      uvArray[vertex * 2 + 1]!,
    ]) as unknown as SalvageUvTriangle['points'];
    const triangle: SalvageUvTriangle = { indices: vertexIndices, points };
    const minU = Math.max(0, Math.min(...points.map((point) => point[0])));
    const maxU = Math.min(1, Math.max(...points.map((point) => point[0])));
    const minV = Math.max(0, Math.min(...points.map((point) => point[1])));
    const maxV = Math.min(1, Math.max(...points.map((point) => point[1])));
    const minX = Math.floor(minU * (cells - 1));
    const maxX = Math.floor(maxU * (cells - 1));
    const minY = Math.floor(minV * (cells - 1));
    const maxY = Math.floor(maxV * (cells - 1));
    const candidates = new Set<SalvageUvTriangle>();
    for (let x = minX; x <= maxX; x += 1) {
      for (let y = minY; y <= maxY; y += 1) {
        for (const candidate of grid.get(`${String(x)}:${String(y)}`) ?? []) {
          candidates.add(candidate);
        }
      }
    }
    const overlaps = [...candidates].some((candidate) => {
      const shared = triangle.indices.filter((index) => candidate.indices.includes(index)).length;
      return shared < 2 && uvOverlapArea(triangle.points, candidate.points) > 1e-8;
    });
    if (overlaps) {
      findings.push(offset / 3);
    }
    for (let x = minX; x <= maxX; x += 1) {
      for (let y = minY; y <= maxY; y += 1) {
        const key = `${String(x)}:${String(y)}`;
        const bucket = grid.get(key) ?? [];
        bucket.push(triangle);
        grid.set(key, bucket);
      }
    }
  }
  return findings;
}

function repairLiveryUvFindings(
  document: Document,
  buffer: ReturnType<Document['createBuffer']>,
  primitive: ReturnType<Document['createPrimitive']>,
  surfaceClass: A320neoSurfaceClass,
): { readonly degenerateUvFaces: number; readonly overlappingUvFaces: number } {
  const degenerate = findDegenerateLiveryTriangles(
    primitive,
    LIVERY_UV_PRECOMPRESSION_AREA_EPSILON,
  );
  const overlapping = findOverlappingLiveryTriangles(primitive);
  const triangleIndices = [...new Set([...degenerate, ...overlapping])].sort(
    (left, right) => left - right,
  );
  if (triangleIndices.length === 0) {
    return { degenerateUvFaces: 0, overlappingUvFaces: 0 };
  }

  const indices = primitive.getIndices();
  const indexArray = indices?.getArray();
  const position = primitive.getAttribute('POSITION');
  const uv = primitive.getAttribute('TEXCOORD_1');
  const uvArray = uv?.getArray();
  if (!indices || !indexArray || !position || !uv || !(uvArray instanceof Float32Array)) {
    throw new Error(`${surfaceClass} cannot repair incomplete livery UV geometry`);
  }

  const sourceVertexCount = position.getCount();
  const repairVertexCount = triangleIndices.length * 3;
  const targetVertexCount = sourceVertexCount + repairVertexCount + 2;
  const targetIndices = new Uint32Array(indexArray);
  const repairedAttributes = new Map<string, Float32Array>();
  for (const semantic of ['POSITION', 'NORMAL', 'TEXCOORD_0', 'TEXCOORD_1'] as const) {
    const source = primitive.getAttribute(semantic);
    const sourceArray = source?.getArray();
    if (!source || !(sourceArray instanceof Float32Array)) {
      throw new Error(`${surfaceClass}.${semantic} cannot be duplicated for UV repair`);
    }
    const elementSize = source.getElementSize();
    const target = new Float32Array(targetVertexCount * elementSize);
    target.set(sourceArray);
    for (const [repairIndex, triangleIndex] of triangleIndices.entries()) {
      for (let corner = 0; corner < 3; corner += 1) {
        const sourceVertex = indexArray[triangleIndex * 3 + corner]!;
        const targetVertex = sourceVertexCount + repairIndex * 3 + corner;
        for (let component = 0; component < elementSize; component += 1) {
          target[targetVertex * elementSize + component] =
            sourceArray[sourceVertex * elementSize + component]!;
        }
        targetIndices[triangleIndex * 3 + corner] = targetVertex;
      }
    }
    for (let sentinel = 0; sentinel < 2; sentinel += 1) {
      const targetVertex = sourceVertexCount + repairVertexCount + sentinel;
      for (let component = 0; component < elementSize; component += 1) {
        target[targetVertex * elementSize + component] = sourceArray[component]!;
      }
    }
    repairedAttributes.set(semantic, target);
  }

  const repairedUv = repairedAttributes.get('TEXCOORD_1')!;
  let minU = Number.POSITIVE_INFINITY;
  let minV = Number.POSITIVE_INFINITY;
  let maxU = Number.NEGATIVE_INFINITY;
  let maxV = Number.NEGATIVE_INFINITY;
  for (let vertex = 0; vertex < sourceVertexCount; vertex += 1) {
    minU = Math.min(minU, repairedUv[vertex * 2]!);
    minV = Math.min(minV, repairedUv[vertex * 2 + 1]!);
    maxU = Math.max(maxU, repairedUv[vertex * 2]!);
    maxV = Math.max(maxV, repairedUv[vertex * 2 + 1]!);
  }
  const width = maxU - minU;
  const height = maxV - minV;
  const repairFraction = 0.1;
  const paintMaxU = minU + width * (1 - repairFraction);
  for (let vertex = 0; vertex < sourceVertexCount; vertex += 1) {
    repairedUv[vertex * 2] = minU + ((repairedUv[vertex * 2]! - minU) / width) * (paintMaxU - minU);
  }

  const repairMinU = minU + width * (1 - repairFraction * 0.9);
  const repairWidth = maxU - repairMinU;
  const columns = Math.max(
    1,
    Math.ceil(Math.sqrt((triangleIndices.length * repairWidth) / height)),
  );
  const rows = Math.ceil(triangleIndices.length / columns);
  const cellWidth = repairWidth / columns;
  const cellHeight = height / rows;
  for (const [repairIndex] of triangleIndices.entries()) {
    const column = repairIndex % columns;
    const row = Math.floor(repairIndex / columns);
    const left = repairMinU + column * cellWidth;
    const top = minV + row * cellHeight;
    const points = [
      [left + cellWidth * 0.2, top + cellHeight * 0.2],
      [left + cellWidth * 0.8, top + cellHeight * 0.2],
      [left + cellWidth * 0.5, top + cellHeight * 0.8],
    ] as const;
    for (let corner = 0; corner < 3; corner += 1) {
      const targetVertex = sourceVertexCount + repairIndex * 3 + corner;
      repairedUv[targetVertex * 2] = points[corner]![0];
      repairedUv[targetVertex * 2 + 1] = points[corner]![1];
    }
  }
  const minSentinel = sourceVertexCount + repairVertexCount;
  const maxSentinel = minSentinel + 1;
  repairedUv[minSentinel * 2] = minU;
  repairedUv[minSentinel * 2 + 1] = minV;
  repairedUv[maxSentinel * 2] = maxU;
  repairedUv[maxSentinel * 2 + 1] = maxV;

  for (const semantic of ['POSITION', 'NORMAL', 'TEXCOORD_0', 'TEXCOORD_1'] as const) {
    const source = primitive.getAttribute(semantic)!;
    primitive.setAttribute(
      semantic,
      document
        .createAccessor(`${source.getName()}-uv-repaired`)
        .setType(source.getType())
        .setArray(new Float32Array(repairedAttributes.get(semantic)!))
        .setBuffer(buffer),
    );
    source.dispose();
  }
  primitive.setIndices(
    document
      .createAccessor(`${indices.getName()}-uv-repaired`)
      .setType('SCALAR')
      .setArray(targetIndices)
      .setBuffer(buffer),
  );
  indices.dispose();

  const remainingDegenerate = findDegenerateLiveryTriangles(primitive).length;
  const remainingOverlapping = findOverlappingLiveryTriangles(primitive).length;
  if (remainingDegenerate > 0 || remainingOverlapping > 0) {
    throw new Error(
      `${surfaceClass} livery UV repair left ${String(remainingDegenerate)} degenerate and ${String(remainingOverlapping)} overlapping triangles`,
    );
  }
  return {
    degenerateUvFaces: degenerate.length,
    overlappingUvFaces: overlapping.length,
  };
}

function addPrimitiveTangents(
  document: Document,
  buffer: ReturnType<Document['createBuffer']>,
  level: number,
  surfaceClass: A320neoSurfaceClass,
  primitive: ReturnType<Document['createPrimitive']>,
): void {
  const compactNormals = primitive.getAttribute('NORMAL')!.getArray()!;
  const tangentArray = new Float32Array((compactNormals.length / 3) * 4);
  for (let vertex = 0; vertex < compactNormals.length / 3; vertex += 1) {
    const nx = compactNormals[vertex * 3]!;
    const ny = compactNormals[vertex * 3 + 1]!;
    const nz = compactNormals[vertex * 3 + 2]!;
    const useUp = Math.abs(ny) < 0.999;
    const referenceX = useUp ? 0 : 1;
    const referenceY = useUp ? 1 : 0;
    const tx = referenceY * nz;
    const ty = -referenceX * nz;
    const tz = referenceX * ny - referenceY * nx;
    const tangentLength = Math.hypot(tx, ty, tz) || 1;
    tangentArray[vertex * 4] = tx / tangentLength;
    tangentArray[vertex * 4 + 1] = ty / tangentLength;
    tangentArray[vertex * 4 + 2] = tz / tangentLength;
    tangentArray[vertex * 4 + 3] = 1;
  }
  primitive.setAttribute(
    'TANGENT',
    document
      .createAccessor(`lod${String(level)}-${surfaceClass}-tangents`)
      .setType('VEC4')
      .setArray(tangentArray)
      .setBuffer(buffer),
  );
}

async function createLod0Mesh(
  document: Document,
  buffer: ReturnType<Document['createBuffer']>,
  geometry: Pick<SourceGeometry, 'positions' | 'normals' | 'uv0'>,
  classified: ClassificationResult,
  materials: ReadonlyMap<A320neoSurfaceClass, Material>,
  cleanupStats: UvCleanupStats,
): Promise<ReturnType<Document['createMesh']>> {
  const positions = document
    .createAccessor('lod0-positions')
    .setType('VEC3')
    .setArray(new Float32Array(geometry.positions))
    .setBuffer(buffer);
  const normals = document
    .createAccessor('lod0-normals')
    .setType('VEC3')
    .setArray(new Float32Array(geometry.normals))
    .setBuffer(buffer);
  const uv0 = document
    .createAccessor('lod0-uv0')
    .setType('VEC2')
    .setArray(new Float32Array(geometry.uv0))
    .setBuffer(buffer);
  const mesh = document.createMesh('mesh-lod0');
  for (const surfaceClass of A320NEO_SURFACE_CLASSES) {
    const indices = document
      .createAccessor(`lod0-${surfaceClass}-indices`)
      .setType('SCALAR')
      .setArray(new Uint32Array(classified.indices[surfaceClass]))
      .setBuffer(buffer);
    const primitive = document
      .createPrimitive()
      .setIndices(indices)
      .setAttribute('POSITION', positions)
      .setAttribute('NORMAL', normals)
      .setAttribute('TEXCOORD_0', uv0)
      .setMaterial(materials.get(surfaceClass)!);
    simplifySemanticPrimitive(primitive, buffer, LOD_RATIOS[0], true);
    mesh.addPrimitive(primitive);
  }
  await watlas.Initialize();
  for (const primitive of mesh.listPrimitives()) {
    const surfaceClass = SURFACE_CLASS_BY_MATERIAL.get(primitive.getMaterial()?.getName() ?? '');
    if (!surfaceClass) throw new Error('LOD0 primitive has no semantic surface class');
    if (PAINTABLE_CLASSES.has(surfaceClass)) {
      recordUvCleanup(
        cleanupStats,
        0,
        surfaceClass,
        'duplicateFaces',
        removeDuplicateIndexTriangles(primitive),
      );
      unwrapPrimitiveWithPadding(document, buffer, primitive, surfaceClass);
      rescaleLiveryUv(primitive, surfaceClass);
      const repaired = repairLiveryUvFindings(document, buffer, primitive, surfaceClass);
      recordUvCleanup(
        cleanupStats,
        0,
        surfaceClass,
        'degenerateUvFaces',
        repaired.degenerateUvFaces,
      );
      recordUvCleanup(
        cleanupStats,
        0,
        surfaceClass,
        'overlappingUvFaces',
        repaired.overlappingUvFaces,
      );
    }
    addPrimitiveTangents(document, buffer, 0, surfaceClass, primitive);
  }
  return mesh;
}

function createDerivedLodMesh(
  document: Document,
  buffer: ReturnType<Document['createBuffer']>,
  level: 1 | 2,
  ratio: number,
  sourceMesh: ReturnType<Document['createMesh']>,
  cleanupStats: UvCleanupStats,
): ReturnType<Document['createMesh']> {
  const mesh = document.createMesh(`mesh-lod${String(level)}`);
  for (const sourcePrimitive of sourceMesh.listPrimitives()) {
    const surfaceClass = SURFACE_CLASS_BY_MATERIAL.get(
      sourcePrimitive.getMaterial()?.getName() ?? '',
    );
    if (!surfaceClass) throw new Error(`LOD${String(level)} primitive has no surface class`);
    const primitive = document.createPrimitive().setMaterial(sourcePrimitive.getMaterial());
    const sourceIndices = sourcePrimitive.getIndices()?.getArray();
    if (!sourceIndices) throw new Error(`LOD0 ${surfaceClass} is not indexed`);
    primitive.setIndices(
      document
        .createAccessor(`lod${String(level)}-${surfaceClass}-indices`)
        .setType('SCALAR')
        .setArray(new Uint32Array(sourceIndices))
        .setBuffer(buffer),
    );
    for (const semantic of ['POSITION', 'NORMAL', 'TEXCOORD_0', 'TEXCOORD_1'] as const) {
      const source = sourcePrimitive.getAttribute(semantic);
      if (!source) continue;
      primitive.setAttribute(
        semantic,
        document
          .createAccessor(`lod${String(level)}-${surfaceClass}-${semantic.toLowerCase()}`)
          .setType(source.getType())
          .setArray(new Float32Array(source.getArray()!))
          .setBuffer(buffer),
      );
    }
    simplifySemanticPrimitive(primitive, buffer, ratio, false);
    rescaleLiveryUv(primitive, surfaceClass);
    const repaired = repairLiveryUvFindings(document, buffer, primitive, surfaceClass);
    recordUvCleanup(
      cleanupStats,
      level,
      surfaceClass,
      'degenerateUvFaces',
      repaired.degenerateUvFaces,
    );
    recordUvCleanup(
      cleanupStats,
      level,
      surfaceClass,
      'overlappingUvFaces',
      repaired.overlappingUvFaces,
    );
    addPrimitiveTangents(document, buffer, level, surfaceClass, primitive);
    mesh.addPrimitive(primitive);
  }
  return mesh;
}

function addNamedNode(
  document: Document,
  root: ReturnType<Document['createNode']>,
  name: string,
  translation: readonly [number, number, number],
): void {
  root.addChild(document.createNode(name).setTranslation([...translation]));
}

function addAnchors(document: Document, root: ReturnType<Document['createNode']>): void {
  const anchors: Record<
    (typeof AircraftAnchorId.options)[number],
    readonly [number, number, number]
  > = {
    camera_three_quarter: [28, 17, -30],
    camera_side: [32, 7, 0],
    camera_top: [0, 38, 0],
    rotation_center: [0, 5.4, 0],
    ground_contact: [0, 0, 0],
    registration_port: [-2.1, 6.2, 10.8],
    registration_starboard: [2.1, 6.2, 10.8],
    tail_logo_port: [-0.3, 8.9, 14.1],
    tail_logo_starboard: [0.3, 8.9, 14.1],
  };
  for (const id of AircraftAnchorId.options) {
    addNamedNode(document, root, `anchor-${id.replaceAll('_', '-')}`, anchors[id]);
  }
  const lights: Record<
    (typeof AircraftLightSocketId.options)[number],
    readonly [number, number, number]
  > = {
    navigation_port: [-17.8, 4.7, 0.4],
    navigation_starboard: [17.8, 4.7, 0.4],
    beacon_upper: [0, 11.7, 2],
    beacon_lower: [0, 2.6, 2],
    landing_port: [-6.2, 4.1, -1.2],
    landing_starboard: [6.2, 4.1, -1.2],
  };
  for (const id of AircraftLightSocketId.options) {
    addNamedNode(document, root, `light-${id.replaceAll('_', '-')}`, lights[id]);
  }
}

function triangleCount(mesh: ReturnType<Document['createMesh']>): number {
  return mesh
    .listPrimitives()
    .reduce((sum, primitive) => sum + Math.floor((primitive.getIndices()?.getCount() ?? 0) / 3), 0);
}

function materialTriangles(mesh: ReturnType<Document['createMesh']>): Record<string, number> {
  return Object.fromEntries(
    mesh
      .listPrimitives()
      .map((primitive) => [
        primitive.getMaterial()?.getName() ?? 'unbound',
        Math.floor((primitive.getIndices()?.getCount() ?? 0) / 3),
      ]),
  );
}

type PreviewView = 'side' | 'top' | 'front';

function projectPoint(point: readonly [number, number, number], view: PreviewView) {
  if (view === 'side') return { x: -point[2], y: -point[1], depth: point[0] };
  if (view === 'top') return { x: -point[2], y: point[0], depth: point[1] };
  return { x: point[0], y: -point[1], depth: -point[2] };
}

function colourChannels(hex: string): readonly [number, number, number] {
  return [
    Number.parseInt(hex.slice(1, 3), 16),
    Number.parseInt(hex.slice(3, 5), 16),
    Number.parseInt(hex.slice(5, 7), 16),
  ];
}

function previewOverlaySvg(): string {
  const labels = (['side', 'top', 'front'] as const)
    .map((view, panelIndex) => {
      const panelX = 20 + panelIndex * 540;
      return [
        `<rect x="${String(panelX)}" y="58" width="520" height="300" rx="8" fill="none" stroke="#29425b"/>`,
        `<text x="${String(panelX + 12)}" y="42" class="label">${view.toUpperCase()}</text>`,
      ].join('');
    })
    .join('');
  const legend = A320NEO_SURFACE_CLASSES.map(
    (surfaceClass, index) =>
      `<g transform="translate(${String(22 + (index % 6) * 260)} ${String(394 + Math.floor(index / 6) * 28)})"><rect width="14" height="14" rx="2" fill="${SURFACE_COLOURS[surfaceClass]}"/><text x="22" y="12" class="legend">${surfaceClass.replaceAll('_', ' ')}</text></g>`,
  ).join('');
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="1640" height="460" viewBox="0 0 1640 460">`,
    `<style>.label{font:600 18px ui-monospace,monospace;fill:#b8cce0}.legend{font:13px ui-monospace,monospace;fill:#cbd8e5}</style>`,
    labels,
    legend,
    `</svg>`,
  ].join('');
}

async function previewPng(document: Document): Promise<Buffer> {
  const lod0 = document
    .getRoot()
    .listNodes()
    .find((node) => node.getName() === 'lod0');
  if (!lod0?.getMesh()) throw new Error('Cannot preview salvaged asset without LOD0');
  const canvasWidth = 1_640;
  const canvasHeight = 460;
  const canvas = Buffer.alloc(canvasWidth * canvasHeight * 3);
  for (let offset = 0; offset < canvas.length; offset += 3) {
    canvas[offset] = 7;
    canvas[offset + 1] = 12;
    canvas[offset + 2] = 18;
  }
  const panels = (['side', 'top', 'front'] as const).map((view, panelIndex) => ({
    view,
    x: 20 + panelIndex * 540,
    y: 58,
    width: 520,
    height: 300,
    scale: view === 'top' ? 7.4 : 12,
    z: new Float32Array(520 * 300).fill(Number.NEGATIVE_INFINITY),
  }));
  for (const panel of panels) {
    for (let y = panel.y; y < panel.y + panel.height; y += 1) {
      for (let x = panel.x; x < panel.x + panel.width; x += 1) {
        const offset = (y * canvasWidth + x) * 3;
        canvas[offset] = 9;
        canvas[offset + 1] = 15;
        canvas[offset + 2] = 23;
      }
    }
  }
  for (const panel of panels) {
    for (const primitive of lod0.getMesh()!.listPrimitives()) {
      const positions = primitive.getAttribute('POSITION')!;
      const indices = primitive.getIndices()!;
      const triangles = Math.floor(indices.getCount() / 3);
      const colour = colourChannels(
        SURFACE_COLOURS[
          A320NEO_SURFACE_CLASSES.find(
            (surfaceClass) => MATERIAL_NAMES[surfaceClass] === primitive.getMaterial()?.getName(),
          ) ?? 'fuselage'
        ],
      );
      for (let triangle = 0; triangle < triangles; triangle += 1) {
        const projected: { x: number; y: number; depth: number }[] = [];
        for (let corner = 0; corner < 3; corner += 1) {
          const vertex = indices.getScalar(triangle * 3 + corner);
          const source: [number, number, number] = [0, 0, 0];
          positions.getElement(vertex, source);
          const point = projectPoint(source, panel.view);
          projected.push({
            x: panel.x + panel.width / 2 + point.x * panel.scale,
            y: panel.y + panel.height / 2 + point.y * panel.scale,
            depth: point.depth,
          });
        }
        const [a, b, c] = projected as [
          { x: number; y: number; depth: number },
          { x: number; y: number; depth: number },
          { x: number; y: number; depth: number },
        ];
        const area = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
        if (Math.abs(area) < 0.000_001) continue;
        const minX = Math.max(panel.x, Math.floor(Math.min(a.x, b.x, c.x)));
        const maxX = Math.min(panel.x + panel.width - 1, Math.ceil(Math.max(a.x, b.x, c.x)));
        const minY = Math.max(panel.y, Math.floor(Math.min(a.y, b.y, c.y)));
        const maxY = Math.min(panel.y + panel.height - 1, Math.ceil(Math.max(a.y, b.y, c.y)));
        for (let y = minY; y <= maxY; y += 1) {
          for (let x = minX; x <= maxX; x += 1) {
            const px = x + 0.5;
            const py = y + 0.5;
            const weightA = ((b.x - px) * (c.y - py) - (b.y - py) * (c.x - px)) / area;
            const weightB = ((c.x - px) * (a.y - py) - (c.y - py) * (a.x - px)) / area;
            const weightC = 1 - weightA - weightB;
            if (weightA < -0.000_1 || weightB < -0.000_1 || weightC < -0.000_1) continue;
            const depth = weightA * a.depth + weightB * b.depth + weightC * c.depth;
            const panelOffset = (y - panel.y) * panel.width + (x - panel.x);
            if (depth <= panel.z[panelOffset]!) continue;
            panel.z[panelOffset] = depth;
            const canvasOffset = (y * canvasWidth + x) * 3;
            canvas[canvasOffset] = colour[0];
            canvas[canvasOffset + 1] = colour[1];
            canvas[canvasOffset + 2] = colour[2];
          }
        }
      }
    }
  }
  return sharp(canvas, { raw: { width: canvasWidth, height: canvasHeight, channels: 3 } })
    .composite([{ input: Buffer.from(previewOverlaySvg()) }])
    .png()
    .toBuffer();
}

function previewSvg(): string {
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1640 460" role="img" aria-labelledby="title desc">`,
    `<title id="title">A320neo salvage semantic preview</title>`,
    `<desc id="desc">Side, top and front projections coloured by inferred livery material class.</desc>`,
    `<image href="salvage-preview.png" width="1640" height="460"/>`,
    `</svg>\n`,
  ].join('');
}

async function loadSource(
  path: string,
): Promise<{ readonly bytes: Buffer; readonly geometry: SourceGeometry }> {
  const bytes = await readFile(path);
  const document = await new NodeIO().readBinary(bytes);
  const root = document.getRoot();
  if (root.listMeshes().length !== 1 || root.listMeshes()[0]!.listPrimitives().length !== 1) {
    throw new Error('A320neo salvage v1 expects the one-mesh, one-primitive Hi3D export');
  }
  const primitive = root.listMeshes()[0]!.listPrimitives()[0]!;
  const positions = primitive.getAttribute('POSITION')?.getArray();
  const normals = primitive.getAttribute('NORMAL')?.getArray();
  const uv0 = primitive.getAttribute('TEXCOORD_0')?.getArray();
  const indices = primitive.getIndices()?.getArray();
  const baseColourBytes = primitive.getMaterial()?.getBaseColorTexture()?.getImage();
  const metallicRoughnessBytes = primitive.getMaterial()?.getMetallicRoughnessTexture()?.getImage();
  if (
    !(positions instanceof Float32Array) ||
    !(normals instanceof Float32Array) ||
    !(uv0 instanceof Float32Array) ||
    !indices ||
    !baseColourBytes ||
    !metallicRoughnessBytes
  ) {
    throw new Error('Hi3D source is missing indexed POSITION/NORMAL/TEXCOORD_0 or PBR textures');
  }
  return {
    bytes,
    geometry: {
      positions,
      normals,
      uv0,
      indices: new Uint32Array(indices),
      baseColourBytes,
      metallicRoughnessBytes,
    },
  };
}

function manifestTechnical(
  sourceSha256: string,
  sourceByteSize: number,
  lodTriangles: readonly [number, number, number],
): AircraftAssetTechnicalManifestValue {
  const coverage = AIRCRAFT_ASSET_COVERAGE_V1.find((row) => row.designation === 'A320neo');
  if (!coverage) throw new Error('Pinned catalogue has no A320neo coverage row');
  const anchorBindings = AircraftAnchorId.options.map((id) => ({
    id,
    nodeName: `anchor-${id.replaceAll('_', '-')}`,
  }));
  const lightBindings = AircraftLightSocketId.options.map((id) => ({
    id,
    nodeName: `light-${id.replaceAll('_', '-')}`,
  }));
  const nodeNames = [
    'aircraft-root',
    'lod0',
    'lod1',
    'lod2',
    ...anchorBindings.map((binding) => binding.nodeName),
    ...lightBindings.map((binding) => binding.nodeName),
  ];
  return AircraftAssetTechnicalManifest.parse({
    identity: {
      assetId: 'a320neo',
      assetVersion: '1.0.0',
      catalogueVersion: coverage.catalogueVersion,
      family: coverage.family,
      geometryVariantId: coverage.geometryVariantId,
      designations: ['A320neo'],
    },
    delivery: {
      filePath: 'aircraft.glb',
      mimeType: 'model/gltf-binary',
      gltfVersion: '2.0',
      byteSize: sourceByteSize,
      fileSha256: sourceSha256,
      units: 'metres',
      upAxis: '+Y',
      forwardAxis: '-Z',
      origin: 'ground-centre',
      transformsBaked: true,
    },
    naming: {
      convention: 'tailfin-aircraft-v1',
      rootNode: 'aircraft-root',
      nodeNames,
      meshNames: ['mesh-lod0', 'mesh-lod1', 'mesh-lod2'],
    },
    liveryUv: {
      resource: { id: 'a320neo-livery-uv', version: '1.0.0' },
      texCoord: 'TEXCOORD_1',
      normalized: true,
      nonOverlappingPaintableIslands: true,
      paddingPxAt4096: LIVERY_UV_PADDING_PX,
      mirroredIslands: [],
    },
    bindingResources: {
      materialBinding: { id: 'a320neo-materials', version: '1.0.0' },
      anchorSet: { id: 'a320neo-anchors', version: '1.0.0' },
    },
    materials: A320NEO_SURFACE_CLASSES.map((surfaceClass) =>
      PAINTABLE_CLASSES.has(surfaceClass)
        ? { materialName: MATERIAL_NAMES[surfaceClass], kind: 'paintable', class: surfaceClass }
        : { materialName: MATERIAL_NAMES[surfaceClass], kind: 'protected', class: surfaceClass },
    ),
    pbrTextures: [
      {
        kind: 'base_color',
        uri: 'base-color.jpg',
        mimeType: 'image/jpeg',
        width: TEXTURE_SIZE,
        height: TEXTURE_SIZE,
        colorSpace: 'srgb',
        channelPacking: 'rgba',
      },
      {
        kind: 'normal',
        uri: 'normal.png',
        mimeType: 'image/png',
        width: 1,
        height: 1,
        colorSpace: 'linear',
        channelPacking: 'normal_xy',
      },
      {
        kind: 'metallic_roughness',
        uri: 'metallic-roughness.jpg',
        mimeType: 'image/jpeg',
        width: TEXTURE_SIZE,
        height: TEXTURE_SIZE,
        colorSpace: 'linear',
        channelPacking: 'gltf_metallic_roughness',
      },
    ],
    anchors: anchorBindings,
    lightSockets: lightBindings,
    gearState: 'retracted',
    lods: lodTriangles.map((triangleCountValue, level) => ({
      level,
      nodeName: `lod${String(level)}`,
      triangleCount: triangleCountValue,
    })),
    fallback: { kind: 'fleet_render', assetId: 'a320neo' },
    budget: {
      profile: 'narrowbody',
      drawCalls: A320NEO_SURFACE_CLASSES.length,
      materialCount: A320NEO_SURFACE_CLASSES.length,
      textureMemoryBytes: CONSERVATIVE_TEXTURE_MEMORY_BYTES,
      boundsM: TARGET_DIMENSIONS_M,
    },
    featureTags: ['underwing-turbofans', 'sharklets', 'narrowbody-doors', 'salvaged-hi3d'],
    contentAudit: {
      neutralBaseCoat: true,
      realWorldAirlineLivery: false,
      trademarkedLogos: [],
      unlicensedLogos: [],
      reviewedBy: 'Tailfin deterministic salvage pipeline; human visual review pending',
      reviewedAt: '2026-08-25',
    },
  });
}

export async function salvageA320neo(
  options: SalvageA320neoOptions,
): Promise<SalvageA320neoResult> {
  const loaded = await loadSource(options.inputPath);
  const classified = await classifyGeometry(loaded.geometry);
  const geometry = normalizedGeometry(loaded.geometry);
  const textureBytes = await resizedTextures(loaded.geometry);
  const document = new Document();
  const buffer = document.createBuffer('aircraft-buffer');
  const base = document
    .createTexture('tex-base-color')
    .setImage(textureBytes.baseColour)
    .setMimeType('image/jpeg');
  const normal = document
    .createTexture('tex-normal')
    .setImage(textureBytes.normal)
    .setMimeType('image/png');
  const metallicRoughness = document
    .createTexture('tex-metallic-roughness')
    .setImage(textureBytes.metallicRoughness)
    .setMimeType('image/jpeg');
  const materials = new Map(
    A320NEO_SURFACE_CLASSES.map((surfaceClass) => [
      surfaceClass,
      makeMaterial(document, surfaceClass, { base, normal, metallicRoughness }),
    ]),
  );
  const scene = document.createScene('aircraft-scene');
  document.getRoot().setDefaultScene(scene);
  const root = document.createNode('aircraft-root');
  scene.addChild(root);
  await MeshoptSimplifier.ready;
  const uvCleanupStats: UvCleanupStats = {};
  const lod0 = await createLod0Mesh(
    document,
    buffer,
    geometry,
    classified,
    materials,
    uvCleanupStats,
  );
  const meshes = [
    lod0,
    createDerivedLodMesh(document, buffer, 1, LOD_RATIOS[1] / LOD_RATIOS[0], lod0, uvCleanupStats),
    createDerivedLodMesh(document, buffer, 2, LOD_RATIOS[2] / LOD_RATIOS[0], lod0, uvCleanupStats),
  ] as const;
  for (const [level, mesh] of meshes.entries()) {
    root.addChild(document.createNode(`lod${String(level)}`).setMesh(mesh));
  }
  addAnchors(document, root);

  const outputBytes = await new NodeIO().writeBinary(document);
  const lodBytes = await Promise.all([
    stagedLodBinary(document, 0),
    stagedLodBinary(document, 1),
    stagedLodBinary(document, 2),
  ]);
  const outputSha256 = sha256(outputBytes);
  const lodTriangles = meshes.map((mesh) => triangleCount(mesh)) as unknown as [
    number,
    number,
    number,
  ];
  const bounds = getBounds(
    document
      .getRoot()
      .listNodes()
      .find((node) => node.getName() === 'lod0')!,
  );
  const technical = manifestTechnical(outputSha256, outputBytes.byteLength, lodTriangles);
  const manifestDraft = {
    format: AIRCRAFT_ASSET_MANIFEST_FORMAT,
    formatVersion: AIRCRAFT_ASSET_MANIFEST_VERSION,
    technical: {
      ...technical,
      contentAudit: { ...technical.contentAudit, reviewedAt: options.reviewedAt },
    },
    licence: null,
    candidateStatus: 'blocked_pending_proof_of_purchase_and_terms_evidence',
  };
  const decision = AircraftOptimisationDecision.parse({
    format: AIRCRAFT_OPTIMISATION_DECISION_FORMAT,
    formatVersion: AIRCRAFT_OPTIMISATION_DECISION_VERSION,
    sourceFileSha256: outputSha256,
    rendererCompatibilityVersion: 'm6-13-v1',
    geometry: {
      mode: 'lossless',
      evidence: {
        pilotAssets: ['a320neo/1.0.0'],
        sourceBytes: outputBytes.byteLength,
        runtimeBytes: outputBytes.byteLength,
        gpuUploadMsP95: 0,
        visualReview: 'Deterministic salvage retains the supplied silhouette and semantic atlas.',
        measuredBy: 'Tailfin deterministic salvage pipeline',
        measuredAt: options.reviewedAt,
      },
    },
    textures: {
      mode: 'retain',
      evidence: {
        pilotAssets: ['a320neo/1.0.0'],
        sourceBytes: outputBytes.byteLength,
        runtimeBytes: outputBytes.byteLength,
        gpuUploadMsP95: 0,
        visualReview: 'Four-kilopixel PBR inputs retain the supplied UV atlas for pilot review.',
        measuredBy: 'Tailfin deterministic salvage pipeline',
        measuredAt: options.reviewedAt,
      },
    },
    allow: { animations: [], cameras: [], lights: [], metadataOwners: [] },
    budgetException: null,
  });
  const validation = await inspectTechnicalGlbCandidate(
    outputBytes,
    technical,
    decision,
    options.reviewedAt,
  );
  const validatorReport = validation.officialReport;
  const preview = await previewPng(document);
  const report = {
    format: 'tailfin-a320neo-salvage-report',
    formatVersion: 1,
    salvageVersion: A320NEO_SALVAGE_VERSION,
    original: {
      fileName: 'A320neo.glb',
      sha256: hash(loaded.bytes),
      byteSize: loaded.bytes.byteLength,
      triangles: loaded.geometry.indices.length / 3,
      componentCount: classified.componentCount,
    },
    derived: {
      sha256: outputSha256,
      byteSize: outputBytes.byteLength,
      bounds,
      targetDimensionsM: TARGET_DIMENSIONS_M,
      lodTriangles,
      stagedLods: lodBytes.map((bytes, level) => ({
        level,
        sha256: sha256(bytes),
        byteSize: bytes.byteLength,
      })),
      materialTriangles: meshes.map((mesh) => materialTriangles(mesh)),
      textureBytes: {
        baseColour: textureBytes.baseColour.byteLength,
        normal: textureBytes.normal.byteLength,
        metallicRoughness: textureBytes.metallicRoughness.byteLength,
      },
    },
    classification: {
      sourceTriangles: classified.sourceTriangles,
      fallbackAssignments: classified.fallbackAssignments,
      method:
        'connected-component spatial rules plus base-colour atlas sampling; protected groups require human preview review',
    },
    liveryUvCleanup: uvCleanupStats,
    validation: {
      validator: validatorReport.validatorVersion,
      errors: validatorReport.issues.numErrors,
      warnings: validatorReport.issues.numWarnings,
      infos: validatorReport.issues.numInfos,
      hints: validatorReport.issues.numHints,
    },
    blockers: [
      'Attach proof of Pro-plan acquisition for this generation.',
      'Attach the applicable licence text and vendor-terms snapshot.',
      'Confirm source-image rights and approve the semantic preview before intake.',
    ],
  };

  await mkdir(options.outputDirectory, { recursive: true });
  const sourcePath = resolve(options.outputDirectory, 'aircraft.glb');
  const lodPaths = [0, 1, 2].map((level) =>
    resolve(options.outputDirectory, `aircraft-lod${String(level)}.glb`),
  ) as [string, string, string];
  const manifestDraftPath = resolve(options.outputDirectory, 'manifest.draft.json');
  const decisionPath = resolve(options.outputDirectory, 'optimisation.json');
  const reportPath = resolve(options.outputDirectory, 'salvage-report.json');
  const previewPath = resolve(options.outputDirectory, 'salvage-preview.png');
  const previewSvgPath = resolve(options.outputDirectory, 'salvage-preview.svg');
  await Promise.all([
    writeFile(sourcePath, outputBytes),
    ...lodPaths.map((path, level) => writeFile(path, lodBytes[level]!)),
    writeFile(resolve(options.outputDirectory, 'base-color.jpg'), textureBytes.baseColour),
    writeFile(resolve(options.outputDirectory, 'normal.png'), textureBytes.normal),
    writeFile(
      resolve(options.outputDirectory, 'metallic-roughness.jpg'),
      textureBytes.metallicRoughness,
    ),
    writeFile(manifestDraftPath, canonicalJson(manifestDraft)),
    writeFile(decisionPath, canonicalJson(decision)),
    writeFile(reportPath, canonicalJson(report)),
    writeFile(previewPath, preview),
    writeFile(previewSvgPath, previewSvg()),
  ]);
  return {
    sourcePath,
    lodPaths,
    manifestDraftPath,
    decisionPath,
    reportPath,
    previewPath,
    sourceSha256: outputSha256,
    sourceByteSize: outputBytes.byteLength,
    lodTriangles,
  };
}
