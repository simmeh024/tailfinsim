import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { Document, NodeIO } from '@gltf-transform/core';

import {
  AIRCRAFT_ASSET_MANIFEST_FORMAT,
  AIRCRAFT_ASSET_MANIFEST_VERSION,
  AircraftAnchorId,
  type AircraftAssetManifest,
} from '@tailfin/shared';

import { canonicalJson, sha256 } from './canonical';
import { EMPTY_AIRCRAFT_RUNTIME_REGISTRY } from './registry';
import {
  AIRCRAFT_OPTIMISATION_DECISION_FORMAT,
  AIRCRAFT_OPTIMISATION_DECISION_VERSION,
  type AircraftOptimisationDecision,
} from './schema';

const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAEAQH/2p6vWQAAAABJRU5ErkJggg==',
  'base64',
);

const LOD_UVS = {
  0: [
    0,
    0,
    1 / 3,
    0,
    0,
    1,
    1 / 3,
    0,
    1 / 3,
    1,
    0,
    1,
    1 / 3,
    0,
    2 / 3,
    0,
    1 / 3,
    1,
    2 / 3,
    0,
    2 / 3,
    1,
    1 / 3,
    1,
    2 / 3,
    0,
    1,
    0,
    2 / 3,
    1,
    1,
    0,
    1,
    1,
    2 / 3,
    1,
  ],
  1: [0, 0, 1, 0, 0, 1, 1, 0, 1, 1, 0, 1],
  2: [0, 0, 1, 0, 0, 1],
} as const;

export interface FixtureOptions {
  readonly assetVersion?: string;
  readonly outOfRangeUv?: boolean;
  readonly designation?: 'A220-300' | 'A320neo';
  readonly unsafeExternalUri?: boolean;
}

export interface AircraftAssetFixture {
  readonly sourceDirectory: string;
  readonly manifestPath: string;
  readonly decisionPath: string;
  readonly registryRoot: string;
  readonly manifest: AircraftAssetManifest;
  readonly decision: AircraftOptimisationDecision;
}

function positionsFor(uvs: readonly number[]): number[] {
  const positions: number[] = [];
  for (let index = 0; index < uvs.length; index += 2) {
    const u = uvs[index] ?? 0;
    const v = uvs[index + 1] ?? 0;
    positions.push((u - 0.5) * 30, v * 10, (v - 0.5) * 40);
  }
  return positions;
}

function measurement(sourceBytes: number) {
  return {
    pilotAssets: ['fixture/a220-300'],
    sourceBytes,
    runtimeBytes: sourceBytes,
    gpuUploadMsP95: 1,
    visualReview: 'Fixture preserves silhouette, material boundaries and livery placement.',
    measuredBy: 'Tailfin test suite',
    measuredAt: '2026-08-25',
  };
}

function withUnsafeExternalUri(bytes: Uint8Array): Uint8Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const jsonLength = view.getUint32(12, true);
  const json = JSON.parse(
    new TextDecoder().decode(bytes.subarray(20, 20 + jsonLength)).trimEnd(),
  ) as { images?: { uri?: string }[] };
  if (!json.images?.[0]) throw new Error('Fixture GLB has no image');
  json.images[0].uri = 'https://assets.invalid/base.png';
  const encoded = new TextEncoder().encode(JSON.stringify(json));
  const paddedLength = Math.ceil(encoded.byteLength / 4) * 4;
  const remainder = bytes.subarray(20 + jsonLength);
  const output = new Uint8Array(20 + paddedLength + remainder.byteLength);
  const outputView = new DataView(output.buffer);
  outputView.setUint32(0, 0x4654_6c67, true);
  outputView.setUint32(4, 2, true);
  outputView.setUint32(8, output.byteLength, true);
  outputView.setUint32(12, paddedLength, true);
  outputView.setUint32(16, 0x4e4f_534a, true);
  output.fill(0x20, 20, 20 + paddedLength);
  output.set(encoded, 20);
  output.set(remainder, 20 + paddedLength);
  return output;
}

async function createSourceGlb(
  path: string,
  outOfRangeUv: boolean,
  unsafeExternalUri: boolean,
): Promise<Uint8Array> {
  const document = new Document();
  const buffer = document.createBuffer('aircraft-buffer');
  const scene = document.createScene('aircraft-scene');
  const root = document.createNode('aircraft-root');
  scene.addChild(root);

  const baseColor = document
    .createTexture('base-color')
    .setImage(ONE_PIXEL_PNG)
    .setMimeType('image/png');
  const normal = document.createTexture('normal').setImage(ONE_PIXEL_PNG).setMimeType('image/png');
  const metallicRoughness = document
    .createTexture('metallic-roughness')
    .setImage(ONE_PIXEL_PNG)
    .setMimeType('image/png');
  const material = document
    .createMaterial('paint-fuselage')
    .setBaseColorTexture(baseColor)
    .setNormalTexture(normal)
    .setMetallicRoughnessTexture(metallicRoughness);

  for (const level of [0, 1, 2] as const) {
    const sourceUvs: number[] = [...LOD_UVS[level]];
    if (outOfRangeUv && level === 0) sourceUvs[0] = 1.2;
    const vertexCount = sourceUvs.length / 2;
    const positions = document
      .createAccessor(`positions-lod${String(level)}`)
      .setType('VEC3')
      .setArray(new Float32Array(positionsFor(sourceUvs)))
      .setBuffer(buffer);
    const normals = document
      .createAccessor(`normals-lod${String(level)}`)
      .setType('VEC3')
      .setArray(new Float32Array(Array.from({ length: vertexCount }, () => [0, 1, 0]).flat()))
      .setBuffer(buffer);
    const uvs = document
      .createAccessor(`livery-uv-lod${String(level)}`)
      .setType('VEC2')
      .setArray(new Float32Array(sourceUvs))
      .setBuffer(buffer);
    const indices = document
      .createAccessor(`indices-lod${String(level)}`)
      .setType('SCALAR')
      .setArray(new Uint16Array(Array.from({ length: vertexCount }, (_, index) => index)))
      .setBuffer(buffer);
    const primitive = document
      .createPrimitive()
      .setIndices(indices)
      .setAttribute('POSITION', positions)
      .setAttribute('NORMAL', normals)
      .setAttribute('TEXCOORD_0', uvs)
      .setAttribute('TEXCOORD_1', uvs)
      .setMaterial(material);
    const mesh = document.createMesh(`mesh-lod${String(level)}`).addPrimitive(primitive);
    root.addChild(document.createNode(`lod${String(level)}`).setMesh(mesh));
  }

  for (const [index, id] of AircraftAnchorId.options.entries()) {
    const node = document.createNode(`anchor-${id.replaceAll('_', '-')}`);
    if (id !== 'ground_contact') node.setTranslation([index + 1, 1, -index - 1]);
    root.addChild(node);
  }

  let bytes: Uint8Array<ArrayBufferLike> = await new NodeIO().writeBinary(document);
  if (unsafeExternalUri) bytes = withUnsafeExternalUri(bytes);
  await writeFile(path, bytes);
  return bytes;
}

export async function createAircraftAssetFixture(
  directory: string,
  options: FixtureOptions = {},
): Promise<AircraftAssetFixture> {
  const sourceDirectory = resolve(directory, 'source');
  const registryRoot = resolve(directory, 'registry');
  await mkdir(sourceDirectory, { recursive: true });
  await mkdir(registryRoot, { recursive: true });
  const sourcePath = resolve(sourceDirectory, 'source.glb');
  const sourceBytes = await createSourceGlb(
    sourcePath,
    options.outOfRangeUv ?? false,
    options.unsafeExternalUri ?? false,
  );
  for (const name of ['base.png', 'normal.png', 'metallic-roughness.png']) {
    await writeFile(resolve(sourceDirectory, name), ONE_PIXEL_PNG);
  }
  try {
    await writeFile(
      resolve(registryRoot, 'registry.json'),
      canonicalJson(EMPTY_AIRCRAFT_RUNTIME_REGISTRY),
      { flag: 'wx' },
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }

  const sourceFileSha256 = sha256(sourceBytes);
  const designation = options.designation ?? 'A220-300';
  const isA320 = designation === 'A320neo';
  const anchorNodeName = (id: (typeof AircraftAnchorId.options)[number]) =>
    `anchor-${id.replaceAll('_', '-')}`;
  const manifest: AircraftAssetManifest = {
    format: AIRCRAFT_ASSET_MANIFEST_FORMAT,
    formatVersion: AIRCRAFT_ASSET_MANIFEST_VERSION,
    technical: {
      identity: {
        assetId: isA320 ? 'a320neo' : 'a220-300',
        assetVersion: options.assetVersion ?? '1.0.0',
        catalogueVersion: 'v1',
        family: isA320 ? 'A320neo' : 'A220',
        geometryVariantId: isA320 ? 'a320neo' : 'a220-300',
        designations: [designation],
      },
      delivery: {
        filePath: 'source.glb',
        mimeType: 'model/gltf-binary',
        gltfVersion: '2.0',
        byteSize: sourceBytes.byteLength,
        fileSha256: sourceFileSha256,
        units: 'metres',
        upAxis: '+Y',
        forwardAxis: '-Z',
        origin: 'ground-centre',
        transformsBaked: true,
      },
      naming: {
        convention: 'tailfin-aircraft-v1',
        rootNode: 'aircraft-root',
        nodeNames: [
          'aircraft-root',
          'lod0',
          'lod1',
          'lod2',
          ...AircraftAnchorId.options.map(anchorNodeName),
        ],
        meshNames: ['mesh-lod0', 'mesh-lod1', 'mesh-lod2'],
      },
      liveryUv: {
        resource: { id: `${isA320 ? 'a320neo' : 'a220-300'}/livery-uv`, version: '1.0.0' },
        texCoord: 'TEXCOORD_1',
        normalized: true,
        nonOverlappingPaintableIslands: true,
        paddingPxAt4096: 8,
        mirroredIslands: [],
      },
      bindingResources: {
        materialBinding: {
          id: `${isA320 ? 'a320neo' : 'a220-300'}/materials`,
          version: '1.0.0',
        },
        anchorSet: { id: `${isA320 ? 'a320neo' : 'a220-300'}/anchors`, version: '1.0.0' },
      },
      materials: [{ materialName: 'paint-fuselage', kind: 'paintable', class: 'fuselage' }],
      pbrTextures: [
        {
          kind: 'base_color',
          uri: 'base.png',
          mimeType: 'image/png',
          width: 1,
          height: 1,
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
          uri: 'metallic-roughness.png',
          mimeType: 'image/png',
          width: 1,
          height: 1,
          colorSpace: 'linear',
          channelPacking: 'gltf_metallic_roughness',
        },
      ],
      anchors: AircraftAnchorId.options.map((id) => ({ id, nodeName: anchorNodeName(id) })),
      lightSockets: [],
      gearState: 'extended',
      lods: [
        { level: 0, nodeName: 'lod0', triangleCount: 6 },
        { level: 1, nodeName: 'lod1', triangleCount: 2 },
        { level: 2, nodeName: 'lod2', triangleCount: 1 },
      ],
      fallback: { kind: 'fleet_render', assetId: isA320 ? 'a320neo-1440' : 'a220-300-1440' },
      budget: {
        profile: 'narrowbody',
        drawCalls: 1,
        materialCount: 1,
        textureMemoryBytes: 16,
        boundsM: { width: 30, length: 40, height: 10 },
      },
      featureTags: [],
      contentAudit: {
        neutralBaseCoat: true,
        realWorldAirlineLivery: false,
        trademarkedLogos: [],
        unlicensedLogos: [],
        reviewedBy: 'Tailfin test suite',
        reviewedAt: '2026-08-25',
      },
    },
    licence: {
      source: 'in_house',
      creatorOrVendor: 'Tailfin test suite',
      productUrl: 'https://example.com/tailfin-test-asset',
      productId: 'fixture-a220',
      licenceName: 'Test fixture licence',
      licenceTextVersion: '1',
      licenceTextSha256: '1'.repeat(64),
      acquisitionDate: '2026-08-25',
      sourceFileSha256,
      permissions: {
        commercialUse: true,
        redistribution: true,
        derivativeWorks: true,
        textureModification: true,
      },
      attribution: null,
      restrictions: [],
      evidenceFiles: [
        { kind: 'proof_of_purchase', fileName: 'purchase.txt', sha256: '2'.repeat(64) },
        { kind: 'licence_text', fileName: 'licence.txt', sha256: '3'.repeat(64) },
        { kind: 'vendor_terms_snapshot', fileName: 'terms.txt', sha256: '4'.repeat(64) },
      ],
    },
  };
  const decision: AircraftOptimisationDecision = {
    format: AIRCRAFT_OPTIMISATION_DECISION_FORMAT,
    formatVersion: AIRCRAFT_OPTIMISATION_DECISION_VERSION,
    sourceFileSha256,
    rendererCompatibilityVersion: 'tailfin-webgl-v1',
    geometry: { mode: 'lossless', evidence: measurement(sourceBytes.byteLength) },
    textures: { mode: 'retain', evidence: measurement(sourceBytes.byteLength) },
    allow: { animations: [], cameras: [], lights: [], metadataOwners: [] },
    budgetException: null,
  };
  const manifestPath = resolve(sourceDirectory, 'manifest.json');
  const decisionPath = resolve(sourceDirectory, 'optimisation.json');
  await writeFile(manifestPath, canonicalJson(manifest));
  await writeFile(decisionPath, canonicalJson(decision));
  return { sourceDirectory, manifestPath, decisionPath, registryRoot, manifest, decision };
}
