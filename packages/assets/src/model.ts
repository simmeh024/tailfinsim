import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';

import {
  NodeIO,
  Primitive,
  PropertyType,
  VERSION as GLTF_TRANSFORM_VERSION,
  type Document,
  type Material,
  type Node,
  type Primitive as GltfPrimitive,
  type Texture,
} from '@gltf-transform/core';
import { ALL_EXTENSIONS, EXTMeshoptCompression } from '@gltf-transform/extensions';
import {
  dedup,
  cloneDocument,
  getBounds,
  getNodeVertexCount,
  prune,
  reorder,
  VertexCountMethod,
  weld,
} from '@gltf-transform/functions';
import { validateBytes, version as validatorVersion, type ValidatorReport } from 'gltf-validator';
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';

import {
  AIRCRAFT_ASSET_BUDGETS,
  AircraftAssetManifest,
  type AircraftAssetBudgetException,
  type AircraftAssetBudgetProfile,
  type AircraftAssetManifest as AircraftAssetManifestValue,
  type AircraftRuntimeStats,
} from '@tailfin/shared';

import { canonicalJson, sha256 } from './canonical';
import {
  AssetPipelineError,
  type AircraftOptimisationDecision,
  type AssetPipelineIssue,
} from './schema';

export const AIRCRAFT_ASSET_TOOL_VERSIONS = {
  gltfTransform: GLTF_TRANSFORM_VERSION,
  gltfValidator: validatorVersion(),
  meshoptimizer: '1.2.0',
} as const;

interface GlbJson {
  readonly asset?: { readonly extras?: unknown };
  readonly buffers?: readonly { readonly uri?: string }[];
  readonly images?: readonly { readonly uri?: string }[];
  readonly nodes?: readonly { readonly name?: string; readonly extras?: unknown }[];
  readonly meshes?: readonly { readonly name?: string; readonly extras?: unknown }[];
  readonly materials?: readonly { readonly name?: string; readonly extras?: unknown }[];
  readonly cameras?: readonly { readonly name?: string; readonly extras?: unknown }[];
  readonly animations?: readonly { readonly name?: string; readonly extras?: unknown }[];
  readonly scenes?: readonly { readonly name?: string; readonly extras?: unknown }[];
  readonly extensions?: {
    readonly KHR_lights_punctual?: { readonly lights?: readonly { readonly name?: string }[] };
  };
}

export interface InspectedModel {
  readonly document: Document;
  readonly officialReport: ValidatorReport;
  readonly stats: AircraftRuntimeStats;
  readonly issues: readonly AssetPipelineIssue[];
}

export interface SourceModel extends InspectedModel {
  readonly bytes: Uint8Array;
  readonly manifest: AircraftAssetManifestValue;
  readonly sourcePath: string;
}

function problem(
  issues: AssetPipelineIssue[],
  code: string,
  path: string,
  message: string,
  severity: 'error' | 'warning' = 'error',
): void {
  issues.push({ severity, code, path, message });
}

function safeRelativePath(base: string, input: string): string | null {
  if (isAbsolute(input) || /^[a-z]+:/i.test(input)) return null;
  const fullPath = resolve(base, input);
  const fromBase = relative(base, fullPath);
  if (fromBase === '..' || fromBase.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)) {
    return null;
  }
  return fullPath;
}

export function parseGlbJson(bytes: Uint8Array): GlbJson {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < 20 || view.getUint32(0, true) !== 0x4654_6c67) {
    throw new Error('file is not a GLB container');
  }
  if (view.getUint32(4, true) !== 2) throw new Error('GLB must use container version 2');
  const declaredLength = view.getUint32(8, true);
  if (declaredLength !== bytes.byteLength) throw new Error('GLB header length does not match file');
  const jsonLength = view.getUint32(12, true);
  if (view.getUint32(16, true) !== 0x4e4f_534a || 20 + jsonLength > bytes.byteLength) {
    throw new Error('GLB has no valid JSON chunk');
  }
  const json = new TextDecoder().decode(bytes.subarray(20, 20 + jsonLength)).trimEnd();
  return JSON.parse(json) as GlbJson;
}

function listUris(json: GlbJson): string[] {
  return [...(json.buffers ?? []), ...(json.images ?? [])]
    .map((resource) => resource.uri)
    .filter((uri): uri is string => uri !== undefined);
}

function metadataOwners(json: GlbJson): string[] {
  const owners: string[] = [];
  if (json.asset?.extras !== undefined) owners.push('asset');
  for (const [type, properties] of [
    ['scene', json.scenes],
    ['node', json.nodes],
    ['mesh', json.meshes],
    ['material', json.materials],
    ['camera', json.cameras],
    ['animation', json.animations],
  ] as const) {
    for (const [index, property] of (properties ?? []).entries()) {
      if (property.extras !== undefined) owners.push(`${type}:${property.name ?? String(index)}`);
    }
  }
  return owners;
}

function names(properties: readonly { readonly name?: string }[] | undefined): string[] {
  return (properties ?? []).map((property) => property.name ?? '');
}

function sorted(values: Iterable<string>): string[] {
  return [...values].sort((left, right) => left.localeCompare(right));
}

function compareExactNames(
  issues: AssetPipelineIssue[],
  label: string,
  actual: readonly string[],
  expected: readonly string[],
): void {
  const missing = expected.filter((name) => !actual.includes(name));
  const extra = actual.filter((name) => !expected.includes(name));
  const duplicates = actual.filter((name, index) => actual.indexOf(name) !== index);
  if (actual.some((name) => name === '')) {
    problem(issues, `unnamed_${label}`, label, `${label} names must be stable and non-empty`);
  }
  if (missing.length > 0) {
    problem(issues, `missing_${label}`, label, `missing ${label}: ${sorted(missing).join(', ')}`);
  }
  if (extra.length > 0) {
    problem(
      issues,
      `unexpected_${label}`,
      label,
      `undeclared ${label}: ${sorted(extra).join(', ')}`,
    );
  }
  if (duplicates.length > 0) {
    problem(
      issues,
      `duplicate_${label}`,
      label,
      `duplicate ${label}: ${sorted(duplicates).join(', ')}`,
    );
  }
}

function isIdentity(matrix: readonly number[], epsilon = 1e-6): boolean {
  const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  return matrix.every((value, index) => Math.abs(value - (identity[index] ?? 0)) <= epsilon);
}

function triangleCount(primitive: GltfPrimitive): number {
  if (primitive.getMode() !== Primitive.Mode.TRIANGLES) return 0;
  const count =
    primitive.getIndices()?.getCount() ?? primitive.getAttribute('POSITION')?.getCount();
  return count === undefined ? 0 : Math.floor(count / 3);
}

function primitivesUnder(node: Node): GltfPrimitive[] {
  const primitives: GltfPrimitive[] = [];
  node.traverse((child) => {
    for (const primitive of child.getMesh()?.listPrimitives() ?? []) primitives.push(primitive);
  });
  return primitives;
}

interface UvBounds {
  readonly material: string;
  readonly minU: number;
  readonly minV: number;
  readonly maxU: number;
  readonly maxV: number;
}

interface UvTriangle {
  readonly id: number;
  readonly materialClass: string;
  readonly accessorKey: object;
  readonly indices: readonly [number, number, number];
  readonly points: readonly [
    readonly [number, number],
    readonly [number, number],
    readonly [number, number],
  ];
}

function uvBounds(primitives: readonly GltfPrimitive[], issues: AssetPipelineIssue[]): UvBounds[] {
  const byMaterial = new Map<string, { minU: number; minV: number; maxU: number; maxV: number }>();
  for (const primitive of primitives) {
    const material = primitive.getMaterial();
    const materialName = material?.getName() ?? '<missing>';
    const uv = primitive.getAttribute('TEXCOORD_1');
    if (!uv) continue;
    if (uv.getElementSize() !== 2) {
      problem(issues, 'invalid_livery_uv_type', materialName, 'TEXCOORD_1 must be VEC2');
      continue;
    }
    const bounds = byMaterial.get(materialName) ?? {
      minU: Number.POSITIVE_INFINITY,
      minV: Number.POSITIVE_INFINITY,
      maxU: Number.NEGATIVE_INFINITY,
      maxV: Number.NEGATIVE_INFINITY,
    };
    for (let index = 0; index < uv.getCount(); index += 1) {
      const element = uv.getElement(index, [0, 0]);
      const [u = Number.NaN, v = Number.NaN] = element;
      if (
        !Number.isFinite(u) ||
        !Number.isFinite(v) ||
        u < -1e-6 ||
        u > 1 + 1e-6 ||
        v < -1e-6 ||
        v > 1 + 1e-6
      ) {
        problem(
          issues,
          'livery_uv_out_of_range',
          `${materialName}.TEXCOORD_1.${String(index)}`,
          `livery UV (${String(u)}, ${String(v)}) is outside normalized 0..1 space`,
        );
      }
      bounds.minU = Math.min(bounds.minU, u);
      bounds.minV = Math.min(bounds.minV, v);
      bounds.maxU = Math.max(bounds.maxU, u);
      bounds.maxV = Math.max(bounds.maxV, v);
    }
    byMaterial.set(materialName, bounds);
  }
  return sorted(byMaterial.keys()).map((material) => ({ material, ...byMaterial.get(material)! }));
}

function uvFingerprint(bounds: readonly UvBounds[]): string {
  return sha256(
    canonicalJson(
      bounds.map((bound) => ({
        material: bound.material,
        minU: Number(bound.minU.toFixed(5)),
        minV: Number(bound.minV.toFixed(5)),
        maxU: Number(bound.maxU.toFixed(5)),
        maxV: Number(bound.maxV.toFixed(5)),
      })),
    ),
  );
}

function signedArea(points: UvTriangle['points']): number {
  const [a, b, c] = points;
  return ((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) / 2;
}

function cross(
  a: readonly [number, number],
  b: readonly [number, number],
  c: readonly [number, number],
): number {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

function lineIntersection(
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

function overlapArea(left: UvTriangle['points'], rightInput: UvTriangle['points']): number {
  let polygon: readonly (readonly [number, number])[] = left;
  const right =
    signedArea(rightInput) < 0 ? [rightInput[0], rightInput[2], rightInput[1]] : rightInput;
  for (let edge = 0; edge < 3; edge += 1) {
    const clipA = right[edge]!;
    const clipB = right[(edge + 1) % 3]!;
    const output: (readonly [number, number])[] = [];
    for (let index = 0; index < polygon.length; index += 1) {
      const current = polygon[index]!;
      const previous = polygon[(index + polygon.length - 1) % polygon.length]!;
      const currentInside = cross(clipA, clipB, current) >= -1e-10;
      const previousInside = cross(clipA, clipB, previous) >= -1e-10;
      if (currentInside !== previousInside) {
        output.push(lineIntersection(previous, current, clipA, clipB));
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

function sharedEdge(left: UvTriangle, right: UvTriangle): boolean {
  if (left.accessorKey !== right.accessorKey) return false;
  return left.indices.filter((index) => right.indices.includes(index)).length >= 2;
}

function validateUvOverlaps(
  primitives: readonly GltfPrimitive[],
  materialClasses: ReadonlyMap<string, string>,
  mirroredClasses: ReadonlySet<string>,
  issues: AssetPipelineIssue[],
): void {
  const grid = new Map<string, UvTriangle[]>();
  const compared = new Set<string>();
  let triangleId = 0;
  const cells = 96;
  for (const primitive of primitives) {
    const materialName = primitive.getMaterial()?.getName() ?? '';
    const materialClass = materialClasses.get(materialName);
    if (!materialClass) continue;
    const uv = primitive.getAttribute('TEXCOORD_1');
    if (!uv) continue;
    const indices = primitive.getIndices();
    const count = indices?.getCount() ?? uv.getCount();
    for (let offset = 0; offset + 2 < count; offset += 3) {
      const vertexIndices = [
        indices?.getScalar(offset) ?? offset,
        indices?.getScalar(offset + 1) ?? offset + 1,
        indices?.getScalar(offset + 2) ?? offset + 2,
      ] as const;
      const points = vertexIndices.map((index) => {
        const value = uv.getElement(index, [0, 0]);
        return [value[0] ?? 0, value[1] ?? 0] as const;
      }) as unknown as UvTriangle['points'];
      const triangle: UvTriangle = {
        id: triangleId,
        materialClass,
        accessorKey: uv,
        indices: vertexIndices,
        points,
      };
      triangleId += 1;
      if (Math.abs(signedArea(points)) < 1e-10) {
        problem(
          issues,
          'degenerate_livery_uv',
          `${materialName}.TEXCOORD_1`,
          'paintable UV triangle has zero area',
        );
        continue;
      }
      const minU = Math.max(0, Math.min(...points.map((point) => point[0])));
      const maxU = Math.min(1, Math.max(...points.map((point) => point[0])));
      const minV = Math.max(0, Math.min(...points.map((point) => point[1])));
      const maxV = Math.min(1, Math.max(...points.map((point) => point[1])));
      const minX = Math.floor(minU * (cells - 1));
      const maxX = Math.floor(maxU * (cells - 1));
      const minY = Math.floor(minV * (cells - 1));
      const maxY = Math.floor(maxV * (cells - 1));
      for (let x = minX; x <= maxX; x += 1) {
        for (let y = minY; y <= maxY; y += 1) {
          const key = `${String(x)}:${String(y)}`;
          for (const other of grid.get(key) ?? []) {
            const pair = `${String(Math.min(triangle.id, other.id))}:${String(Math.max(triangle.id, other.id))}`;
            if (compared.has(pair) || sharedEdge(triangle, other)) continue;
            compared.add(pair);
            if (overlapArea(triangle.points, other.points) <= 1e-8) continue;
            if (
              triangle.materialClass === other.materialClass &&
              mirroredClasses.has(triangle.materialClass)
            ) {
              continue;
            }
            problem(
              issues,
              'overlapping_livery_uv',
              'TEXCOORD_1',
              `paintable ${triangle.materialClass} overlaps ${other.materialClass} in livery UV space`,
            );
            if (issues.filter((issue) => issue.code === 'overlapping_livery_uv').length >= 20) {
              return;
            }
          }
          const bucket = grid.get(key) ?? [];
          bucket.push(triangle);
          grid.set(key, bucket);
        }
      }
    }
  }
}

function textureDimensions(bytes: Uint8Array): { mimeType: string; width: number; height: number } {
  if (
    bytes.length >= 24 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return { mimeType: 'image/png', width: view.getUint32(16), height: view.getUint32(20) };
  }
  const ktx2 = [0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length >= 28 && ktx2.every((value, index) => bytes[index] === value)) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return {
      mimeType: 'image/ktx2',
      width: view.getUint32(20, true),
      height: view.getUint32(24, true),
    };
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 8 < bytes.length) {
      if (bytes[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = bytes[offset + 1] ?? 0;
      const length = ((bytes[offset + 2] ?? 0) << 8) | (bytes[offset + 3] ?? 0);
      if (
        [0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(
          marker,
        )
      ) {
        return {
          mimeType: 'image/jpeg',
          height: ((bytes[offset + 5] ?? 0) << 8) | (bytes[offset + 6] ?? 0),
          width: ((bytes[offset + 7] ?? 0) << 8) | (bytes[offset + 8] ?? 0),
        };
      }
      offset += Math.max(2, length + 2);
    }
  }
  throw new Error('unsupported or malformed PNG, JPEG or KTX2 texture');
}

async function validateTextureFiles(
  manifestDirectory: string,
  manifest: AircraftAssetManifestValue,
  decision: AircraftOptimisationDecision,
  issues: AssetPipelineIssue[],
): Promise<void> {
  for (const [index, texture] of manifest.technical.pbrTextures.entries()) {
    const path = safeRelativePath(manifestDirectory, texture.uri);
    if (!path) {
      problem(
        issues,
        'unsafe_texture_path',
        `technical.pbrTextures.${String(index)}.uri`,
        texture.uri,
      );
      continue;
    }
    try {
      const bytes = await readFile(path);
      const measured = textureDimensions(bytes);
      if (
        measured.mimeType !== texture.mimeType ||
        measured.width !== texture.width ||
        measured.height !== texture.height
      ) {
        problem(
          issues,
          'texture_metadata_mismatch',
          `technical.pbrTextures.${String(index)}`,
          `declared ${texture.mimeType} ${String(texture.width)}x${String(texture.height)}, measured ${measured.mimeType} ${String(measured.width)}x${String(measured.height)}`,
        );
      }
      if (decision.textures.mode === 'ktx2_passthrough' && measured.mimeType !== 'image/ktx2') {
        problem(
          issues,
          'ktx2_source_required',
          `technical.pbrTextures.${String(index)}.uri`,
          'KTX2 passthrough requires every source texture to be KTX2',
        );
      }
    } catch (error) {
      problem(
        issues,
        'missing_or_invalid_texture',
        `technical.pbrTextures.${String(index)}.uri`,
        error instanceof Error ? error.message : String(error),
      );
    }
  }
}

function materialTextureSlots(material: Material): readonly (Texture | null)[] {
  return [
    material.getBaseColorTexture(),
    material.getNormalTexture(),
    material.getMetallicRoughnessTexture(),
    material.getOcclusionTexture(),
    material.getEmissiveTexture(),
  ];
}

export function measuredBudgetIssues(
  profile: AircraftAssetBudgetProfile,
  stats: AircraftRuntimeStats,
  exception: AircraftAssetBudgetException | null,
  today: string,
): AssetPipelineIssue[] {
  const issues: AssetPipelineIssue[] = [];
  const budget = AIRCRAFT_ASSET_BUDGETS[profile];
  const exceeded = new Set<AircraftAssetBudgetException['metrics'][number]>();
  if (stats.triangles > budget.maxLod0Triangles) exceeded.add('lod0Triangles');
  if (stats.drawCalls > budget.maxDrawCalls) exceeded.add('drawCalls');
  if (stats.materials > budget.maxMaterials) exceeded.add('materials');
  if (stats.textureMemoryBytes > budget.maxTextureMemoryBytes) exceeded.add('textureMemoryBytes');
  if (stats.boundsM.width > budget.maxBoundsM.width) exceeded.add('boundsWidth');
  if (stats.boundsM.length > budget.maxBoundsM.length) exceeded.add('boundsLength');
  if (stats.boundsM.height > budget.maxBoundsM.height) exceeded.add('boundsHeight');
  if (exceeded.size > 0) {
    const missing = exception
      ? [...exceeded].filter((metric) => !exception.metrics.includes(metric))
      : [...exceeded];
    if (!exception || exception.expiresAt < today || missing.length > 0) {
      problem(
        issues,
        'asset_budget_exceeded',
        'budget',
        `measured asset exceeds: ${sorted(exceeded).join(', ')}${exception && exception.expiresAt < today ? '; exception expired' : ''}`,
      );
    } else {
      problem(
        issues,
        'asset_budget_exception',
        'budget',
        `approved exception covers: ${sorted(exceeded).join(', ')}`,
        'warning',
      );
    }
  } else if (exception) {
    problem(
      issues,
      'unused_budget_exception',
      'budgetException',
      'asset is within budget; remove the exception',
      'warning',
    );
  }
  return issues;
}

function inspectDocument(
  document: Document,
  json: GlbJson,
  manifest: AircraftAssetManifestValue,
  decision: AircraftOptimisationDecision,
  today: string,
  phase: 'source' | 'runtime',
): { stats: AircraftRuntimeStats; issues: AssetPipelineIssue[] } {
  const issues: AssetPipelineIssue[] = [];
  const root = document.getRoot();
  compareExactNames(
    issues,
    'nodes',
    root.listNodes().map((node) => node.getName()),
    manifest.technical.naming.nodeNames,
  );
  compareExactNames(
    issues,
    'meshes',
    root.listMeshes().map((mesh) => mesh.getName()),
    manifest.technical.naming.meshNames,
  );
  compareExactNames(
    issues,
    'materials',
    root.listMaterials().map((material) => material.getName()),
    manifest.technical.materials.map((binding) => binding.materialName),
  );

  if (root.listScenes().length !== 1) {
    problem(issues, 'scene_count', 'scenes', 'aircraft assets must contain exactly one scene');
  }
  const rootNode = root
    .listNodes()
    .find((node) => node.getName() === manifest.technical.naming.rootNode);
  if (!rootNode || !root.listScenes()[0]?.listChildren().includes(rootNode)) {
    problem(
      issues,
      'invalid_root_node',
      'technical.naming.rootNode',
      'rootNode must be a scene root',
    );
  }

  const anchorNames = new Set(manifest.technical.anchors.map((anchor) => anchor.nodeName));
  const lightSocketNames = new Set(
    manifest.technical.lightSockets.map((socket) => socket.nodeName),
  );
  for (const node of root.listNodes()) {
    if (node.getMesh() !== null || node.getName() === manifest.technical.naming.rootNode) {
      if (!isIdentity(node.getMatrix())) {
        problem(
          issues,
          'unbaked_transform',
          `node:${node.getName()}`,
          'mesh and root transforms must be baked to identity',
        );
      }
    } else if (
      (anchorNames.has(node.getName()) || lightSocketNames.has(node.getName())) &&
      node.getWorldScale().some((value) => Math.abs(value - 1) > 1e-6)
    ) {
      problem(
        issues,
        'scaled_anchor',
        `node:${node.getName()}`,
        'anchor nodes must use unit scale',
      );
    }
  }
  const groundNodeName = manifest.technical.anchors.find(
    (anchor) => anchor.id === 'ground_contact',
  )?.nodeName;
  const groundNode = root.listNodes().find((node) => node.getName() === groundNodeName);
  if (!groundNode || groundNode.getWorldTranslation().some((value) => Math.abs(value) > 0.05)) {
    problem(
      issues,
      'invalid_ground_origin',
      'technical.anchors.ground_contact',
      'ground-contact anchor must be within 5 cm of the world origin',
    );
  }

  compareExactNames(issues, 'animations', names(json.animations), decision.allow.animations);
  compareExactNames(issues, 'cameras', names(json.cameras), decision.allow.cameras);
  compareExactNames(
    issues,
    'lights',
    names(json.extensions?.KHR_lights_punctual?.lights),
    decision.allow.lights,
  );
  compareExactNames(issues, 'metadata', metadataOwners(json), decision.allow.metadataOwners);
  if (root.listSkins().length > 0) {
    problem(issues, 'unsupported_skin', 'skins', 'runtime exterior assets may not contain skins');
  }

  const bindings = new Map(
    manifest.technical.materials.map((binding) => [binding.materialName, binding]),
  );
  const usedMaterials = new Set<string>();
  const usedTextures = new Set<unknown>();
  const usedMeshes = new Set<unknown>();
  for (const node of root.listNodes()) if (node.getMesh()) usedMeshes.add(node.getMesh());
  for (const material of root.listMaterials()) {
    for (const texture of materialTextureSlots(material)) if (texture) usedTextures.add(texture);
  }
  if (
    decision.textures.mode === 'ktx2_passthrough' &&
    root.listTextures().some((texture) => texture.getMimeType() !== 'image/ktx2')
  ) {
    problem(
      issues,
      'runtime_texture_not_ktx2',
      'textures',
      'KTX2 passthrough requires every material texture to use image/ktx2',
    );
  }
  for (const mesh of root.listMeshes()) {
    for (const primitive of mesh.listPrimitives()) {
      if (primitive.getMode() !== Primitive.Mode.TRIANGLES) {
        problem(
          issues,
          'non_triangle_primitive',
          `mesh:${mesh.getName()}`,
          'aircraft meshes must use TRIANGLES',
        );
      }
      const material = primitive.getMaterial();
      if (!material) {
        problem(
          issues,
          'missing_material',
          `mesh:${mesh.getName()}`,
          'every primitive needs a material',
        );
        continue;
      }
      const materialName = material.getName();
      usedMaterials.add(materialName);
      const binding = bindings.get(materialName);
      if (binding?.kind === 'paintable') {
        if (!primitive.getAttribute('TEXCOORD_1')) {
          problem(
            issues,
            'missing_livery_uv',
            `mesh:${mesh.getName()}.${materialName}`,
            'paintable primitives require TEXCOORD_1',
          );
        }
        if (
          !material.getBaseColorTexture() ||
          !material.getNormalTexture() ||
          !material.getMetallicRoughnessTexture()
        ) {
          problem(
            issues,
            'missing_pbr_texture',
            `material:${materialName}`,
            'paintable materials require base-colour, normal and metallic/roughness textures',
          );
        }
      }
    }
  }
  for (const material of root.listMaterials()) {
    if (!usedMaterials.has(material.getName())) {
      problem(
        issues,
        'unused_material',
        `material:${material.getName()}`,
        'unused material must be removed',
      );
    }
  }
  for (const texture of root.listTextures()) {
    if (!usedTextures.has(texture)) {
      problem(
        issues,
        'unused_texture',
        `texture:${texture.getName()}`,
        'unused texture must be removed',
      );
    }
  }
  const declaredTextureSizes = manifest.technical.pbrTextures
    .map((texture) => `${texture.mimeType}:${String(texture.width)}x${String(texture.height)}`)
    .sort();
  const measuredTextureSizes = root
    .listTextures()
    .map((texture) => {
      const size = texture.getSize();
      return `${texture.getMimeType()}:${String(size?.[0] ?? 0)}x${String(size?.[1] ?? 0)}`;
    })
    .sort();
  const textureSizesMatch =
    phase === 'source'
      ? canonicalJson(declaredTextureSizes) === canonicalJson(measuredTextureSizes)
      : canonicalJson([...new Set(declaredTextureSizes)]) ===
        canonicalJson([...new Set(measuredTextureSizes)]);
  if (!textureSizesMatch) {
    problem(
      issues,
      'model_texture_manifest_mismatch',
      'technical.pbrTextures',
      `manifest textures ${declaredTextureSizes.join(', ')} do not match model textures ${measuredTextureSizes.join(', ')}`,
    );
  }
  for (const mesh of root.listMeshes()) {
    if (!usedMeshes.has(mesh)) {
      problem(issues, 'unused_mesh', `mesh:${mesh.getName()}`, 'unused mesh must be removed');
    }
  }

  const paintableClasses = new Map(
    manifest.technical.materials
      .filter((binding) => binding.kind === 'paintable')
      .map((binding) => [binding.materialName, binding.class]),
  );
  const mirroredClasses = new Set(
    manifest.technical.liveryUv.mirroredIslands.flatMap((island) => island.surfaces),
  );
  const lodStats: AircraftRuntimeStats['lods'][number][] = [];
  let lod0Node: Node | null = null;
  let lod0Primitives: GltfPrimitive[] = [];
  let baselineBounds: UvBounds[] | null = null;
  for (const expected of [...manifest.technical.lods].sort(
    (left, right) => left.level - right.level,
  )) {
    const node = root.listNodes().find((candidate) => candidate.getName() === expected.nodeName);
    if (!node) continue;
    const primitives = primitivesUnder(node);
    const triangles = primitives.reduce((sum, primitive) => sum + triangleCount(primitive), 0);
    if (triangles !== expected.triangleCount) {
      problem(
        issues,
        'lod_triangle_mismatch',
        `technical.lods.${String(expected.level)}.triangleCount`,
        `manifest declares ${String(expected.triangleCount)}, measured ${String(triangles)}`,
      );
    }
    const paintableMaterialNames = sorted(
      new Set(
        primitives
          .map((primitive) => primitive.getMaterial()?.getName() ?? '')
          .filter((name) => paintableClasses.has(name)),
      ),
    );
    const expectedPaintable = sorted(paintableClasses.keys());
    compareExactNames(
      issues,
      `lod${String(expected.level)}_paintable_materials`,
      paintableMaterialNames,
      expectedPaintable,
    );
    const bounds = uvBounds(primitives, issues);
    if (baselineBounds === null) baselineBounds = bounds;
    else {
      for (const baseline of baselineBounds) {
        const candidate = bounds.find((bound) => bound.material === baseline.material);
        if (
          !candidate ||
          ['minU', 'minV', 'maxU', 'maxV'].some(
            (field) =>
              Math.abs(
                candidate[field as keyof Omit<UvBounds, 'material'>] -
                  baseline[field as keyof Omit<UvBounds, 'material'>],
              ) > 0.002,
          )
        ) {
          problem(
            issues,
            'lod_livery_uv_drift',
            `LOD${String(expected.level)}.${baseline.material}`,
            'LOD livery UV bounds drift from LOD0 by more than 0.002',
          );
        }
      }
    }
    validateUvOverlaps(primitives, paintableClasses, mirroredClasses, issues);
    lodStats.push({
      level: expected.level,
      nodeName: expected.nodeName,
      triangles,
      liveryUvFingerprint: uvFingerprint(bounds),
    });
    if (expected.level === 0) {
      lod0Node = node;
      lod0Primitives = primitives;
    }
  }
  if (!lod0Node) throw new Error('manifest validation admitted no LOD0 node');

  const measuredBounds = getBounds(lod0Node);
  const dimensions = {
    width: measuredBounds.max[0] - measuredBounds.min[0],
    height: measuredBounds.max[1] - measuredBounds.min[1],
    length: measuredBounds.max[2] - measuredBounds.min[2],
  };
  if (Math.abs(measuredBounds.min[1]) > 0.05) {
    problem(
      issues,
      'bounds_miss_ground_plane',
      'bounds.minY',
      `LOD0 minimum Y is ${measuredBounds.min[1].toFixed(3)} m; expected ground plane at 0`,
    );
  }
  for (const dimension of ['width', 'length', 'height'] as const) {
    const declared = manifest.technical.budget.boundsM[dimension];
    const tolerance = Math.max(0.05, declared * 0.02);
    if (Math.abs(dimensions[dimension] - declared) > tolerance) {
      problem(
        issues,
        'bounds_mismatch',
        `technical.budget.boundsM.${dimension}`,
        `manifest declares ${declared.toFixed(3)} m, measured ${dimensions[dimension].toFixed(3)} m`,
      );
    }
  }

  const textureMemoryBytes = Math.ceil(
    manifest.technical.pbrTextures.reduce(
      (sum, texture) => sum + texture.width * texture.height * 4,
      0,
    ) *
      (4 / 3),
  );
  if (manifest.technical.budget.textureMemoryBytes < textureMemoryBytes) {
    problem(
      issues,
      'texture_memory_underreported',
      'technical.budget.textureMemoryBytes',
      `manifest declares ${String(manifest.technical.budget.textureMemoryBytes)}, conservative estimate is ${String(textureMemoryBytes)}`,
    );
  }
  if (manifest.technical.budget.drawCalls !== lod0Primitives.length) {
    problem(
      issues,
      'draw_calls_mismatch',
      'technical.budget.drawCalls',
      `manifest declares ${String(manifest.technical.budget.drawCalls)}, measured ${String(lod0Primitives.length)}`,
    );
  }

  const accessors = new Set(
    lod0Primitives.flatMap((primitive) => [primitive.getIndices(), ...primitive.listAttributes()]),
  );
  accessors.delete(null);
  const gpuGeometryBytes = [...accessors].reduce(
    (sum, accessor) => sum + (accessor?.getArray()?.byteLength ?? 0),
    0,
  );
  const stats: AircraftRuntimeStats = {
    triangles: lodStats.find((lod) => lod.level === 0)?.triangles ?? 0,
    vertices: getNodeVertexCount(lod0Node, VertexCountMethod.RENDER),
    drawCalls: lod0Primitives.length,
    materials: root.listMaterials().length,
    textures: root.listTextures().length,
    textureMemoryBytes,
    gpuGeometryBytes,
    boundsM: dimensions,
    lods: lodStats,
  };

  issues.push(
    ...measuredBudgetIssues(
      manifest.technical.budget.profile,
      stats,
      decision.budgetException,
      today,
    ),
  );

  return { stats, issues };
}

async function createIo(): Promise<NodeIO> {
  await Promise.all([MeshoptDecoder.ready, MeshoptEncoder.ready]);
  return new NodeIO()
    .registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({
      'meshopt.decoder': MeshoptDecoder,
      'meshopt.encoder': MeshoptEncoder,
    })
    .setAllowNetwork(false);
}

async function officialValidation(
  bytes: Uint8Array,
  uri: string,
  resourceDirectory: string,
  allowedResources: ReadonlySet<string>,
): Promise<ValidatorReport> {
  return validateBytes(bytes, {
    uri,
    format: 'glb',
    writeTimestamp: false,
    maxIssues: 0,
    externalResourceFunction: async (input) => {
      const decoded = decodeURIComponent(input).replaceAll('\\', '/');
      if (!allowedResources.has(decoded))
        throw new Error(`undeclared external resource "${decoded}"`);
      const path = safeRelativePath(resourceDirectory, decoded);
      if (!path) throw new Error(`unsafe external resource "${decoded}"`);
      return readFile(path);
    },
  });
}

function officialIssues(report: ValidatorReport): AssetPipelineIssue[] {
  return report.issues.messages
    .filter((message) => message.severity === 0)
    .map((message) => ({
      severity: 'error' as const,
      code: `gltf_${message.code.toLowerCase()}`,
      path: message.pointer ?? '',
      message: message.message,
    }));
}

export async function loadAndInspectSource(
  manifestPath: string,
  decision: AircraftOptimisationDecision,
  today = new Date().toISOString().slice(0, 10),
): Promise<SourceModel> {
  const manifestDirectory = dirname(resolve(manifestPath));
  const manifestInput = JSON.parse(await readFile(manifestPath, 'utf8')) as unknown;
  const manifest = AircraftAssetManifest.parse(manifestInput);
  const sourcePath = safeRelativePath(manifestDirectory, manifest.technical.delivery.filePath);
  if (!sourcePath) {
    throw new AssetPipelineError('Source path is unsafe', [
      {
        severity: 'error',
        code: 'unsafe_source_path',
        path: 'technical.delivery.filePath',
        message: manifest.technical.delivery.filePath,
      },
    ]);
  }
  const bytes = await readFile(sourcePath);
  const issues: AssetPipelineIssue[] = [];
  if (bytes.byteLength !== manifest.technical.delivery.byteSize) {
    problem(
      issues,
      'source_size_mismatch',
      'technical.delivery.byteSize',
      `manifest declares ${String(manifest.technical.delivery.byteSize)}, read ${String(bytes.byteLength)}`,
    );
  }
  const sourceHash = sha256(bytes);
  if (sourceHash !== manifest.technical.delivery.fileSha256) {
    problem(issues, 'source_hash_mismatch', 'technical.delivery.fileSha256', sourceHash);
  }
  if (decision.sourceFileSha256 !== sourceHash) {
    problem(issues, 'decision_hash_mismatch', 'decision.sourceFileSha256', sourceHash);
  }

  let json: GlbJson;
  try {
    json = parseGlbJson(bytes);
  } catch (error) {
    throw new AssetPipelineError('GLB container is invalid', [
      {
        severity: 'error',
        code: 'invalid_glb',
        path: manifest.technical.delivery.filePath,
        message: error instanceof Error ? error.message : String(error),
      },
    ]);
  }
  const declaredResources = new Set(
    manifest.technical.pbrTextures.map((texture) => texture.uri.replaceAll('\\', '/')),
  );
  for (const uri of listUris(json)) {
    const normalized = decodeURIComponent(uri).replaceAll('\\', '/');
    if (!declaredResources.has(normalized)) {
      problem(
        issues,
        'undeclared_external_uri',
        'glb.uri',
        `external resource "${normalized}" is not declared by the manifest`,
      );
    }
    if (!safeRelativePath(manifestDirectory, normalized)) {
      problem(issues, 'unsafe_external_uri', 'glb.uri', `unsafe external resource "${normalized}"`);
    }
  }
  await validateTextureFiles(manifestDirectory, manifest, decision, issues);

  if (issues.some((issue) => issue.severity === 'error')) {
    throw new AssetPipelineError('Aircraft source failed validation', issues);
  }

  let officialReport: ValidatorReport;
  try {
    officialReport = await officialValidation(
      bytes,
      manifest.technical.delivery.filePath,
      manifestDirectory,
      declaredResources,
    );
    issues.push(...officialIssues(officialReport));
  } catch (error) {
    throw new AssetPipelineError('Official glTF validation could not run', [
      {
        severity: 'error',
        code: 'gltf_validator_failed',
        path: manifest.technical.delivery.filePath,
        message: error instanceof Error ? error.message : String(error),
      },
    ]);
  }

  let document: Document;
  try {
    document = await (await createIo()).read(sourcePath);
  } catch (error) {
    throw new AssetPipelineError('glTF Transform could not read the source', [
      {
        severity: 'error',
        code: 'gltf_transform_read_failed',
        path: manifest.technical.delivery.filePath,
        message: error instanceof Error ? error.message : String(error),
      },
    ]);
  }
  const inspected = inspectDocument(document, json, manifest, decision, today, 'source');
  issues.push(...inspected.issues);
  if (issues.some((issue) => issue.severity === 'error')) {
    throw new AssetPipelineError('Aircraft source failed validation', issues);
  }
  return { bytes, document, manifest, sourcePath, officialReport, stats: inspected.stats, issues };
}

export async function optimiseModel(
  source: SourceModel,
  decision: AircraftOptimisationDecision,
): Promise<Uint8Array> {
  const document = cloneDocument(source.document);
  await document.transform(
    dedup({ propertyTypes: [PropertyType.ACCESSOR, PropertyType.TEXTURE] }),
    weld(),
    reorder({ encoder: MeshoptEncoder, target: 'size', cleanup: false }),
    prune({
      keepLeaves: true,
      keepAttributes: true,
      keepSolidTextures: true,
      keepExtras: decision.allow.metadataOwners.length > 0,
    }),
  );
  if (decision.geometry.mode === 'meshopt_lossless') {
    document
      .createExtension(EXTMeshoptCompression)
      .setRequired(true)
      .setEncoderOptions({ method: EXTMeshoptCompression.EncoderMethod.QUANTIZE });
  }
  return (await createIo()).writeBinary(document);
}

export async function inspectRuntime(
  bytes: Uint8Array,
  manifest: AircraftAssetManifestValue,
  decision: AircraftOptimisationDecision,
  today = new Date().toISOString().slice(0, 10),
): Promise<InspectedModel> {
  const json = parseGlbJson(bytes);
  const issues: AssetPipelineIssue[] = [];
  if (listUris(json).length > 0) {
    problem(
      issues,
      'runtime_external_uri',
      'runtime.uri',
      'runtime GLB must embed every dependency',
    );
  }
  const officialReport = await officialValidation(bytes, 'aircraft.glb', '.', new Set());
  issues.push(...officialIssues(officialReport));
  const document = await (await createIo()).readBinary(bytes);
  const inspected = inspectDocument(document, json, manifest, decision, today, 'runtime');
  issues.push(...inspected.issues);
  return { document, officialReport, stats: inspected.stats, issues };
}
