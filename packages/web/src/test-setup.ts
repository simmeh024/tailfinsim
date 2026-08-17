import '@testing-library/jest-dom/vitest';

import { cleanup } from '@testing-library/react';
import { afterEach, beforeEach, vi } from 'vitest';

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
 * No test may reach the network.
 *
 * `SessionProvider` calls `GET /api/me` on mount, so *every* test that renders
 * the app would otherwise attempt a fetch. The default stub returns a promise
 * that never settles, which parks the session in its `loading` state: no network,
 * and no state update arriving after the test body has finished — which is what
 * produces "an update was not wrapped in act(...)" and, eventually, flake.
 *
 * Tests that care about a signed-in or anonymous state stub `fetch` themselves
 * and await the resulting render through `findBy*`.
 */
beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => new Promise<Response>(() => undefined)),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
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
