import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import * as placeholders from './Placeholder';

/**
 * What is left of the placeholders, and that it says true things (SURFACE-08).
 *
 * One page is still waiting for its milestone. The rest were filled and their
 * placeholders removed — a placeholder that names a closed issue is confidently
 * wrong, and an unused export is how the next one gets written.
 *
 * Deliberately **no assertion on a placeholder's wording**: SURFACE-08 asks that
 * no test depend on placeholder copy, so a note can be corrected without a test
 * having to be. What is held here is structure — which placeholders exist, and
 * that no real page is routed through one.
 */

const here = dirname(fileURLToPath(import.meta.url));
const APP = readFileSync(resolve(here, '..', 'App.tsx'), 'utf8');

describe('the placeholders that remain', () => {
  it('are the Board page and the component it uses, and nothing else', () => {
    expect(Object.keys(placeholders).sort()).toEqual(['BoardPage', 'Placeholder']);
  });

  it('routes no real page through a placeholder', () => {
    // Finance is SURFACE-03's page; Crew has been real since M5-01.
    expect(APP).not.toMatch(/routes\/Placeholder'\)\)\.(FinancePage|CrewPage)/);
    expect(APP).toMatch(/finance\/FinancePage/);
  });
});
