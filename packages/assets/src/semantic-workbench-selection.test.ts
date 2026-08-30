import { describe, expect, it } from 'vitest';

import { semanticWorkbenchFloodCompatible } from './semantic-workbench-selection';

describe('semantic workbench flood boundary protection', () => {
  it('assigns only uncovered faces', () => {
    expect(semanticWorkbenchFloodCompatible(null, null, false)).toBe(true);
    expect(semanticWorkbenchFloodCompatible(null, 'wing_left', false)).toBe(false);
  });

  it('clears only faces carrying the seed label', () => {
    expect(semanticWorkbenchFloodCompatible('wing_left', 'wing_left', true)).toBe(true);
    expect(semanticWorkbenchFloodCompatible('wing_left', 'fuselage', true)).toBe(false);
    expect(semanticWorkbenchFloodCompatible(null, null, true)).toBe(false);
  });
});
