import { describe, expect, it } from 'vitest';

import { correctA320neoProportions } from './meshy-correction';
import { auditMeshyGeometry } from './meshy-geometry';
import { prepareMeshyReview } from './meshy-review';
import { faces, fixture, pack } from './meshy-test-fixture';

const axisMatrix = [
  [0, 0, -1],
  [0, 1, 0],
  [1, 0, 0],
] as const;

function proportionFixture() {
  return pack(
    fixture(
      [
        [-0.486328125, -0.15234375, -0.5],
        [0.486328125, -0.15234375, -0.5],
        [-0.486328125, 0.1572265625, 0.5],
        [0.486328125, 0.1572265625, 0.5],
      ],
      faces,
    ),
  );
}

describe('quarantined A320neo proportion correction', () => {
  it('preserves exact review bytes and produces the pinned length/span in canonical axes', () => {
    const review = prepareMeshyReview(proportionFixture()).glb;
    const original = Buffer.from(review);
    const first = correctA320neoProportions(review, axisMatrix);
    const second = correctA320neoProportions(review, axisMatrix);
    const metrics = auditMeshyGeometry(first.glb).metrics;

    expect(review).toEqual(original);
    expect(first).toEqual(second);
    expect(metrics.boundsSourceUnits.extent[0]).toBeCloseTo(35.8, 4);
    expect(metrics.boundsSourceUnits.extent[2]).toBeCloseTo(37.57, 4);
    expect(metrics.boundsSourceUnits.min[1]).toBeCloseTo(0, 6);
    expect(metrics.sourceTriangles).toBe(4);
    expect(metrics.attributes.normalVertices).toBe(12);
    expect(first.report).toMatchObject({
      state: 'quarantine',
      canonicalFrameApplied: true,
      targetDimensionsMet: true,
      semanticPartsAssigned: false,
      liveryReady: false,
    });
  });

  it('refuses indexed source geometry instead of treating it as a review derivative', () => {
    expect(() => correctA320neoProportions(proportionFixture(), axisMatrix)).toThrow(
      'corner-expanded review derivative',
    );
  });

  it('moves disconnected review components rigidly without squeezing their local width', () => {
    const source = pack(
      fixture(
        [
          [-0.486328125, -0.15234375, -0.5],
          [0.486328125, -0.15234375, -0.5],
          [-0.486328125, 0.1572265625, 0.5],
          [0.486328125, 0.1572265625, 0.5],
          [-0.1, -0.05, 0.15],
          [0.1, -0.05, 0.15],
          [0, 0.05, 0.25],
        ],
        [...faces, [4, 5, 6]],
      ),
    );
    const corrected = correctA320neoProportions(prepareMeshyReview(source).glb, axisMatrix);
    const components = corrected.report.transform.componentCorrections;

    expect(components).toHaveLength(2);
    expect(components[1]).toMatchObject({
      method: 'rigid-lateral-reposition',
      triangles: 1,
    });
    expect(components[1]!.afterBoundsCanonicalMetres.extent[0]).toBeCloseTo(
      components[1]!.beforeBoundsCanonicalMetres.extent[0]!,
      8,
    );
  });

  it('refuses invalid axis matrices and candidates that do not need span reduction', () => {
    const review = prepareMeshyReview(proportionFixture()).glb;
    expect(() =>
      correctA320neoProportions(review, [
        [1, 0, 0],
        [1, 0, 0],
        [0, 0, 1],
      ]),
    ).toThrow('invalid reviewed axis matrix');
    expect(() =>
      correctA320neoProportions(review, [
        [0, 1, 0],
        [1, 0, 0],
        [0, 0, -1],
      ]),
    ).toThrow('does not require bounded span reduction');
  });
});
