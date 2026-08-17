import '@testing-library/jest-dom/vitest';

import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

/**
 * Unmount between tests.
 *
 * React Testing Library registers this automatically *only* when the test
 * framework's globals are injected. This repo imports `describe`/`it`/`expect`
 * explicitly rather than enabling `globals: true`, so the hook has to be wired
 * by hand — without it, every render stacks up in the same document and
 * `getByRole` starts reporting "multiple elements found".
 */
afterEach(() => {
  cleanup();
});

/**
 * jsdom does not implement `matchMedia`, and anything that queries
 * `prefers-reduced-motion` or a breakpoint will throw without it. Stubbed as
 * "no match" so components take their default branch.
 */
if (!globalThis.matchMedia) {
  Object.defineProperty(globalThis, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }),
  });
}
