import { z } from 'zod';

import { canonicalJson, sha256 } from './canonical';
import { MeshyGenerationSpec, type MeshyGenerationSpec as MeshyGenerationSpecValue } from './meshy';

const TaskId = z.uuid();

/** The only request body permitted for the selected-candidate PBR operation. */
export const MeshyRetextureRequest = z
  .object({
    input_task_id: TaskId,
    ai_model: z.literal('meshy-7'),
    enable_pbr: z.literal(true),
    enable_original_uv: z.literal(false),
    texture_resolution: z.literal('4k'),
    text_style_prompt: z.string().trim().min(1).max(600),
    target_formats: z.tuple([z.literal('glb')]),
  })
  .strict();
export type MeshyRetextureRequest = z.infer<typeof MeshyRetextureRequest>;

/** Provider URLs are transient transport values; archive code must hash the downloaded bytes. */
export const MeshyRetextureTaskOutput = z
  .object({
    id: TaskId,
    type: z.literal('retexture'),
    status: z.enum(['PENDING', 'IN_PROGRESS', 'SUCCEEDED', 'FAILED', 'CANCELED']),
    consumed_credits: z.number().int().nonnegative().optional(),
    created_at: z.number().int().nonnegative(),
    finished_at: z.number().int().nonnegative().optional(),
    expires_at: z.number().int().nonnegative().optional(),
    model_urls: z.object({ glb: z.string().max(8192).optional() }).optional(),
    texture_urls: z
      .object({
        base_color: z.string().max(8192).optional(),
        normal: z.string().max(8192).optional(),
        metallic: z.string().max(8192).optional(),
        roughness: z.string().max(8192).optional(),
      })
      .optional(),
  })
  .strict();
export type MeshyRetextureTaskOutput = z.infer<typeof MeshyRetextureTaskOutput>;

/** Builds a deterministic, credential-free request body bound to the chosen Meshy task only. */
export function createMeshyRetextureRequest(
  specInput: MeshyGenerationSpecValue,
  selectedTaskId: string,
) {
  const spec = MeshyGenerationSpec.parse(specInput);
  const request = MeshyRetextureRequest.parse({
    ...spec.retexture,
    input_task_id: TaskId.parse(selectedTaskId),
    target_formats: ['glb'],
  });
  const body = canonicalJson(request);
  return { request, body, requestBodySha256: sha256(body) };
}

/** A successful PBR task must expose a retextured GLB and all three required PBR channels. */
export function assertMeshyRetextureArchiveReady(input: unknown) {
  const task = MeshyRetextureTaskOutput.parse(input);
  if (
    task.status !== 'SUCCEEDED' ||
    task.consumed_credits === undefined ||
    !task.finished_at ||
    !task.model_urls?.glb ||
    !task.texture_urls?.base_color ||
    !task.texture_urls.normal ||
    !task.texture_urls.metallic ||
    !task.texture_urls.roughness
  )
    throw new Error('Successful retexture is missing required GLB or PBR outputs.');
  return task;
}
