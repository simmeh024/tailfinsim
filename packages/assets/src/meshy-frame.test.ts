import { describe, expect, it } from 'vitest';

import { assessA320neoCanonicalFrame, MeshyAxisReview } from './meshy-frame';
import { faces, fixture, pack, tetra } from './meshy-test-fixture';

const axisReview = MeshyAxisReview.parse({
  format: 'tailfin-meshy-axis-review',
  formatVersion: 1,
  operationId: 'candidate-1',
  sourceSha256: 'a'.repeat(64),
  reviewedAt: '2026-08-29T12:00:00.000+02:00',
  reviewedBy: 'local-operator',
  sourceAxes: { right: '-z', up: '+y', forward: '-x' },
  evidence: [
    { sha256: 'b'.repeat(64), description: 'Positive span-axis view' },
    { sha256: 'c'.repeat(64), description: 'Negative span-axis view' },
  ],
});

describe('A320neo canonical frame assessment', () => {
  it('maps a reviewed right-handed source frame to +X/+Y/-Z without changing geometry', () => {
    const source = pack(fixture(tetra, faces));
    const before = Buffer.from(source);
    const result = assessA320neoCanonicalFrame(source, axisReview);

    expect(result.sourceToCanonicalAxisMatrix).toEqual([
      [0, 0, -1],
      [0, 1, 0],
      [1, 0, 0],
    ]);
    expect(source).toEqual(before);
    expect(result.canonicalTransformApplied).toBe(false);
    expect(result.policies.uniformScaleOnly).toBe(true);
  });

  it('fails closed when one uniform scale cannot fit length and span', () => {
    const source = pack(
      fixture(
        [
          [-0.486328125, -0.15234375, -0.5],
          [0.486328125, -0.15234375, -0.5],
          [0.486328125, 0.1572265625, 0.5],
          [-0.486328125, 0.1572265625, 0.5],
        ],
        [
          [0, 1, 2],
          [0, 2, 3],
        ],
      ),
    );
    const result = assessA320neoCanonicalFrame(source, axisReview);

    expect(result.eligibleForCanonicalTransform).toBe(false);
    expect(result.proposedDimensions.lengthMetres).toBeCloseTo(36.15745, 5);
    expect(result.proposedDimensions.wingspanMetres).toBeCloseTo(37.17393, 5);
    expect(result.deviations.lengthFraction).toBeLessThan(-0.037);
    expect(result.deviations.wingspanFraction).toBeGreaterThan(0.038);
    expect(result.blockingReasons).toHaveLength(2);
  });

  it('rejects duplicated or left-handed axis declarations', () => {
    expect(() =>
      assessA320neoCanonicalFrame(pack(fixture(tetra, faces)), {
        ...axisReview,
        sourceAxes: { right: '+x', up: '+x', forward: '-z' },
      }),
    ).toThrow('axes must be orthogonal');
    expect(() =>
      assessA320neoCanonicalFrame(pack(fixture(tetra, faces)), {
        ...axisReview,
        sourceAxes: { right: '+z', up: '+y', forward: '-x' },
      }),
    ).toThrow('right-handed');
  });

  it('requires two immutable visual evidence identities', () => {
    expect(() =>
      MeshyAxisReview.parse({ ...axisReview, evidence: axisReview.evidence.slice(0, 1) }),
    ).toThrow();
  });
});
