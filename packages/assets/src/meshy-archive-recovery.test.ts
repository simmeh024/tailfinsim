import { describe, expect, it } from 'vitest';

import { sha256 } from './canonical';
import { MeshyGenerationSpec } from './meshy';
import {
  archiveRetextureDryRunReport,
  createArchiveRetextureRequest,
  MESHY_ARCHIVE_RETEXTURE_CREDITS,
} from './meshy-archive-recovery';

const spec = MeshyGenerationSpec.parse({
  format: 'tailfin-meshy-generation-spec',
  formatVersion: 1,
  id: 'a320neo-t2-v1',
  aircraftAssetId: 'a320neo',
  referencePrompt: 'neutral aircraft',
  generation: {
    model_type: 'smart-topology',
    ai_model: 'meshy-t2',
    target_polycount: 15000,
    should_texture: false,
    target_formats: ['glb'],
  },
  candidateCount: 4,
  retexture: {
    ai_model: 'meshy-7',
    enable_pbr: true,
    enable_original_uv: false,
    texture_resolution: '4k',
    text_style_prompt: 'neutral source PBR',
  },
  pricing: {
    snapshotId: 'meshy-api-2026-08-28',
    observedAt: '2026-08-28',
    source: 'https://docs.meshy.ai/en/api/pricing',
    untexturedCandidateCredits: 5,
    selectedRetextureCredits: 10,
  },
});

function glb(): Buffer {
  const bytes = Buffer.alloc(48, 0x20);
  bytes.writeUInt32LE(0x46546c67, 0);
  bytes.writeUInt32LE(2, 4);
  bytes.writeUInt32LE(bytes.length, 8);
  bytes.writeUInt32LE(28, 12);
  bytes.writeUInt32LE(0x4e4f534a, 16);
  bytes.write('{"asset":{"version":"2.0"}}', 20);
  return bytes;
}

describe('archive-backed Meshy retexture preflight', () => {
  it('uses immutable local GLB bytes and enforces the aggregate 50-credit ceiling', () => {
    const bytes = glb();
    const request = createArchiveRetextureRequest(spec, 30, { bytes, sha256: sha256(bytes) }, 50);

    expect(request).toMatchObject({
      originalExposure: 30,
      recoveryReservation: MESHY_ARCHIVE_RETEXTURE_CREDITS,
      aggregateExposure: 40,
      totalCreditCeiling: 50,
    });
    expect(request.body).toMatch(/"enable_original_uv": true/);
    expect(request.body).toMatch(/"enable_pbr": true/);
    expect(request.body).toContain('"target_formats"');
    expect(request.body).toContain('"glb"');
    expect(request.body).toContain('data:application/octet-stream;base64,');
    expect(archiveRetextureDryRunReport(request)).not.toHaveProperty('body');
  });

  it('rejects tampered source bytes and aggregate budget overruns', () => {
    const bytes = glb();
    expect(() =>
      createArchiveRetextureRequest(spec, 30, { bytes, sha256: 'a'.repeat(64) }, 50),
    ).toThrow('digest');
    expect(() =>
      createArchiveRetextureRequest(spec, 41, { bytes, sha256: sha256(bytes) }, 50),
    ).toThrow('Aggregate');
  });
});
