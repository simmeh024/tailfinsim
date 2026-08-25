import { describe, expect, it } from 'vitest';

import {
  AIRCRAFT_ASSET_BUDGETS,
  AIRCRAFT_ASSET_COVERAGE_V1,
  AIRCRAFT_ASSET_MANIFEST_FORMAT,
  AIRCRAFT_ASSET_MANIFEST_VERSION,
  AIRCRAFT_CATALOGUE_V1,
  AIRCRAFT_PILOT_ASSET_REQUIREMENTS_V1,
  AircraftAnchorId,
  AircraftAssetManifest,
  aircraftAssetManifestJsonSchema,
  deriveAircraftAssetCoverage,
  evaluateAircraftAssetSubmission,
  liveryAssetBindingFromManifest,
} from './index';

const MODEL_SHA = 'a'.repeat(64);

function validA320neoSubmission() {
  const anchors = AircraftAnchorId.options.map((id) => ({ id, nodeName: `anchor_${id}` }));
  const nodeNames = [
    'aircraft_root',
    'lod0',
    'lod1',
    'lod2',
    ...anchors.map((anchor) => anchor.nodeName),
  ];
  const materials = [
    { materialName: 'paint_fuselage', kind: 'paintable', class: 'fuselage' },
    { materialName: 'paint_fin', kind: 'paintable', class: 'fin' },
    {
      materialName: 'paint_stabilisers',
      kind: 'paintable',
      class: 'horizontal_stabilisers',
    },
    { materialName: 'paint_wings', kind: 'paintable', class: 'wings' },
    { materialName: 'paint_winglets', kind: 'paintable', class: 'winglets' },
    { materialName: 'paint_nacelles', kind: 'paintable', class: 'nacelle_exteriors' },
    { materialName: 'glass_cockpit', kind: 'protected', class: 'cockpit_glass' },
    { materialName: 'glass_cabin', kind: 'protected', class: 'cabin_windows' },
    { materialName: 'metal_exposed', kind: 'protected', class: 'exposed_metal' },
    { materialName: 'rubber_tyres', kind: 'protected', class: 'rubber_tyres' },
    { materialName: 'lights', kind: 'protected', class: 'lights' },
    { materialName: 'engine_interiors', kind: 'protected', class: 'engine_interiors' },
  ] as const;

  return {
    format: AIRCRAFT_ASSET_MANIFEST_FORMAT,
    formatVersion: AIRCRAFT_ASSET_MANIFEST_VERSION,
    technical: {
      identity: {
        assetId: 'aircraft/a320neo',
        assetVersion: '1.0.0',
        catalogueVersion: 'v1',
        family: 'A320neo',
        geometryVariantId: 'a320neo',
        designations: ['A320neo'],
      },
      delivery: {
        filePath: 'models/a320neo.glb',
        mimeType: 'model/gltf-binary',
        gltfVersion: '2.0',
        byteSize: 12_000_000,
        fileSha256: MODEL_SHA,
        units: 'metres',
        upAxis: '+Y',
        forwardAxis: '-Z',
        origin: 'ground-centre',
        transformsBaked: true,
      },
      naming: {
        convention: 'tailfin-aircraft-v1',
        rootNode: 'aircraft_root',
        nodeNames,
        meshNames: ['mesh_aircraft'],
      },
      liveryUv: {
        resource: { id: 'livery-uv/a320neo', version: '1.0.0' },
        texCoord: 'TEXCOORD_1',
        normalized: true,
        nonOverlappingPaintableIslands: true,
        paddingPxAt4096: 16,
        mirroredIslands: [],
      },
      bindingResources: {
        materialBinding: { id: 'materials/a320neo', version: '1.0.0' },
        anchorSet: { id: 'anchors/a320neo', version: '1.0.0' },
      },
      materials,
      pbrTextures: [
        {
          kind: 'base_color',
          uri: 'textures/base-color.ktx2',
          mimeType: 'image/ktx2',
          width: 4096,
          height: 4096,
          colorSpace: 'srgb',
          channelPacking: 'rgba',
        },
        {
          kind: 'normal',
          uri: 'textures/normal.ktx2',
          mimeType: 'image/ktx2',
          width: 4096,
          height: 4096,
          colorSpace: 'linear',
          channelPacking: 'normal_xy',
        },
        {
          kind: 'metallic_roughness',
          uri: 'textures/metallic-roughness.ktx2',
          mimeType: 'image/ktx2',
          width: 4096,
          height: 4096,
          colorSpace: 'linear',
          channelPacking: 'gltf_metallic_roughness',
        },
      ],
      anchors,
      lightSockets: [],
      gearState: 'extended',
      lods: [
        { level: 0, nodeName: 'lod0', triangleCount: 180_000 },
        { level: 1, nodeName: 'lod1', triangleCount: 80_000 },
        { level: 2, nodeName: 'lod2', triangleCount: 30_000 },
      ],
      fallback: { kind: 'fleet_render', assetId: 'fleet-render/a320neo' },
      budget: {
        profile: 'narrowbody',
        drawCalls: 20,
        materialCount: materials.length,
        textureMemoryBytes: 96 * 1_024 * 1_024,
        boundsM: { width: 35.8, length: 37.6, height: 12 },
      },
      featureTags: ['underwing-turbofans', 'sharklets', 'narrowbody-doors'],
      contentAudit: {
        neutralBaseCoat: true,
        realWorldAirlineLivery: false,
        trademarkedLogos: [],
        unlicensedLogos: [],
        reviewedBy: 'asset-intake@example.invalid',
        reviewedAt: '2026-08-25',
      },
    },
    licence: {
      source: 'marketplace',
      creatorOrVendor: 'Example asset vendor',
      productUrl: 'https://assets.example.invalid/products/a320neo',
      productId: 'example-a320neo-001',
      licenceName: 'Example commercial asset licence',
      licenceTextVersion: '2026-01',
      licenceTextSha256: 'b'.repeat(64),
      acquisitionDate: '2026-08-25',
      sourceFileSha256: MODEL_SHA,
      permissions: {
        commercialUse: true,
        redistribution: true,
        derivativeWorks: true,
        textureModification: true,
      },
      attribution: null,
      restrictions: [],
      evidenceFiles: [
        { kind: 'proof_of_purchase', fileName: 'receipt.pdf', sha256: 'c'.repeat(64) },
        { kind: 'licence_text', fileName: 'licence.pdf', sha256: 'd'.repeat(64) },
        { kind: 'vendor_terms_snapshot', fileName: 'terms.pdf', sha256: 'e'.repeat(64) },
      ],
    },
  } as const;
}

describe('licensed 3D aircraft asset manifest', () => {
  it('accepts a complete technical and provenance fixture through one shared schema', () => {
    const fixture = validA320neoSubmission();
    expect(AircraftAssetManifest.safeParse(fixture).success).toBe(true);
    expect(evaluateAircraftAssetSubmission(fixture)).toMatchObject({ status: 'accepted' });
    expect(aircraftAssetManifestJsonSchema).toMatchObject({
      type: 'object',
      properties: {
        format: { const: AIRCRAFT_ASSET_MANIFEST_FORMAT },
        formatVersion: { const: AIRCRAFT_ASSET_MANIFEST_VERSION },
      },
    });
  });

  it('reports an invalid model before it considers licence evidence', () => {
    const fixture = validA320neoSubmission();
    const invalid = {
      ...fixture,
      technical: {
        ...fixture.technical,
        delivery: { ...fixture.technical.delivery, units: 'centimetres' },
      },
      licence: undefined,
    };

    expect(evaluateAircraftAssetSubmission(invalid)).toMatchObject({ status: 'invalid_model' });
  });

  it('does not treat the words Pro licence as distributable evidence', () => {
    const fixture = validA320neoSubmission();
    const result = evaluateAircraftAssetSubmission({
      ...fixture,
      licence: { licenceName: 'Pro licence' },
    });

    expect(result.status).toBe('missing_licence_evidence');
  });

  it('keeps missing evidence distinct from rights that explicitly block distribution', () => {
    const fixture = validA320neoSubmission();
    const missingEvidence = {
      ...fixture,
      licence: { ...fixture.licence, evidenceFiles: fixture.licence.evidenceFiles.slice(0, 1) },
    };
    expect(evaluateAircraftAssetSubmission(missingEvidence).status).toBe(
      'missing_licence_evidence',
    );

    const blocked = {
      ...fixture,
      licence: {
        ...fixture.licence,
        permissions: { ...fixture.licence.permissions, redistribution: false },
      },
    };
    expect(evaluateAircraftAssetSubmission(blocked)).toMatchObject({
      status: 'distribution_blocked',
      issues: [{ code: 'licence_permission_denied' }],
    });
  });

  it('blocks embedded airline trade dress, trademarks and unlicensed logos', () => {
    const fixture = validA320neoSubmission();
    const result = evaluateAircraftAssetSubmission({
      ...fixture,
      technical: {
        ...fixture.technical,
        contentAudit: {
          ...fixture.technical.contentAudit,
          neutralBaseCoat: false,
          realWorldAirlineLivery: true,
          trademarkedLogos: ['Example aircraft maker mark'],
          unlicensedLogos: ['Example airline tail mark'],
        },
      },
    });

    expect(result.status).toBe('distribution_blocked');
    if (result.status !== 'distribution_blocked') throw new Error('expected blocked fixture');
    expect(result.issues.map((entry) => entry.code)).toEqual([
      'non_neutral_base',
      'embedded_airline_livery',
      'trademarked_logo',
      'unlicensed_logo',
    ]);
  });

  it('binds v2 liveries to all four exact manifest resources', () => {
    const manifest = AircraftAssetManifest.parse(validA320neoSubmission());
    const first = liveryAssetBindingFromManifest(manifest, 'a320neo-v1');
    const replacement = AircraftAssetManifest.parse({
      ...manifest,
      technical: {
        ...manifest.technical,
        identity: { ...manifest.technical.identity, assetVersion: '2.0.0' },
      },
    });
    const second = liveryAssetBindingFromManifest(replacement, 'a320neo-v2');

    expect(first).toEqual({
      compatibilityId: 'a320neo-v1',
      aircraftAsset: { id: 'aircraft/a320neo', version: '1.0.0' },
      liveryUv: { id: 'livery-uv/a320neo', version: '1.0.0' },
      materialBinding: { id: 'materials/a320neo', version: '1.0.0' },
      anchorSet: { id: 'anchors/a320neo', version: '1.0.0' },
    });
    expect(second.aircraftAsset.version).toBe('2.0.0');
    expect(second).not.toEqual(first);
  });

  it('rejects renderer payloads and budget, LOD, UV and PBR contract violations', () => {
    const fixture = validA320neoSubmission();
    expect(
      AircraftAssetManifest.safeParse({ ...fixture, embeddedGlb: 'base64-data' }).success,
    ).toBe(false);

    const invalid = {
      ...fixture,
      technical: {
        ...fixture.technical,
        liveryUv: { ...fixture.technical.liveryUv, nonOverlappingPaintableIslands: false },
        pbrTextures: fixture.technical.pbrTextures.slice(0, 1),
        lods: [
          { level: 0, nodeName: 'lod0', triangleCount: 500_000 },
          { level: 1, nodeName: 'lod1', triangleCount: 400_000 },
          { level: 2, nodeName: 'lod2', triangleCount: 300_000 },
        ],
      },
    };
    expect(evaluateAircraftAssetSubmission(invalid).status).toBe('invalid_model');
  });
});

describe('catalogue-derived aircraft asset coverage', () => {
  it('derives all 18 rows in canonical catalogue order without a second aircraft list', () => {
    expect(AIRCRAFT_ASSET_COVERAGE_V1).toHaveLength(18);
    expect(AIRCRAFT_ASSET_COVERAGE_V1.map((row) => row.designation)).toEqual(
      AIRCRAFT_CATALOGUE_V1.types.map((type) => type.designation),
    );
    expect(AIRCRAFT_ASSET_COVERAGE_V1.map((row) => row.family)).toEqual(
      AIRCRAFT_CATALOGUE_V1.types.map((type) => type.family),
    );
    expect(() => deriveAircraftAssetCoverage(AIRCRAFT_CATALOGUE_V1, {})).toThrow(
      /missing ATR 72-600/,
    );
  });

  it('distinguishes exact family reuse from geometry-changing variants', () => {
    const byDesignation = new Map(AIRCRAFT_ASSET_COVERAGE_V1.map((row) => [row.designation, row]));
    expect(byDesignation.get('A321XLR')).toMatchObject({
      relation: 'family_reuse',
      geometryVariantId: 'a321neo',
      basedOnDesignation: 'A321neo',
    });
    expect(byDesignation.get('A321neo')).toMatchObject({
      relation: 'geometry_variant',
      basedOnDesignation: 'A320neo',
    });
    expect(byDesignation.get('ATR 72-600F')).toMatchObject({
      relation: 'geometry_variant',
      basedOnDesignation: 'ATR 72-600',
    });
  });

  it('records the ATR 72, A320neo and 787 pilots individually', () => {
    expect(AIRCRAFT_PILOT_ASSET_REQUIREMENTS_V1.map((pilot) => pilot.designation)).toEqual([
      'ATR 72-600',
      'A320neo',
      '787-9',
    ]);
    expect(
      AIRCRAFT_ASSET_COVERAGE_V1.filter((row) => row.pilotRequirementId !== null).map(
        (row) => row.designation,
      ),
    ).toEqual(['ATR 72-600', 'A320neo', '787-9']);
    expect(AIRCRAFT_ASSET_BUDGETS.regional.maxLod0Triangles).toBeLessThan(
      AIRCRAFT_ASSET_BUDGETS.widebody.maxLod0Triangles,
    );
  });
});
