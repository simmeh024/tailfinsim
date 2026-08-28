import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { canonicalJson, sha256 } from './canonical';
import { MeshyGenerationSpec, meshySpecIdentity } from './meshy';
import { meshyArchiveDirectory, syncMeshyCandidate } from './meshy-archive';
import { auditMeshyGeometry } from './meshy-geometry';
import { reportMeshyGeometry } from './meshy-geometry-report';
import { MeshyRunApproval } from './meshy-run';
import { parseMeshyRunArguments } from './meshy-run-command';
import { MeshyRunStore } from './meshy-store';

const tetra = [
  [0, 0, 0],
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
];
const faces = [
  [0, 2, 1],
  [0, 1, 3],
  [1, 2, 3],
  [2, 0, 3],
];
interface Accessor {
  bufferView: number;
  byteOffset: number;
  count: number;
  componentType: number;
  type: string;
  min?: number[];
  max?: number[];
}
function fixture(
  points = tetra,
  triangles = faces,
  options: {
    normals?: number[][];
    uv?: number[][];
    indexType?: 5121 | 5123 | 5125;
    stride?: boolean;
  } = {},
) {
  const chunks: Buffer[] = [];
  const views: { buffer: number; byteOffset: number; byteLength: number; byteStride?: number }[] =
    [];
  const accessors: Accessor[] = [];
  let offset = 0;
  const append = (
    values: number[],
    count: number,
    type: string,
    componentType: number,
    stride?: number,
  ) => {
    const size = componentType === 5121 ? 1 : componentType === 5123 ? 2 : 4;
    const data = Buffer.alloc(Math.ceil((values.length * size) / 4) * 4);
    values.forEach((v, i) => {
      if (componentType === 5126) data.writeFloatLE(v, i * size);
      else if (size === 1) data.writeUInt8(v, i);
      else if (size === 2) data.writeUInt16LE(v, i * size);
      else data.writeUInt32LE(v, i * size);
    });
    chunks.push(data);
    views.push({
      buffer: 0,
      byteOffset: offset,
      byteLength: data.length,
      ...(stride ? { byteStride: stride } : {}),
    });
    offset += data.length;
    accessors.push({ bufferView: views.length - 1, byteOffset: 0, count, componentType, type });
    return accessors.length - 1;
  };
  const attrs: Record<string, number> = {
    POSITION: append(
      points.flatMap((p) => (options.stride ? [...p, 0] : p)),
      points.length,
      'VEC3',
      5126,
      options.stride ? 16 : undefined,
    ),
  };
  const indices = append(
    triangles.flat(),
    triangles.length * 3,
    'SCALAR',
    options.indexType ?? 5125,
  );
  if (options.normals)
    attrs.NORMAL = append(options.normals.flat(), options.normals.length, 'VEC3', 5126);
  if (options.uv) attrs.TEXCOORD_0 = append(options.uv.flat(), options.uv.length, 'VEC2', 5126);
  const json = {
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: attrs, indices }] }],
    accessors,
    bufferViews: views,
    buffers: [{ byteLength: offset }],
  };
  return { json, binary: Buffer.concat(chunks) };
}
function pack({ json, binary }: ReturnType<typeof fixture>): Buffer {
  const raw = Buffer.from(JSON.stringify(json));
  const padding = Buffer.alloc((4 - (raw.length % 4)) % 4, 0x20);
  const text = Buffer.concat([raw, padding]);
  const bytes = Buffer.alloc(28 + text.length + binary.length);
  [0x46546c67, 2, bytes.length, text.length, 0x4e4f534a].forEach((n, i) =>
    bytes.writeUInt32LE(n, i * 4),
  );
  text.copy(bytes, 20);
  bytes.writeUInt32LE(binary.length, 20 + text.length);
  bytes.writeUInt32LE(0x004e4942, 24 + text.length);
  binary.copy(bytes, 28 + text.length);
  return bytes;
}
const audit = (f = fixture()) => auditMeshyGeometry(pack(f));

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('bounded offline candidate geometry', () => {
  it('measures a closed tetrahedron deterministically without changing source bytes or using network', () => {
    const fetch = vi.fn(() => {
      throw new Error('Network forbidden');
    });
    vi.stubGlobal('fetch', fetch);
    const bytes = pack(fixture());
    const before = Buffer.from(bytes);
    const report = auditMeshyGeometry(bytes);
    expect(canonicalJson(report)).toBe(canonicalJson(auditMeshyGeometry(bytes)));
    expect(bytes).toEqual(before);
    expect(report.sourceSha256).toBe(sha256(bytes));
    expect(report.metrics.edgeTopology).toMatchObject({
      boundaryEdges: 0,
      nonManifoldEdges: 0,
      inconsistentWindingEdges: 0,
      edgeConnectedComponents: 1,
    });
    expect(report).toMatchObject({
      state: 'quarantine',
      liveryReady: false,
      runtimeAdmission: 'not-reviewed',
      creditsSpentByThisCommand: 0,
    });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('separates duplicate/degenerate faces from analysed edge topology', () => {
    const report = audit(fixture(tetra, [...faces, [1, 2, 0], [0, 0, 1]]));
    expect(report.metrics).toMatchObject({
      sourceTriangles: 6,
      duplicateTriangles: 1,
      degenerateTriangles: 1,
      analysedUniqueNondegenerateTriangles: 4,
    });
    expect(report.metrics.edgeTopology.boundaryEdges).toBe(0);
  });
  it('analytically welds exact duplicate positions without rewriting vertices', () => {
    const report = audit(fixture([...tetra, tetra[0]!], [[4, 2, 1], ...faces.slice(1)]));
    expect(report.metrics).toMatchObject({ sourceVertices: 5, exactCoincidentVertices: 1 });
    expect(report.metrics.edgeTopology.boundaryEdges).toBe(0);
  });
  it('distinguishes open, non-manifold-edge and inconsistent winding defects', () => {
    expect(audit(fixture(tetra, faces.slice(1))).metrics.edgeTopology.boundaryEdges).toBe(3);
    expect(
      audit(
        fixture(
          [...tetra, [0, -1, 0]],
          [
            [0, 1, 2],
            [1, 0, 3],
            [0, 1, 4],
          ],
        ),
      ).metrics.edgeTopology.nonManifoldEdges,
    ).toBe(1);
    expect(
      audit(fixture(tetra, [[1, 2, 0], ...faces.slice(1)])).metrics.edgeTopology
        .inconsistentWindingEdges,
    ).toBe(3);
  });
  it('counts disconnected components without calling them engines or semantic parts', () => {
    const report = audit(
      fixture(
        [...tetra, ...tetra.map((p) => p.map((n) => n + 3))],
        [...faces, ...faces.map((t) => t.map((i) => i + 4))],
      ),
    );
    expect(report.metrics.edgeTopology.largestComponentTriangleCounts).toEqual([4, 4]);
    expect(report.pendingChecks).toContain('engine-count-and-placement');
    expect(report.pendingChecks).toContain('vertex-manifoldness-and-self-intersections');
  });
  it('measures symmetric vertex occupancy but does not call it silhouette approval', () => {
    const points = [
      [1, 0, 0],
      [-1, 0, 0],
      [0, 1, 0],
      [0, -1, 0],
      [0, 0, 1],
      [0, 0, -1],
    ];
    const triangles = [
      [0, 2, 4],
      [1, 3, 5],
    ];
    const report = audit(fixture(points, triangles));
    expect(report.metrics.symmetryIndicator.planes.map((p) => p.vertexVoxelReflectionIoU)).toEqual([
      1, 1, 1,
    ]);
    const scaled = audit(
      fixture(
        points.map((p) => p.map((n) => n * 8 + 4)),
        triangles,
      ),
    );
    expect(scaled.metrics.symmetryIndicator.planes.map((p) => p.vertexVoxelReflectionIoU)).toEqual([
      1, 1, 1,
    ]);
    points[0] = [1, 0.2, 0];
    expect(
      audit(fixture(points, triangles)).metrics.symmetryIndicator.planes[0]!
        .vertexVoxelReflectionIoU,
    ).toBeLessThan(1);
    expect(report.pendingChecks).toContain('silhouette');
  });
  it('excludes unused outlier vertices from bounds and symmetry', () => {
    expect(audit(fixture([...tetra, [999, 999, 999]])).metrics.boundsSourceUnits).toEqual(
      audit().metrics.boundsSourceUnits,
    );
  });
  it('quantizes mirrored half-voxel ties symmetrically', () => {
    const report = audit(
      fixture(
        [
          [-1, 0, 0],
          [1, 0, 0],
          [-1 / 256, 1, 0],
          [1 / 256, 1, 0],
        ],
        [
          [0, 1, 2],
          [0, 1, 3],
        ],
      ),
    );
    expect(report.metrics.symmetryIndicator.planes[0]!.vertexVoxelReflectionIoU).toBe(1);
  });
  it('decodes unindexed triangles and caps component detail without losing the count', () => {
    const points = Array.from({ length: 65 }, (_, i) => [
      [i * 3, 0, 0],
      [i * 3 + 1, 0, 0],
      [i * 3, 1, 0],
    ]).flat();
    const f = fixture(points, [[0, 1, 2]]);
    Reflect.deleteProperty(f.json.meshes[0]!.primitives[0]!, 'indices');
    const report = audit(f);
    expect(report.metrics.sourceTriangles).toBe(65);
    expect(report.metrics.edgeTopology.edgeConnectedComponents).toBe(65);
    expect(report.metrics.edgeTopology.largestComponentTriangleCounts).toHaveLength(64);
    expect(report.metrics.edgeTopology.omittedComponents).toBe(1);
  });
  it('reports attribute presence separately from UV and outward-normal approval', () => {
    const report = audit(
      fixture(tetra, faces, {
        normals: [
          [0, 0, 0],
          [1, 0, 0],
          [1, 0, 0],
          [1, 0, 0],
        ],
        uv: tetra.map(() => [0, 0]),
      }),
    );
    expect(report.metrics.attributes).toMatchObject({
      normalVertices: 4,
      nonUnitNormals: 1,
      uvVertices: 4,
      materialAssignedTriangles: 0,
    });
    expect(report.liveryReady).toBe(false);
  });
  it.each([5121, 5123, 5125] as const)(
    'decodes bounded index component type %i and position stride',
    (indexType) => {
      expect(
        audit(fixture(tetra, faces, { indexType, stride: true })).metrics.edgeTopology,
      ).toEqual(audit().metrics.edgeTopology);
    },
  );
  it('ignores claimed accessor bounds and reads actual finite coordinates', () => {
    const f = fixture();
    f.json.accessors[0]!.min = [-999, -999, -999];
    expect(audit(f).metrics.boundsSourceUnits.min).toEqual([0, 0, 0]);
  });
  it('accepts the vendor empty extension object but never an extension payload', () => {
    const f = fixture();
    Object.assign(f.json, { extensions: {} });
    expect(audit(f).metrics.sourceTriangles).toBe(4);
    Object.assign(f.json, { extensions: { KHR_lights_punctual: {} } });
    expect(() => audit(f)).toThrow(/^Geometry audit refused:/);
  });
  it('does not produce nonfinite scores for collapsed geometry', () => {
    const report = audit(fixture([[0, 0, 0]], [[0, 0, 0]]));
    expect(report.metrics.degenerateTriangles).toBe(1);
    expect(report.metrics.symmetryIndicator.planes.map((p) => p.vertexVoxelReflectionIoU)).toEqual([
      null,
      null,
      null,
    ]);
  });
  it.each([
    (f: ReturnType<typeof fixture>) => {
      Object.assign(f.json.buffers[0]!, { uri: 'https://example.invalid/private' });
    },
    (f: ReturnType<typeof fixture>) => {
      Object.assign(f.json, { images: [{ uri: 'file:///private' }] });
    },
    (f: ReturnType<typeof fixture>) => {
      Object.assign(f.json, { extensionsUsed: ['KHR_draco_mesh_compression'] });
    },
    (f: ReturnType<typeof fixture>) => {
      Object.assign(f.json.accessors[0]!, { sparse: {} });
    },
    (f: ReturnType<typeof fixture>) => {
      Object.assign(f.json.nodes[0]!, { translation: [1, 0, 0] });
    },
    (f: ReturnType<typeof fixture>) => {
      Object.assign(f.json.nodes[0]!, { matrix: Array.from({ length: 16 }, () => 0) });
    },
    (f: ReturnType<typeof fixture>) => {
      f.json.scenes[0]!.nodes = [0, 0];
    },
    (f: ReturnType<typeof fixture>) => {
      f.json.accessors[0]!.byteOffset = 999999;
    },
    (f: ReturnType<typeof fixture>) => {
      f.json.accessors[0]!.count = 100001;
    },
    (f: ReturnType<typeof fixture>) => {
      f.json.accessors[1]!.count = 300003;
    },
    (f: ReturnType<typeof fixture>) => {
      f.json.accessors[1]!.count = 2;
    },
    (f: ReturnType<typeof fixture>) => {
      f.json.bufferViews[0]!.byteLength = 0;
    },
    (f: ReturnType<typeof fixture>) => {
      f.json.meshes[0]!.primitives[0]!.attributes.POSITION = 999;
    },
    (f: ReturnType<typeof fixture>) => {
      f.binary.writeFloatLE(NaN, 0);
    },
    (f: ReturnType<typeof fixture>) => {
      f.binary.writeUInt32LE(999, tetra.length * 12);
    },
  ])('refuses unsupported/malformed data with a closed diagnostic', (edit) => {
    const f = fixture();
    edit(f);
    expect(() => audit(f)).toThrow(/^Geometry audit refused:/);
  });
  it.each([0, 8, 16, 24])('refuses truncated GLB at %i bytes', (n) => {
    expect(() => auditMeshyGeometry(pack(fixture()).subarray(0, n))).toThrow(
      /^Geometry audit refused:/,
    );
  });
});

describe('immutable recorded-candidate geometry report', () => {
  it('requires an archived task, binds its hash, preserves ledger/source and refuses a conflicting report', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tailfin-geometry-'));
    try {
      const spec = MeshyGenerationSpec.parse(
        JSON.parse(
          await readFile(
            new URL('../../../assets/aircraft/generation/a320neo-t2-v1.json', import.meta.url),
            'utf8',
          ),
        ) as unknown,
      );
      const taskId = '00000000-0000-4000-8000-000000000001';
      const now = '2026-08-28T17:00:00.000Z';
      const store = new MeshyRunStore(join(root, 'run.sqlite'));
      const archive = meshyArchiveDirectory(join(root, 'run.sqlite'));
      store.initialize(
        MeshyRunApproval.parse({
          format: 'tailfin-meshy-run-approval',
          formatVersion: 1,
          runId: 'a320neo-first-run',
          specSha256: meshySpecIdentity(spec),
          maxCredits: 40,
          recordedAt: now,
          authority: 'explicit-user-confirmation',
          evidence: { taskId, confirmationSha256: 'a'.repeat(64) },
          scope: 'four-t2-candidates-and-one-selected-4k-retexture',
          fallbackApproved: false,
          productionPublicationApproved: false,
        }),
        spec,
      );
      expect(() => reportMeshyGeometry(store, archive, 'candidate-1')).toThrow();
      expect(() => reportMeshyGeometry(store, archive, '../candidate-1')).toThrow();
      store.reserve(spec, 40, 'candidate-1', 'b'.repeat(64));
      store.observe({
        operationId: 'candidate-1',
        taskId,
        status: 'PENDING',
        consumedCredits: null,
        observedAt: now,
      });
      const bytes = pack(fixture());
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              id: taskId,
              type: 'image-to-3d',
              status: 'SUCCEEDED',
              consumed_credits: 5,
              created_at: Date.parse(now),
              finished_at: Date.parse(now),
              model_urls: { glb: 'https://assets.meshy.ai/model.glb' },
            }),
            { headers: { 'content-type': 'application/json' } },
          ),
        )
        .mockResolvedValueOnce(
          new Response(new Uint8Array(bytes), { headers: { 'content-type': 'model/gltf-binary' } }),
        );
      await syncMeshyCandidate(
        store,
        archive,
        spec,
        40,
        'candidate-1',
        'msy_testNotARealCredential',
        { fetch, now: () => new Date(now), pause: () => Promise.resolve() },
      );
      const state = canonicalJson(store.read());
      vi.stubGlobal(
        'fetch',
        vi.fn(() => {
          throw new Error('No network allowed');
        }),
      );
      const result = reportMeshyGeometry(store, archive, 'candidate-1');
      expect(result).toEqual(reportMeshyGeometry(store, archive, 'candidate-1'));
      expect(canonicalJson(store.read())).toBe(state);
      expect(await readFile(join(archive, `${sha256(bytes)}.glb`))).toEqual(bytes);
      expect(result.report).toMatchObject({
        operationId: 'candidate-1',
        taskId,
        sourceSha256: sha256(bytes),
        state: 'quarantine',
      });
      await writeFile(join(archive, 'candidate-1-geometry-v1.json'), 'conflicting report');
      expect(() => reportMeshyGeometry(store, archive, 'candidate-1')).toThrow();
      await writeFile(join(archive, `${sha256(bytes)}.glb`), Buffer.alloc(bytes.length));
      expect(() => reportMeshyGeometry(store, archive, 'candidate-1')).toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it('has no credential, budget, arbitrary path or generation option', () => {
    expect(parseMeshyRunArguments(['audit', '--operation', 'candidate-1']).command).toBe('audit');
    for (const args of [
      ['audit'],
      ['audit', '--operation', 'candidate-5'],
      ['audit', '--operation', '../x'],
      ['audit', '--operation', 'candidate-1', '--key-file', 'private'],
      ['audit', '--operation', 'candidate-1', '--max-credits', '40'],
    ])
      expect(() => parseMeshyRunArguments(args)).toThrow();
  });
});
