import { describe, expect, it } from 'vitest';

import type { AircraftAssetBudgetException, AircraftRuntimeStats } from '@tailfin/shared';

import { measuredBudgetIssues } from './model';

const overBudget: AircraftRuntimeStats = {
  triangles: 260_001,
  vertices: 270_000,
  drawCalls: 29,
  materials: 18,
  textures: 3,
  textureMemoryBytes: 192 * 1_024 * 1_024,
  gpuGeometryBytes: 32 * 1_024 * 1_024,
  boundsM: { width: 44, length: 70, height: 17 },
  lods: [
    { level: 0, nodeName: 'lod0', triangles: 260_001, liveryUvFingerprint: '1'.repeat(64) },
    { level: 1, nodeName: 'lod1', triangles: 120_000, liveryUvFingerprint: '2'.repeat(64) },
    { level: 2, nodeName: 'lod2', triangles: 50_000, liveryUvFingerprint: '3'.repeat(64) },
  ],
};

const exception: AircraftAssetBudgetException = {
  issueUrl: 'https://github.com/simmeh024/tailfinsim/issues/999',
  approvedBy: 'Asset review board',
  approvedAt: '2026-08-25',
  expiresAt: '2026-09-25',
  metrics: ['lod0Triangles', 'drawCalls'],
  justification: 'Measured pilot evidence shows the additional geometry is required.',
};

describe('measured aircraft asset budgets', () => {
  it('fails every exceeded metric without a documented exception', () => {
    expect(measuredBudgetIssues('narrowbody', overBudget, null, '2026-08-25')).toEqual([
      expect.objectContaining({
        severity: 'error',
        code: 'asset_budget_exceeded',
        message: expect.stringContaining('drawCalls, lod0Triangles') as string,
      }),
    ]);
  });

  it('admits only a current exception covering every measured metric', () => {
    expect(measuredBudgetIssues('narrowbody', overBudget, exception, '2026-08-25')).toEqual([
      expect.objectContaining({ severity: 'warning', code: 'asset_budget_exception' }),
    ]);
    expect(measuredBudgetIssues('narrowbody', overBudget, exception, '2026-10-01')).toEqual([
      expect.objectContaining({
        severity: 'error',
        code: 'asset_budget_exceeded',
        message: expect.stringContaining('exception expired') as string,
      }),
    ]);
  });
});
