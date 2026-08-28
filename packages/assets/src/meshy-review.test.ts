import { validateBytes } from 'gltf-validator';
import { describe, expect, it, vi } from 'vitest';

import { canonicalJson, sha256 } from './canonical';
import { auditMeshyGeometry, decodeMeshyGeometry } from './meshy-geometry';
import { prepareMeshyReview } from './meshy-review';
import { parseMeshyRunArguments } from './meshy-run-command';
import { faces, fixture, pack, tetra } from './meshy-test-fixture';

describe('quarantine component review preparation', () => {
  it('preserves positions/winding/source and emits deterministic conformant flat-normal components', async () => {
    const source = pack(fixture());
    const original = Buffer.from(source);
    const beforeAudit = canonicalJson(auditMeshyGeometry(source));
    const result = prepareMeshyReview(source);
    expect(result).toEqual(prepareMeshyReview(source));
    expect(source).toEqual(original);
    expect(canonicalJson(auditMeshyGeometry(source))).toBe(beforeAudit);
    expect(result.report.sourceSha256).toBe(sha256(source));
    expect(result.report.derivativeSha256).toBe(sha256(result.glb));
    expect(result.report.after.boundsSourceUnits).toEqual(result.report.before.boundsSourceUnits);
    expect(result.report.after.attributes).toMatchObject({
      normalVertices: 12,
      nonUnitNormals: 0,
      uvVertices: 0,
      materialAssignedTriangles: 0,
    });
    expect(result.report).toMatchObject({
      state: 'quarantine',
      liveryReady: false,
      runtimeAdmission: 'not-reviewed',
      creditsSpentByThisCommand: 0,
    });
    expect(result.report.components[0]).toMatchObject({
      id: 'review_component_001',
      sourceTriangles: [0, 1, 2, 3],
      semanticClass: null,
      paintProtection: 'unassigned',
    });
    const sourceGeometry = decodeMeshyGeometry(source);
    const derivativeGeometry = decodeMeshyGeometry(result.glb);
    expect(
      derivativeGeometry.triangles.map((t) => t.map((i) => derivativeGeometry.positions[i])),
    ).toEqual(sourceGeometry.triangles.map((t) => t.map((i) => sourceGeometry.positions[i])));
    const external = vi.fn(() => Promise.reject(new Error('No resources allowed')));
    const validation = await validateBytes(result.glb, {
      writeTimestamp: false,
      maxIssues: 32,
      externalResourceFunction: external,
    });
    expect(validation.issues.numErrors).toBe(0);
    expect(validation.issues.numWarnings).toBe(0);
    expect(external).not.toHaveBeenCalled();
  });
  it('removes only exact zero-area and same-winding duplicates, recording original face indices', () => {
    const result = prepareMeshyReview(pack(fixture(tetra, [...faces, [2, 1, 0], [0, 0, 1]])));
    expect(result.report.after.sourceTriangles).toBe(4);
    expect(result.report.removedTriangles).toEqual([
      { sourceTriangle: 4, reason: 'same-winding-exact-duplicate', retainedSourceTriangle: 0 },
      { sourceTriangle: 5, reason: 'exact-zero-area' },
    ]);
    expect(result.report.ambiguousCoincidentFaces).toEqual([]);
  });
  it('preserves opposite-winding coincident faces and flags their source identity', () => {
    const result = prepareMeshyReview(pack(fixture(tetra, [...faces, [0, 1, 2]])));
    expect(result.report.after.sourceTriangles).toBe(5);
    expect(result.report.after.duplicateTriangles).toBe(1);
    expect(result.report.removedTriangles).toEqual([]);
    expect(result.report.ambiguousCoincidentFaces).toEqual([
      { sourceTriangle: 4, otherSourceTriangle: 0 },
    ]);
    expect(result.report.components).toHaveLength(1);
    expect(result.report.components[0]!.boundaryEdges).toEqual([]);
  });
  it('does not merge vertex-touching components or invent engine labels', () => {
    const points = [...tetra, [3, 0, 0], [3, 1, 0], [3, 0, 1]];
    const result = prepareMeshyReview(pack(fixture(points, [...faces, [0, 4, 5], [0, 5, 6]])));
    expect(result.report.components.map((p) => p.sourceTriangles)).toEqual([
      [0, 1, 2, 3],
      [4, 5],
    ]);
    expect(result.report.components.map((p) => p.semanticClass)).toEqual([null, null]);
    expect(result.report.components[1]!.boundaryEdges).toHaveLength(4);
    expect(result.report.pendingChecks).toContain('engine-count-and-placement');
  });
  it('keeps boundary segments and source winding defects for manual review', () => {
    const result = prepareMeshyReview(pack(fixture(tetra, [[1, 2, 0], ...faces.slice(1, 3)])));
    expect(result.report.components[0]!.boundaryEdges.length).toBe(3);
    expect(result.report.after.edgeTopology.inconsistentWindingEdges).toBeGreaterThan(0);
    expect(result.report.after.edgeTopology).toEqual(result.report.before.edgeTopology);
  });
  it('refuses positive near-zero triangles instead of deleting tiny details', () => {
    const source = pack(fixture([...tetra, [0.5, 1e-14, 0]], [...faces, [0, 1, 4]]));
    expect(auditMeshyGeometry(source).metrics.degenerateTriangles).toBe(1);
    expect(() => prepareMeshyReview(source)).toThrow(/^Candidate review preparation refused:/);
  });
  it('refuses a cleanup that would change measured bounds', () => {
    expect(() =>
      prepareMeshyReview(pack(fixture([...tetra, [999, 999, 999]], [...faces, [4, 4, 0]]))),
    ).toThrow();
  });
  it.each([
    fixture([[0, 0, 0]], [[0, 0, 0]]),
    fixture(tetra, faces, { normals: tetra.map(() => [1, 0, 0]) }),
    fixture(tetra, faces, { uv: tetra.map(() => [0, 0]) }),
  ])('refuses empty derivatives and authored attributes rather than dropping them', (f) => {
    expect(() => prepareMeshyReview(pack(f))).toThrow(/^Candidate review preparation refused:/);
  });
  it('refuses multipart inputs rather than merging authored boundaries', () => {
    const f = fixture();
    f.json.meshes[0]!.primitives.push(f.json.meshes[0]!.primitives[0]!);
    expect(() => prepareMeshyReview(pack(f))).toThrow();
  });
  it('bounds the review component count', () => {
    const points = Array.from({ length: 65 }, (_, i) =>
      tetra.map((p) => p.map((n) => n + i * 3)),
    ).flat();
    const triangles = Array.from({ length: 65 }, (_, i) =>
      faces.map((t) => t.map((n) => n + i * 4)),
    ).flat();
    expect(() => prepareMeshyReview(pack(fixture(points, triangles)))).toThrow();
  });
  it('bounds retained triangles before allocating expanded normal buffers', () => {
    const points = Array.from({ length: 33_336 }, (_, i) => [i, i % 2, 0]);
    const triangles = Array.from({ length: 33_334 }, (_, i) => [0, i + 1, i + 2]);
    expect(() => prepareMeshyReview(pack(fixture(points, triangles)))).toThrow();
  });
  it('has no credential, budget, arbitrary path or submission arguments', () => {
    expect(parseMeshyRunArguments(['review', '--operation', 'candidate-1']).command).toBe('review');
    for (const args of [
      ['review'],
      ['review', '--operation', '../x'],
      ['review', '--operation', 'candidate-5'],
      ['review', '--operation', 'candidate-1', '--key-file', 'private'],
      ['review', '--operation', 'candidate-1', '--max-credits', '40'],
      ['review', '--operation', 'candidate-1', '--output', 'arbitrary'],
    ])
      expect(() => parseMeshyRunArguments(args)).toThrow();
  });
});
