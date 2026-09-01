import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { MeshyGenerationSpec } from './meshy';
import { downloadMeshyTexture } from './meshy-recovery';
import { assertMeshyRetextureArchiveReady, createMeshyRetextureRequest } from './meshy-retexture';

const spec = MeshyGenerationSpec.parse(
  JSON.parse(
    await readFile(
      new URL('../../../assets/aircraft/generation/a320neo-t2-v1.json', import.meta.url),
      'utf8',
    ),
  ),
);
const taskId = '01a0499b-9743-7e7a-bcc3-021485b8b0e3';

describe('Meshy selected retexture contract', () => {
  it('binds exactly the selected task and pinned 4K PBR settings', () => {
    const request = createMeshyRetextureRequest(spec, taskId);
    expect(request.request).toMatchObject({
      input_task_id: taskId,
      ai_model: 'meshy-7',
      enable_pbr: true,
      enable_original_uv: false,
      texture_resolution: '4k',
      target_formats: ['glb'],
    });
    expect(request.body).not.toContain('Bearer');
  });

  it('requires every runtime-relevant PBR output before archival', () => {
    const output = {
      id: taskId,
      type: 'retexture',
      status: 'SUCCEEDED',
      consumed_credits: 10,
      created_at: 1,
      finished_at: 2,
      model_urls: { glb: 'https://assets.meshy.ai/output.glb' },
      texture_urls: {
        base_color: 'https://assets.meshy.ai/base.png',
        normal: 'https://assets.meshy.ai/normal.png',
        metallic: 'https://assets.meshy.ai/metallic.png',
        roughness: 'https://assets.meshy.ai/roughness.png',
      },
    };
    expect(assertMeshyRetextureArchiveReady(output)).toEqual(output);
    const incomplete = {
      ...output,
      texture_urls: { ...output.texture_urls },
    } as { texture_urls: { roughness?: string } };
    delete incomplete.texture_urls.roughness;
    expect(() => assertMeshyRetextureArchiveReady(incomplete)).toThrow('missing required');
  });

  it('downloads only validated PBR image bytes from Meshy assets without credentials', async () => {
    const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    const fetch = (_url: string, init?: RequestInit) => {
      expect(init?.headers).toEqual({ Accept: 'image/png, image/jpeg' });
      expect(init?.redirect).toBe('error');
      return Promise.resolve(new Response(png, { headers: { 'content-type': 'image/png' } }));
    };
    await expect(
      downloadMeshyTexture('https://assets.meshy.ai/texture.png', {
        fetch: fetch as typeof globalThis.fetch,
        pause: () => Promise.resolve(),
        now: () => new Date(0),
      }),
    ).resolves.toEqual(png);
    await expect(
      downloadMeshyTexture('https://example.invalid/texture.png', {
        fetch: fetch as typeof globalThis.fetch,
        pause: () => Promise.resolve(),
        now: () => new Date(0),
      }),
    ).rejects.toThrow('download-refused');
  });
});
