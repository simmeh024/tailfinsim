import { describe, expect, it } from 'vitest';

import { semanticWorkbenchCloseUpIncludes } from './semantic-workbench-camera';

const bounds = {
  min: { x: -18, y: -5, z: -19 },
  max: { x: 18, y: 7, z: 19 },
} as const;

describe('semantic workbench close-up regions', () => {
  it('selects only the intended candidate-relative extremity', () => {
    expect(semanticWorkbenchCloseUpIncludes(bounds, 'winglet_left', { x: -17, y: 0, z: 0 })).toBe(
      true,
    );
    expect(semanticWorkbenchCloseUpIncludes(bounds, 'winglet_left', { x: -10, y: 0, z: 0 })).toBe(
      false,
    );
    expect(semanticWorkbenchCloseUpIncludes(bounds, 'winglet_right', { x: 17, y: 0, z: 0 })).toBe(
      true,
    );
    expect(semanticWorkbenchCloseUpIncludes(bounds, 'winglet_right', { x: 10, y: 0, z: 0 })).toBe(
      false,
    );
    expect(semanticWorkbenchCloseUpIncludes(bounds, 'tail', { x: 0, y: 0, z: 18 })).toBe(true);
    expect(semanticWorkbenchCloseUpIncludes(bounds, 'tail', { x: 0, y: 0, z: 10 })).toBe(false);
  });
});
