import { z } from 'zod';

import { LiveryResourceId, LiveryResourceVersion, LiveryZone } from './livery';

/** Immutable, aircraft-specific inputs consumed by the livery compositor. */
export const AIRCRAFT_LIVERY_RESOURCE_FORMAT = 'tailfin-aircraft-livery-resource' as const;
export const AIRCRAFT_LIVERY_RESOURCE_FORMAT_VERSION = 1 as const;

const UnitInterval = z.number().finite().min(0).max(1);
const ResourceReference = z
  .object({ id: LiveryResourceId, version: LiveryResourceVersion })
  .strict();

export const AircraftLiveryPaintSurface = z.enum([
  'fuselage',
  'fin',
  'horizontal_stabilisers',
  'wings',
  'winglets',
  'nacelle_exteriors',
]);
export type AircraftLiveryPaintSurface = z.infer<typeof AircraftLiveryPaintSurface>;

export const AircraftLiveryProtectedSurface = z.enum([
  'cockpit_glass',
  'cabin_windows',
  'engine_interiors',
  'lights',
  'exposed_metal',
  'rubber_tyres',
  'propellers',
]);
export type AircraftLiveryProtectedSurface = z.infer<typeof AircraftLiveryProtectedSurface>;

/** A normalized atlas rectangle, including the gutter reserved around an island. */
export const AircraftLiveryUvRect = z
  .object({
    x: UnitInterval,
    y: UnitInterval,
    width: UnitInterval.positive(),
    height: UnitInterval.positive(),
  })
  .strict()
  .superRefine((rect, context) => {
    if (rect.x + rect.width > 1) {
      context.addIssue({
        code: 'custom',
        path: ['width'],
        message: 'rectangle exceeds atlas width',
      });
    }
    if (rect.y + rect.height > 1) {
      context.addIssue({
        code: 'custom',
        path: ['height'],
        message: 'rectangle exceeds atlas height',
      });
    }
  });
export type AircraftLiveryUvRect = z.infer<typeof AircraftLiveryUvRect>;

export const AircraftLiveryUvIsland = z
  .object({
    id: LiveryResourceId,
    materialName: LiveryResourceId,
    surface: AircraftLiveryPaintSurface,
    side: z.enum(['port', 'starboard', 'both']),
    zone: LiveryZone,
    bounds: AircraftLiveryUvRect,
  })
  .strict();
export type AircraftLiveryUvIsland = z.infer<typeof AircraftLiveryUvIsland>;

function uniqueBy<T>(field: keyof T & string, label: string) {
  return (values: T[], context: z.RefinementCtx) => {
    const seen = new Set<string>();
    for (const [index, value] of values.entries()) {
      const id = String(value[field]);
      if (seen.has(id)) {
        context.addIssue({
          code: 'custom',
          path: [index, field],
          message: `duplicate ${label} "${id}"`,
        });
      }
      seen.add(id);
    }
  };
}

function rectanglesOverlap(
  left: z.infer<typeof AircraftLiveryUvRect>,
  right: z.infer<typeof AircraftLiveryUvRect>,
) {
  return (
    left.x < right.x + right.width &&
    left.x + left.width > right.x &&
    left.y < right.y + right.height &&
    left.y + left.height > right.y
  );
}

/** The canonical paint coordinate map. Source PBR and livery artwork never share an implicit UV set. */
export const AircraftLiveryUvResource = z
  .object({
    format: z.literal(AIRCRAFT_LIVERY_RESOURCE_FORMAT),
    formatVersion: z.literal(AIRCRAFT_LIVERY_RESOURCE_FORMAT_VERSION),
    kind: z.literal('livery_uv'),
    resource: ResourceReference,
    aircraftAsset: ResourceReference,
    sourcePbrTexCoord: z.literal('TEXCOORD_0'),
    liveryTexCoord: z.literal('TEXCOORD_1'),
    atlasResolution: z.union([z.literal(2048), z.literal(4096)]),
    gutterPx: z.number().int().min(8).max(128),
    islands: z.array(AircraftLiveryUvIsland).min(1).max(128),
  })
  .strict()
  .superRefine((resource, context) => {
    uniqueBy<z.infer<typeof AircraftLiveryUvIsland>>('id', 'UV island')(resource.islands, context);
    for (let leftIndex = 0; leftIndex < resource.islands.length; leftIndex += 1) {
      const left = resource.islands[leftIndex];
      if (!left) continue;
      for (let rightIndex = leftIndex + 1; rightIndex < resource.islands.length; rightIndex += 1) {
        const right = resource.islands[rightIndex];
        if (
          right?.materialName === left.materialName &&
          rectanglesOverlap(left.bounds, right.bounds)
        ) {
          context.addIssue({
            code: 'custom',
            path: ['islands', rightIndex, 'bounds'],
            message: `overlaps livery island "${left.id}"`,
          });
        }
      }
    }
  });
export type AircraftLiveryUvResource = z.infer<typeof AircraftLiveryUvResource>;

export const AircraftLiveryMaterialBinding = z.discriminatedUnion('kind', [
  z
    .object({
      materialName: LiveryResourceId,
      kind: z.literal('paintable'),
      surface: AircraftLiveryPaintSurface,
      receivesLivery: z.literal(true),
      finish: z
        .object({
          roughnessMin: UnitInterval,
          roughnessMax: UnitInterval,
          metallicMax: UnitInterval,
        })
        .strict()
        .refine((finish) => finish.roughnessMin <= finish.roughnessMax, {
          path: ['roughnessMax'],
          message: 'roughnessMax must not be below roughnessMin',
        }),
    })
    .strict(),
  z
    .object({
      materialName: LiveryResourceId,
      kind: z.literal('protected'),
      surface: AircraftLiveryProtectedSurface,
      receivesLivery: z.literal(false),
    })
    .strict(),
]);
export type AircraftLiveryMaterialBinding = z.infer<typeof AircraftLiveryMaterialBinding>;

/** Exact material policy; paint is never inferred from a mesh or material name at runtime. */
export const AircraftLiveryMaterialResource = z
  .object({
    format: z.literal(AIRCRAFT_LIVERY_RESOURCE_FORMAT),
    formatVersion: z.literal(AIRCRAFT_LIVERY_RESOURCE_FORMAT_VERSION),
    kind: z.literal('material_binding'),
    resource: ResourceReference,
    aircraftAsset: ResourceReference,
    materials: z.array(AircraftLiveryMaterialBinding).min(1).max(64),
  })
  .strict()
  .superRefine((resource, context) =>
    uniqueBy<z.infer<typeof AircraftLiveryMaterialBinding>>('materialName', 'material')(
      resource.materials,
      context,
    ),
  );
export type AircraftLiveryMaterialResource = z.infer<typeof AircraftLiveryMaterialResource>;

export const AircraftLiveryAnchor = z
  .object({
    id: LiveryResourceId,
    nodeName: LiveryResourceId,
    zone: LiveryZone,
    side: z.enum(['port', 'starboard', 'both']),
    safeArea: AircraftLiveryUvRect,
  })
  .strict();
export type AircraftLiveryAnchor = z.infer<typeof AircraftLiveryAnchor>;

/** Named safe areas keep text, logos and registrations stable across editor views. */
export const AircraftLiveryAnchorSetResource = z
  .object({
    format: z.literal(AIRCRAFT_LIVERY_RESOURCE_FORMAT),
    formatVersion: z.literal(AIRCRAFT_LIVERY_RESOURCE_FORMAT_VERSION),
    kind: z.literal('anchor_set'),
    resource: ResourceReference,
    aircraftAsset: ResourceReference,
    anchors: z.array(AircraftLiveryAnchor).min(1).max(64),
  })
  .strict()
  .superRefine((resource, context) =>
    uniqueBy<z.infer<typeof AircraftLiveryAnchor>>('id', 'anchor')(resource.anchors, context),
  );
export type AircraftLiveryAnchorSetResource = z.infer<typeof AircraftLiveryAnchorSetResource>;

/**
 * Validates the three resources as one immutable compatibility tuple. It is a
 * pure boundary check; registry admission, file hashes and visual QA stay in
 * the aircraft intake pipeline.
 */
export function validateAircraftLiveryResourceBundle(input: {
  liveryUv: unknown;
  materialBinding: unknown;
  anchorSet: unknown;
}) {
  const liveryUv = AircraftLiveryUvResource.safeParse(input.liveryUv);
  const materialBinding = AircraftLiveryMaterialResource.safeParse(input.materialBinding);
  const anchorSet = AircraftLiveryAnchorSetResource.safeParse(input.anchorSet);
  if (!liveryUv.success || !materialBinding.success || !anchorSet.success) {
    return {
      success: false as const,
      errors: [liveryUv, materialBinding, anchorSet].flatMap((result) =>
        result.success ? [] : result.error.issues,
      ),
    };
  }

  const resources = [liveryUv.data, materialBinding.data, anchorSet.data];
  const sameAsset = resources.every(
    (resource) =>
      resource.aircraftAsset.id === liveryUv.data.aircraftAsset.id &&
      resource.aircraftAsset.version === liveryUv.data.aircraftAsset.version,
  );
  const paintableMaterials = new Set(
    materialBinding.data.materials
      .filter((material) => material.kind === 'paintable')
      .map((material) => material.materialName),
  );
  const unknownUvMaterial = liveryUv.data.islands.find(
    (island) => !paintableMaterials.has(island.materialName),
  );
  if (!sameAsset || unknownUvMaterial) {
    return {
      success: false as const,
      errors: [
        {
          code: 'custom',
          path: unknownUvMaterial ? ['liveryUv', 'islands'] : ['aircraftAsset'],
          message: unknownUvMaterial
            ? `livery UV island references non-paintable material "${unknownUvMaterial.materialName}"`
            : 'all livery resources must bind the same aircraft asset version',
        },
      ],
    };
  }
  return {
    success: true as const,
    data: {
      liveryUv: liveryUv.data,
      materialBinding: materialBinding.data,
      anchorSet: anchorSet.data,
    },
  };
}
