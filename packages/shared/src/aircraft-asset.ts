import { z } from 'zod';

import {
  AIRCRAFT_CATALOGUE_V1,
  AIRCRAFT_CATALOGUE_V1_VERSION,
  type AircraftCatalogue,
} from './aircraft-catalogue';
import {
  LiveryAssetBinding,
  LiveryResourceId,
  LiveryResourceVersion,
  type LiveryAssetBinding as LiveryAssetBindingValue,
} from './livery';

export const AIRCRAFT_ASSET_MANIFEST_FORMAT = 'tailfin-aircraft-asset' as const;
export const AIRCRAFT_ASSET_MANIFEST_VERSION = 1 as const;

export const AircraftAssetSha256 = z
  .string()
  .regex(/^[a-f0-9]{64}$/, 'must be a lowercase SHA-256 digest');
export type AircraftAssetSha256 = z.infer<typeof AircraftAssetSha256>;

const UniqueResourceIds = z
  .array(LiveryResourceId)
  .min(1)
  .superRefine((ids, context) => {
    const seen = new Set<string>();
    for (const [index, id] of ids.entries()) {
      if (seen.has(id)) {
        context.addIssue({ code: 'custom', path: [index], message: `duplicate id "${id}"` });
      }
      seen.add(id);
    }
  });

export const AircraftAssetBudgetProfile = z.enum([
  'regional',
  'narrowbody',
  'widebody',
  'very_large',
]);
export type AircraftAssetBudgetProfile = z.infer<typeof AircraftAssetBudgetProfile>;

export const AircraftAssetBudget = z
  .object({
    maxLod0Triangles: z.number().int().positive(),
    maxDrawCalls: z.number().int().positive(),
    maxMaterials: z.number().int().positive(),
    maxTextureMemoryBytes: z.number().int().positive(),
    maxBoundsM: z
      .object({
        width: z.number().positive(),
        length: z.number().positive(),
        height: z.number().positive(),
      })
      .strict(),
  })
  .strict();
export type AircraftAssetBudget = z.infer<typeof AircraftAssetBudget>;

/** Intake ceilings, not targets. Optimisation may and should beat them. */
export const AIRCRAFT_ASSET_BUDGETS: Readonly<
  Record<AircraftAssetBudgetProfile, AircraftAssetBudget>
> = {
  regional: {
    maxLod0Triangles: 180_000,
    maxDrawCalls: 22,
    maxMaterials: 14,
    maxTextureMemoryBytes: 128 * 1_024 * 1_024,
    maxBoundsM: { width: 40, length: 45, height: 15 },
  },
  narrowbody: {
    maxLod0Triangles: 260_000,
    maxDrawCalls: 28,
    maxMaterials: 18,
    maxTextureMemoryBytes: 192 * 1_024 * 1_024,
    maxBoundsM: { width: 45, length: 80, height: 18 },
  },
  widebody: {
    maxLod0Triangles: 420_000,
    maxDrawCalls: 36,
    maxMaterials: 24,
    maxTextureMemoryBytes: 256 * 1_024 * 1_024,
    maxBoundsM: { width: 90, length: 100, height: 25 },
  },
  very_large: {
    maxLod0Triangles: 560_000,
    maxDrawCalls: 44,
    maxMaterials: 28,
    maxTextureMemoryBytes: 384 * 1_024 * 1_024,
    maxBoundsM: { width: 105, length: 110, height: 30 },
  },
};

export const AircraftPaintableMaterialClass = z.enum([
  'fuselage',
  'fin',
  'horizontal_stabilisers',
  'wings',
  'winglets',
  'nacelle_exteriors',
]);
export type AircraftPaintableMaterialClass = z.infer<typeof AircraftPaintableMaterialClass>;

export const AircraftProtectedMaterialClass = z.enum([
  'cockpit_glass',
  'cabin_windows',
  'exposed_metal',
  'rubber_tyres',
  'lights',
  'propellers',
  'engine_interiors',
]);
export type AircraftProtectedMaterialClass = z.infer<typeof AircraftProtectedMaterialClass>;

export const AircraftMaterialBinding = z.discriminatedUnion('kind', [
  z
    .object({
      materialName: LiveryResourceId,
      kind: z.literal('paintable'),
      class: AircraftPaintableMaterialClass,
    })
    .strict(),
  z
    .object({
      materialName: LiveryResourceId,
      kind: z.literal('protected'),
      class: AircraftProtectedMaterialClass,
    })
    .strict(),
]);
export type AircraftMaterialBinding = z.infer<typeof AircraftMaterialBinding>;

export const AircraftPbrTexture = z
  .object({
    kind: z.enum(['base_color', 'normal', 'metallic_roughness', 'occlusion', 'emissive']),
    uri: z
      .string()
      .min(1)
      .max(160)
      .regex(
        /^(?![a-z]+:)(?!\/)(?!.*\.\.\/).+\.(?:png|jpe?g|ktx2)$/i,
        'must be a relative texture file',
      ),
    mimeType: z.enum(['image/png', 'image/jpeg', 'image/ktx2']),
    width: z.number().int().positive().max(8_192),
    height: z.number().int().positive().max(8_192),
    colorSpace: z.enum(['srgb', 'linear']),
    channelPacking: z.enum([
      'rgba',
      'normal_xy',
      'gltf_metallic_roughness',
      'occlusion_r',
      'emissive_rgb',
    ]),
  })
  .strict()
  .superRefine((texture, context) => {
    const expectedColorSpace =
      texture.kind === 'base_color' || texture.kind === 'emissive' ? 'srgb' : 'linear';
    if (texture.colorSpace !== expectedColorSpace) {
      context.addIssue({
        code: 'custom',
        path: ['colorSpace'],
        message: `${texture.kind} textures must use ${expectedColorSpace}`,
      });
    }

    const expectedPacking = {
      base_color: 'rgba',
      normal: 'normal_xy',
      metallic_roughness: 'gltf_metallic_roughness',
      occlusion: 'occlusion_r',
      emissive: 'emissive_rgb',
    } as const;
    if (texture.channelPacking !== expectedPacking[texture.kind]) {
      context.addIssue({
        code: 'custom',
        path: ['channelPacking'],
        message: `${texture.kind} uses ${expectedPacking[texture.kind]} packing`,
      });
    }
  });
export type AircraftPbrTexture = z.infer<typeof AircraftPbrTexture>;

export const AircraftLiveryUv = z
  .object({
    resource: z.object({ id: LiveryResourceId, version: LiveryResourceVersion }).strict(),
    texCoord: z.literal('TEXCOORD_1'),
    normalized: z.literal(true),
    nonOverlappingPaintableIslands: z.literal(true),
    paddingPxAt4096: z.number().int().min(8).max(128),
    mirroredIslands: z
      .array(
        z
          .object({
            islandId: LiveryResourceId,
            surfaces: z.array(AircraftPaintableMaterialClass).min(1),
            sourceSide: z.enum(['port', 'starboard']),
            targetSide: z.enum(['port', 'starboard']),
          })
          .strict()
          .refine((island) => island.sourceSide !== island.targetSide, {
            message: 'a mirrored island must map one side to the other',
            path: ['targetSide'],
          }),
      )
      .max(32),
  })
  .strict();
export type AircraftLiveryUv = z.infer<typeof AircraftLiveryUv>;

export const AircraftAnchorId = z.enum([
  'camera_three_quarter',
  'camera_side',
  'camera_top',
  'rotation_center',
  'ground_contact',
  'registration_port',
  'registration_starboard',
  'tail_logo_port',
  'tail_logo_starboard',
]);
export type AircraftAnchorId = z.infer<typeof AircraftAnchorId>;

export const AircraftLightSocketId = z.enum([
  'navigation_port',
  'navigation_starboard',
  'beacon_upper',
  'beacon_lower',
  'landing_port',
  'landing_starboard',
]);
export type AircraftLightSocketId = z.infer<typeof AircraftLightSocketId>;

const NodeBinding = z
  .object({
    id: AircraftAnchorId,
    nodeName: LiveryResourceId,
  })
  .strict();

const LightSocketBinding = z
  .object({
    id: AircraftLightSocketId,
    nodeName: LiveryResourceId,
  })
  .strict();

export const AircraftAssetLod = z
  .object({
    level: z.union([z.literal(0), z.literal(1), z.literal(2)]),
    nodeName: LiveryResourceId,
    triangleCount: z.number().int().positive(),
  })
  .strict();
export type AircraftAssetLod = z.infer<typeof AircraftAssetLod>;

export const AircraftAssetTechnicalManifest = z
  .object({
    identity: z
      .object({
        assetId: LiveryResourceId,
        assetVersion: LiveryResourceVersion,
        catalogueVersion: z.string().min(1).max(32),
        family: z.string().trim().min(1).max(64),
        geometryVariantId: LiveryResourceId,
        designations: z.array(z.string().trim().min(1).max(64)).min(1).max(8),
      })
      .strict(),
    delivery: z
      .object({
        filePath: z
          .string()
          .min(5)
          .max(180)
          .regex(/^(?![a-z]+:)(?!\/)(?!.*\.\.\/).+\.glb$/i, 'must be a relative .glb path'),
        mimeType: z.literal('model/gltf-binary'),
        gltfVersion: z.literal('2.0'),
        byteSize: z.number().int().positive(),
        fileSha256: AircraftAssetSha256,
        units: z.literal('metres'),
        upAxis: z.literal('+Y'),
        forwardAxis: z.literal('-Z'),
        origin: z.literal('ground-centre'),
        transformsBaked: z.literal(true),
      })
      .strict(),
    naming: z
      .object({
        convention: z.literal('tailfin-aircraft-v1'),
        rootNode: LiveryResourceId,
        nodeNames: UniqueResourceIds,
        meshNames: UniqueResourceIds,
      })
      .strict(),
    liveryUv: AircraftLiveryUv,
    bindingResources: z
      .object({
        materialBinding: z
          .object({ id: LiveryResourceId, version: LiveryResourceVersion })
          .strict(),
        anchorSet: z.object({ id: LiveryResourceId, version: LiveryResourceVersion }).strict(),
      })
      .strict(),
    materials: z.array(AircraftMaterialBinding).min(1).max(64),
    pbrTextures: z.array(AircraftPbrTexture).min(1).max(32),
    anchors: z.array(NodeBinding).length(AircraftAnchorId.options.length),
    lightSockets: z.array(LightSocketBinding).max(AircraftLightSocketId.options.length),
    gearState: z.enum(['extended', 'retracted']),
    lods: z.array(AircraftAssetLod).length(3),
    fallback: z
      .object({
        kind: z.literal('fleet_render'),
        assetId: LiveryResourceId,
      })
      .strict(),
    budget: z
      .object({
        profile: AircraftAssetBudgetProfile,
        drawCalls: z.number().int().positive(),
        materialCount: z.number().int().positive(),
        textureMemoryBytes: z.number().int().nonnegative(),
        boundsM: z
          .object({
            width: z.number().positive(),
            length: z.number().positive(),
            height: z.number().positive(),
          })
          .strict(),
      })
      .strict(),
    featureTags: z.array(LiveryResourceId).max(64),
    contentAudit: z
      .object({
        neutralBaseCoat: z.boolean(),
        realWorldAirlineLivery: z.boolean(),
        trademarkedLogos: z.array(z.string().trim().min(1).max(120)).max(32),
        unlicensedLogos: z.array(z.string().trim().min(1).max(120)).max(32),
        reviewedBy: z.string().trim().min(1).max(120),
        reviewedAt: z.iso.date(),
      })
      .strict(),
  })
  .strict()
  .superRefine((manifest, context) => {
    const designations = new Set(manifest.identity.designations);
    if (designations.size !== manifest.identity.designations.length) {
      context.addIssue({
        code: 'custom',
        path: ['identity', 'designations'],
        message: 'designations must be unique',
      });
    }

    if (!manifest.naming.nodeNames.includes(manifest.naming.rootNode)) {
      context.addIssue({
        code: 'custom',
        path: ['naming', 'rootNode'],
        message: 'rootNode must occur in nodeNames',
      });
    }

    const materialNames = new Set<string>();
    let paintableCount = 0;
    for (const [index, binding] of manifest.materials.entries()) {
      if (materialNames.has(binding.materialName)) {
        context.addIssue({
          code: 'custom',
          path: ['materials', index, 'materialName'],
          message: `duplicate material binding "${binding.materialName}"`,
        });
      }
      materialNames.add(binding.materialName);
      if (binding.kind === 'paintable') paintableCount += 1;
    }
    if (paintableCount === 0) {
      context.addIssue({
        code: 'custom',
        path: ['materials'],
        message: 'at least one paintable material is required',
      });
    }
    if (manifest.budget.materialCount !== materialNames.size) {
      context.addIssue({
        code: 'custom',
        path: ['budget', 'materialCount'],
        message: 'materialCount must equal the number of unique material bindings',
      });
    }

    const textureKinds = new Set<string>();
    for (const [index, texture] of manifest.pbrTextures.entries()) {
      if (textureKinds.has(texture.kind)) {
        context.addIssue({
          code: 'custom',
          path: ['pbrTextures', index, 'kind'],
          message: `duplicate ${texture.kind} texture`,
        });
      }
      textureKinds.add(texture.kind);
    }
    for (const requiredTexture of ['base_color', 'normal', 'metallic_roughness']) {
      if (!textureKinds.has(requiredTexture)) {
        context.addIssue({
          code: 'custom',
          path: ['pbrTextures'],
          message: `missing required ${requiredTexture} texture`,
        });
      }
    }

    const anchorIds = new Set<string>();
    for (const [index, anchor] of manifest.anchors.entries()) {
      if (anchorIds.has(anchor.id)) {
        context.addIssue({
          code: 'custom',
          path: ['anchors', index, 'id'],
          message: `duplicate anchor "${anchor.id}"`,
        });
      }
      anchorIds.add(anchor.id);
      if (!manifest.naming.nodeNames.includes(anchor.nodeName)) {
        context.addIssue({
          code: 'custom',
          path: ['anchors', index, 'nodeName'],
          message: 'anchor node must occur in nodeNames',
        });
      }
    }
    for (const requiredAnchor of AircraftAnchorId.options) {
      if (!anchorIds.has(requiredAnchor)) {
        context.addIssue({
          code: 'custom',
          path: ['anchors'],
          message: `missing required anchor "${requiredAnchor}"`,
        });
      }
    }

    const lightIds = new Set<string>();
    for (const [index, socket] of manifest.lightSockets.entries()) {
      if (lightIds.has(socket.id)) {
        context.addIssue({
          code: 'custom',
          path: ['lightSockets', index, 'id'],
          message: `duplicate light socket "${socket.id}"`,
        });
      }
      lightIds.add(socket.id);
      if (!manifest.naming.nodeNames.includes(socket.nodeName)) {
        context.addIssue({
          code: 'custom',
          path: ['lightSockets', index, 'nodeName'],
          message: 'light-socket node must occur in nodeNames',
        });
      }
    }

    const lods = new Map(manifest.lods.map((lod) => [lod.level, lod]));
    for (const [index, lod] of manifest.lods.entries()) {
      if (!manifest.naming.nodeNames.includes(lod.nodeName)) {
        context.addIssue({
          code: 'custom',
          path: ['lods', index, 'nodeName'],
          message: 'LOD node must occur in nodeNames',
        });
      }
    }
    for (const level of [0, 1, 2] as const) {
      if (!lods.has(level)) {
        context.addIssue({
          code: 'custom',
          path: ['lods'],
          message: `missing LOD${String(level)}`,
        });
      }
    }
    const lod0 = lods.get(0);
    const lod1 = lods.get(1);
    const lod2 = lods.get(2);
    if (lod0 && lod1 && lod1.triangleCount > lod0.triangleCount * 0.5) {
      context.addIssue({
        code: 'custom',
        path: ['lods'],
        message: 'LOD1 must be at most 50% of LOD0 triangles',
      });
    }
    if (lod0 && lod2 && lod2.triangleCount > lod0.triangleCount * 0.2) {
      context.addIssue({
        code: 'custom',
        path: ['lods'],
        message: 'LOD2 must be at most 20% of LOD0 triangles',
      });
    }

    const budget = AIRCRAFT_ASSET_BUDGETS[manifest.budget.profile];
    if (lod0 && lod0.triangleCount > budget.maxLod0Triangles) {
      context.addIssue({
        code: 'custom',
        path: ['lods'],
        message: 'LOD0 exceeds its triangle budget',
      });
    }
    if (manifest.budget.drawCalls > budget.maxDrawCalls) {
      context.addIssue({
        code: 'custom',
        path: ['budget', 'drawCalls'],
        message: 'draw calls exceed the profile budget',
      });
    }
    if (manifest.budget.materialCount > budget.maxMaterials) {
      context.addIssue({
        code: 'custom',
        path: ['budget', 'materialCount'],
        message: 'materials exceed the profile budget',
      });
    }
    if (manifest.budget.textureMemoryBytes > budget.maxTextureMemoryBytes) {
      context.addIssue({
        code: 'custom',
        path: ['budget', 'textureMemoryBytes'],
        message: 'texture memory exceeds the profile budget',
      });
    }
    for (const dimension of ['width', 'length', 'height'] as const) {
      if (manifest.budget.boundsM[dimension] > budget.maxBoundsM[dimension]) {
        context.addIssue({
          code: 'custom',
          path: ['budget', 'boundsM', dimension],
          message: `${dimension} exceeds the profile bounding-box budget`,
        });
      }
    }
  });
export type AircraftAssetTechnicalManifest = z.infer<typeof AircraftAssetTechnicalManifest>;

export const AircraftAssetLicenceEvidence = z
  .object({
    source: z.enum(['marketplace', 'direct_vendor', 'commissioned', 'in_house']),
    creatorOrVendor: z.string().trim().min(1).max(160),
    productUrl: z.url(),
    productId: z.string().trim().min(1).max(160),
    licenceName: z.string().trim().min(1).max(160),
    licenceTextVersion: z.string().trim().min(1).max(80),
    licenceTextSha256: AircraftAssetSha256,
    acquisitionDate: z.iso.date(),
    sourceFileSha256: AircraftAssetSha256,
    permissions: z
      .object({
        commercialUse: z.boolean(),
        redistribution: z.boolean(),
        derivativeWorks: z.boolean(),
        textureModification: z.boolean(),
      })
      .strict(),
    attribution: z.string().trim().min(1).max(500).nullable(),
    restrictions: z.array(z.string().trim().min(1).max(500)).max(32),
    evidenceFiles: z
      .array(
        z
          .object({
            kind: z.enum(['proof_of_purchase', 'licence_text', 'vendor_terms_snapshot']),
            fileName: z.string().trim().min(1).max(180),
            sha256: AircraftAssetSha256,
          })
          .strict(),
      )
      .min(1)
      .max(16),
  })
  .strict();
export type AircraftAssetLicenceEvidence = z.infer<typeof AircraftAssetLicenceEvidence>;

export const AircraftAssetManifest = z
  .object({
    format: z.literal(AIRCRAFT_ASSET_MANIFEST_FORMAT),
    formatVersion: z.literal(AIRCRAFT_ASSET_MANIFEST_VERSION),
    technical: AircraftAssetTechnicalManifest,
    licence: AircraftAssetLicenceEvidence,
  })
  .strict();
export type AircraftAssetManifest = z.infer<typeof AircraftAssetManifest>;

/** The exact tuple a v2 livery publishes; no resource is resolved through `latest`. */
export function liveryAssetBindingFromManifest(
  manifest: AircraftAssetManifest,
  compatibilityId: string,
): LiveryAssetBindingValue {
  return LiveryAssetBinding.parse({
    compatibilityId,
    aircraftAsset: {
      id: manifest.technical.identity.assetId,
      version: manifest.technical.identity.assetVersion,
    },
    liveryUv: manifest.technical.liveryUv.resource,
    materialBinding: manifest.technical.bindingResources.materialBinding,
    anchorSet: manifest.technical.bindingResources.anchorSet,
  });
}

export const AircraftAssetGeometryRelation = z.enum([
  'family_baseline',
  'family_reuse',
  'geometry_variant',
]);
export type AircraftAssetGeometryRelation = z.infer<typeof AircraftAssetGeometryRelation>;

export const AircraftAssetGeometryDecision = z
  .object({
    geometryVariantId: LiveryResourceId,
    relation: AircraftAssetGeometryRelation,
    basedOnDesignation: z.string().min(1).nullable(),
    budgetProfile: AircraftAssetBudgetProfile,
    pilotRequirementId: LiveryResourceId.nullable(),
  })
  .strict();
export type AircraftAssetGeometryDecision = z.infer<typeof AircraftAssetGeometryDecision>;

export const AircraftAssetCoverageRow = z
  .object({
    catalogueVersion: z.string().min(1),
    designation: z.string().min(1),
    family: z.string().min(1),
    geometryVariantId: LiveryResourceId,
    relation: AircraftAssetGeometryRelation,
    basedOnDesignation: z.string().min(1).nullable(),
    budgetProfile: AircraftAssetBudgetProfile,
    pilotRequirementId: LiveryResourceId.nullable(),
  })
  .strict();
export type AircraftAssetCoverageRow = z.infer<typeof AircraftAssetCoverageRow>;

export const AircraftPilotAssetRequirement = z
  .object({
    id: LiveryResourceId,
    designation: z.string().min(1),
    purpose: z.string().trim().min(1).max(500),
    requiredFeatureTags: z.array(LiveryResourceId).min(1).max(32),
    requiredPaintableClasses: z.array(AircraftPaintableMaterialClass).min(1),
    requiredProtectedClasses: z.array(AircraftProtectedMaterialClass).min(1),
  })
  .strict();
export type AircraftPilotAssetRequirement = z.infer<typeof AircraftPilotAssetRequirement>;

export const AIRCRAFT_PILOT_ASSET_REQUIREMENTS_V1: readonly AircraftPilotAssetRequirement[] = z
  .array(AircraftPilotAssetRequirement)
  .length(3)
  .parse([
    {
      id: 'pilot/atr-72-600',
      designation: 'ATR 72-600',
      purpose:
        'Prove high-wing turboprop materials, propeller protection, gear pods and tail registration anchors.',
      requiredFeatureTags: ['high-wing', 'six-blade-propellers', 'gear-pods', 't-tail'],
      requiredPaintableClasses: [
        'fuselage',
        'fin',
        'horizontal_stabilisers',
        'wings',
        'nacelle_exteriors',
      ],
      requiredProtectedClasses: [
        'cockpit_glass',
        'cabin_windows',
        'rubber_tyres',
        'lights',
        'propellers',
      ],
    },
    {
      id: 'pilot/a320neo',
      designation: 'A320neo',
      purpose:
        'Prove the common narrowbody workflow, sharklet UV continuity and separate paintable nacelle exteriors.',
      requiredFeatureTags: ['underwing-turbofans', 'sharklets', 'narrowbody-doors'],
      requiredPaintableClasses: [
        'fuselage',
        'fin',
        'horizontal_stabilisers',
        'wings',
        'winglets',
        'nacelle_exteriors',
      ],
      requiredProtectedClasses: [
        'cockpit_glass',
        'cabin_windows',
        'rubber_tyres',
        'lights',
        'engine_interiors',
      ],
    },
    {
      id: 'pilot/787-9',
      designation: '787-9',
      purpose:
        'Prove widebody scale, raked-wing framing, chevron engine materials and higher texture/LOD budgets.',
      requiredFeatureTags: [
        'raked-wingtips',
        'chevron-nacelles',
        'widebody-doors',
        'wing-flex-neutral',
      ],
      requiredPaintableClasses: [
        'fuselage',
        'fin',
        'horizontal_stabilisers',
        'wings',
        'nacelle_exteriors',
      ],
      requiredProtectedClasses: [
        'cockpit_glass',
        'cabin_windows',
        'exposed_metal',
        'rubber_tyres',
        'lights',
        'engine_interiors',
      ],
    },
  ]);

const V1_GEOMETRY_DECISIONS: Readonly<Record<string, AircraftAssetGeometryDecision>> = {
  'ATR 72-600': {
    geometryVariantId: 'atr-72-600',
    relation: 'family_baseline',
    basedOnDesignation: null,
    budgetProfile: 'regional',
    pilotRequirementId: 'pilot/atr-72-600',
  },
  'Dash 8-400': {
    geometryVariantId: 'dash-8-400',
    relation: 'family_baseline',
    basedOnDesignation: null,
    budgetProfile: 'regional',
    pilotRequirementId: null,
  },
  'E190-E2': {
    geometryVariantId: 'e190-e2',
    relation: 'family_baseline',
    basedOnDesignation: null,
    budgetProfile: 'regional',
    pilotRequirementId: null,
  },
  'A220-300': {
    geometryVariantId: 'a220-300',
    relation: 'family_baseline',
    basedOnDesignation: null,
    budgetProfile: 'narrowbody',
    pilotRequirementId: null,
  },
  '737-800': {
    geometryVariantId: '737-800',
    relation: 'family_baseline',
    basedOnDesignation: null,
    budgetProfile: 'narrowbody',
    pilotRequirementId: null,
  },
  '737 MAX 8': {
    geometryVariantId: '737-max-8',
    relation: 'family_baseline',
    basedOnDesignation: null,
    budgetProfile: 'narrowbody',
    pilotRequirementId: null,
  },
  A320neo: {
    geometryVariantId: 'a320neo',
    relation: 'family_baseline',
    basedOnDesignation: null,
    budgetProfile: 'narrowbody',
    pilotRequirementId: 'pilot/a320neo',
  },
  A321neo: {
    geometryVariantId: 'a321neo',
    relation: 'geometry_variant',
    basedOnDesignation: 'A320neo',
    budgetProfile: 'narrowbody',
    pilotRequirementId: null,
  },
  A321XLR: {
    geometryVariantId: 'a321neo',
    relation: 'family_reuse',
    basedOnDesignation: 'A321neo',
    budgetProfile: 'narrowbody',
    pilotRequirementId: null,
  },
  '787-9': {
    geometryVariantId: '787-9',
    relation: 'family_baseline',
    basedOnDesignation: null,
    budgetProfile: 'widebody',
    pilotRequirementId: 'pilot/787-9',
  },
  'A350-900': {
    geometryVariantId: 'a350-900',
    relation: 'family_baseline',
    basedOnDesignation: null,
    budgetProfile: 'widebody',
    pilotRequirementId: null,
  },
  'A350-1000': {
    geometryVariantId: 'a350-1000',
    relation: 'geometry_variant',
    basedOnDesignation: 'A350-900',
    budgetProfile: 'widebody',
    pilotRequirementId: null,
  },
  '777-300ER': {
    geometryVariantId: '777-300er',
    relation: 'family_baseline',
    basedOnDesignation: null,
    budgetProfile: 'widebody',
    pilotRequirementId: null,
  },
  '777-9': {
    geometryVariantId: '777-9',
    relation: 'family_baseline',
    basedOnDesignation: null,
    budgetProfile: 'widebody',
    pilotRequirementId: null,
  },
  'A380-800': {
    geometryVariantId: 'a380-800',
    relation: 'family_baseline',
    basedOnDesignation: null,
    budgetProfile: 'very_large',
    pilotRequirementId: null,
  },
  '777F': {
    geometryVariantId: '777f',
    relation: 'geometry_variant',
    basedOnDesignation: '777-300ER',
    budgetProfile: 'widebody',
    pilotRequirementId: null,
  },
  '747-8F': {
    geometryVariantId: '747-8f',
    relation: 'family_baseline',
    basedOnDesignation: null,
    budgetProfile: 'very_large',
    pilotRequirementId: null,
  },
  'ATR 72-600F': {
    geometryVariantId: 'atr-72-600f',
    relation: 'geometry_variant',
    basedOnDesignation: 'ATR 72-600',
    budgetProfile: 'regional',
    pilotRequirementId: null,
  },
};

export function deriveAircraftAssetCoverage(
  catalogue: AircraftCatalogue,
  decisions: Readonly<Record<string, AircraftAssetGeometryDecision>>,
): readonly AircraftAssetCoverageRow[] {
  const designations = new Set(catalogue.types.map((type) => type.designation));
  const extraDecisions = Object.keys(decisions).filter(
    (designation) => !designations.has(designation),
  );
  if (extraDecisions.length > 0) {
    throw new Error(
      `aircraft asset coverage contains unknown designation(s): ${extraDecisions.join(', ')}`,
    );
  }

  const rows = catalogue.types.map((type) => {
    const decision = decisions[type.designation];
    if (!decision) throw new Error(`aircraft asset coverage is missing ${type.designation}`);
    return AircraftAssetCoverageRow.parse({
      catalogueVersion: catalogue.version,
      designation: type.designation,
      family: type.family,
      ...decision,
    });
  });

  const byDesignation = new Map(rows.map((row) => [row.designation, row]));
  for (const row of rows) {
    if (row.relation === 'family_baseline') {
      if (row.basedOnDesignation !== null) {
        throw new Error(
          `${row.designation} is a family baseline and cannot be based on another designation`,
        );
      }
      continue;
    }

    if (row.basedOnDesignation === null) {
      throw new Error(`${row.designation} must name the family geometry it is based on`);
    }
    const basedOn = byDesignation.get(row.basedOnDesignation);
    if (!basedOn) {
      throw new Error(`${row.designation} is based on an unknown designation`);
    }
    if (basedOn.family !== row.family) {
      throw new Error(`${row.designation} must be based on a designation in family ${row.family}`);
    }
    if (row.relation === 'family_reuse' && basedOn.geometryVariantId !== row.geometryVariantId) {
      throw new Error(`${row.designation} declares reuse but changes geometryVariantId`);
    }
    if (
      row.relation === 'geometry_variant' &&
      basedOn.geometryVariantId === row.geometryVariantId
    ) {
      throw new Error(`${row.designation} declares changed geometry but reuses geometryVariantId`);
    }
  }
  return rows;
}

export const AIRCRAFT_ASSET_COVERAGE_V1 = deriveAircraftAssetCoverage(
  AIRCRAFT_CATALOGUE_V1,
  V1_GEOMETRY_DECISIONS,
);

export const AircraftAssetIntakeIssue = z
  .object({
    code: z.string().min(1),
    path: z.string(),
    message: z.string().min(1),
  })
  .strict();
export type AircraftAssetIntakeIssue = z.infer<typeof AircraftAssetIntakeIssue>;

export const AircraftAssetIntakeResult = z.discriminatedUnion('status', [
  z.object({ status: z.literal('accepted'), manifest: AircraftAssetManifest }).strict(),
  z
    .object({
      status: z.literal('invalid_model'),
      issues: z.array(AircraftAssetIntakeIssue).min(1),
    })
    .strict(),
  z
    .object({
      status: z.literal('missing_licence_evidence'),
      issues: z.array(AircraftAssetIntakeIssue).min(1),
    })
    .strict(),
  z
    .object({
      status: z.literal('distribution_blocked'),
      manifest: AircraftAssetManifest,
      issues: z.array(AircraftAssetIntakeIssue).min(1),
    })
    .strict(),
]);
export type AircraftAssetIntakeResult = z.infer<typeof AircraftAssetIntakeResult>;

const AircraftAssetSubmissionEnvelope = z
  .object({
    format: z.literal(AIRCRAFT_ASSET_MANIFEST_FORMAT),
    formatVersion: z.literal(AIRCRAFT_ASSET_MANIFEST_VERSION),
    technical: z.unknown(),
    licence: z.unknown().optional(),
  })
  .strict();

function zodIssues(error: z.ZodError): AircraftAssetIntakeIssue[] {
  return error.issues.map((issue) => ({
    code: issue.code,
    path: issue.path.join('.'),
    message: issue.message,
  }));
}

function issue(code: string, path: string, message: string): AircraftAssetIntakeIssue {
  return { code, path, message };
}

/** CI's single intake decision: technical invalidity and provenance failure never collapse. */
export function evaluateAircraftAssetSubmission(input: unknown): AircraftAssetIntakeResult {
  const envelope = AircraftAssetSubmissionEnvelope.safeParse(input);
  if (!envelope.success) return { status: 'invalid_model', issues: zodIssues(envelope.error) };

  const technical = AircraftAssetTechnicalManifest.safeParse(envelope.data.technical);
  if (!technical.success) return { status: 'invalid_model', issues: zodIssues(technical.error) };

  const coverageIssues: AircraftAssetIntakeIssue[] = [];
  const coverageByDesignation = new Map(
    AIRCRAFT_ASSET_COVERAGE_V1.map((row) => [row.designation, row]),
  );
  for (const [index, designation] of technical.data.identity.designations.entries()) {
    const coverage = coverageByDesignation.get(designation);
    if (!coverage) {
      coverageIssues.push(
        issue(
          'unknown_designation',
          `technical.identity.designations.${String(index)}`,
          'designation is not in the pinned aircraft catalogue',
        ),
      );
      continue;
    }
    if (
      coverage.catalogueVersion !== technical.data.identity.catalogueVersion ||
      coverage.family !== technical.data.identity.family ||
      coverage.geometryVariantId !== technical.data.identity.geometryVariantId ||
      coverage.budgetProfile !== technical.data.budget.profile
    ) {
      coverageIssues.push(
        issue(
          'coverage_mismatch',
          `technical.identity.designations.${String(index)}`,
          'asset identity does not match the catalogue-derived coverage row',
        ),
      );
    }
  }

  const pilotByDesignation = new Map(
    AIRCRAFT_PILOT_ASSET_REQUIREMENTS_V1.map((requirement) => [
      requirement.designation,
      requirement,
    ]),
  );
  for (const designation of technical.data.identity.designations) {
    const pilot = pilotByDesignation.get(designation);
    if (!pilot) continue;
    const paintable = new Set(
      technical.data.materials
        .filter((binding) => binding.kind === 'paintable')
        .map((binding) => binding.class),
    );
    const protectedMaterials = new Set(
      technical.data.materials
        .filter((binding) => binding.kind === 'protected')
        .map((binding) => binding.class),
    );
    for (const feature of pilot.requiredFeatureTags) {
      if (!technical.data.featureTags.includes(feature))
        coverageIssues.push(
          issue(
            'missing_pilot_feature',
            'technical.featureTags',
            `${designation} pilot requires feature "${feature}"`,
          ),
        );
    }
    for (const materialClass of pilot.requiredPaintableClasses) {
      if (!paintable.has(materialClass))
        coverageIssues.push(
          issue(
            'missing_pilot_material',
            'technical.materials',
            `${designation} pilot requires paintable class "${materialClass}"`,
          ),
        );
    }
    for (const materialClass of pilot.requiredProtectedClasses) {
      if (!protectedMaterials.has(materialClass))
        coverageIssues.push(
          issue(
            'missing_pilot_material',
            'technical.materials',
            `${designation} pilot requires protected class "${materialClass}"`,
          ),
        );
    }
  }
  if (coverageIssues.length > 0) return { status: 'invalid_model', issues: coverageIssues };

  const licence = AircraftAssetLicenceEvidence.safeParse(envelope.data.licence);
  if (!licence.success) {
    return { status: 'missing_licence_evidence', issues: zodIssues(licence.error) };
  }
  const evidenceIssues: AircraftAssetIntakeIssue[] = [];
  if (licence.data.sourceFileSha256 !== technical.data.delivery.fileSha256) {
    evidenceIssues.push(
      issue(
        'source_hash_mismatch',
        'licence.sourceFileSha256',
        'licence evidence does not cover the delivered GLB',
      ),
    );
  }
  const evidenceKinds = new Set(licence.data.evidenceFiles.map((file) => file.kind));
  for (const kind of ['proof_of_purchase', 'licence_text', 'vendor_terms_snapshot'] as const) {
    if (!evidenceKinds.has(kind))
      evidenceIssues.push(
        issue('missing_evidence_file', 'licence.evidenceFiles', `missing ${kind} evidence`),
      );
  }
  if (evidenceIssues.length > 0) {
    return { status: 'missing_licence_evidence', issues: evidenceIssues };
  }

  const manifest = AircraftAssetManifest.parse({
    ...envelope.data,
    technical: technical.data,
    licence: licence.data,
  });
  const blocked: AircraftAssetIntakeIssue[] = [];
  for (const [permission, permitted] of Object.entries(licence.data.permissions)) {
    if (!permitted)
      blocked.push(
        issue(
          'licence_permission_denied',
          `licence.permissions.${permission}`,
          `${permission} is not permitted`,
        ),
      );
  }
  if (!technical.data.contentAudit.neutralBaseCoat)
    blocked.push(
      issue(
        'non_neutral_base',
        'technical.contentAudit.neutralBaseCoat',
        'distributed source must use a neutral base coat',
      ),
    );
  if (technical.data.contentAudit.realWorldAirlineLivery)
    blocked.push(
      issue(
        'embedded_airline_livery',
        'technical.contentAudit.realWorldAirlineLivery',
        'real-world airline liveries cannot be distributed',
      ),
    );
  if (technical.data.contentAudit.trademarkedLogos.length > 0)
    blocked.push(
      issue(
        'trademarked_logo',
        'technical.contentAudit.trademarkedLogos',
        'trademarked logos must be removed',
      ),
    );
  if (technical.data.contentAudit.unlicensedLogos.length > 0)
    blocked.push(
      issue(
        'unlicensed_logo',
        'technical.contentAudit.unlicensedLogos',
        'unlicensed logos must be removed',
      ),
    );

  return blocked.length > 0
    ? { status: 'distribution_blocked', manifest, issues: blocked }
    : { status: 'accepted', manifest };
}

export { AIRCRAFT_CATALOGUE_V1_VERSION as AIRCRAFT_ASSET_CATALOGUE_VERSION };
