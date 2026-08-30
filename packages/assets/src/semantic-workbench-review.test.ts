import { describe, expect, it } from 'vitest';

import {
  compressSemanticAssignments,
  expandSemanticDispositions,
} from './semantic-workbench-review';

const components = [
  { componentId: 'review_component_001', triangles: 6 },
  { componentId: 'review_component_002', triangles: 2 },
];

describe('semantic workbench range serialization', () => {
  it('round-trips deterministic component-local ranges without changing uncovered faces', () => {
    const assignments = new Map<string, (string | null)[]>([
      [
        'review_component_001',
        ['fuselage', 'fuselage', null, 'fuselage', 'wing_left', 'wing_left'],
      ],
      ['review_component_002', [null, 'discarded_artifact']],
    ]);
    const dispositions = compressSemanticAssignments(
      components,
      ['fuselage', 'wing_left', 'discarded_artifact'],
      assignments,
    );
    expect(dispositions).toEqual([
      {
        targetId: 'fuselage',
        componentId: 'review_component_001',
        ranges: [
          { startInclusive: 0, endExclusive: 2 },
          { startInclusive: 3, endExclusive: 4 },
        ],
      },
      {
        targetId: 'wing_left',
        componentId: 'review_component_001',
        ranges: [{ startInclusive: 4, endExclusive: 6 }],
      },
      {
        targetId: 'discarded_artifact',
        componentId: 'review_component_002',
        ranges: [{ startInclusive: 1, endExclusive: 2 }],
      },
    ]);
    expect(
      expandSemanticDispositions(
        components,
        new Set(['fuselage', 'wing_left', 'discarded_artifact']),
        dispositions,
      ),
    ).toEqual(assignments);
  });

  it('rejects shape drift, unknown targets, invalid ranges and overlap', () => {
    expect(() => compressSemanticAssignments(components, ['fuselage'], new Map())).toThrow(
      'shape changed',
    );
    expect(() =>
      expandSemanticDispositions(components, new Set(['fuselage']), [
        {
          targetId: 'unknown',
          componentId: 'review_component_001',
          ranges: [{ startInclusive: 0, endExclusive: 1 }],
        },
      ]),
    ).toThrow('unknown');
    expect(() =>
      expandSemanticDispositions(components, new Set(['fuselage']), [
        {
          targetId: 'fuselage',
          componentId: 'review_component_001',
          ranges: [{ startInclusive: 5, endExclusive: 7 }],
        },
      ]),
    ).toThrow('invalid');
    expect(() =>
      expandSemanticDispositions(components, new Set(['fuselage']), [
        {
          targetId: 'fuselage',
          componentId: 'review_component_001',
          ranges: [
            { startInclusive: 0, endExclusive: 2 },
            { startInclusive: 1, endExclusive: 3 },
          ],
        },
      ]),
    ).toThrow('overlaps');
  });
});
