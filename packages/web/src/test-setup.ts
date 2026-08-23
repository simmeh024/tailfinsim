import '@testing-library/jest-dom/vitest';

import { cleanup, configure } from '@testing-library/react';
import { afterEach, beforeEach, vi } from 'vitest';

/**
 * How long an async query may wait for the DOM to catch up.
 *
 * DOM Testing Library's default is one second, which is a budget sized for a real
 * browser doing real work. Nothing here does any: every `fetch` is a stub that has
 * already resolved, so a `findBy*` is not waiting on I/O — it is waiting for
 * React's scheduler to be given the CPU to commit the next render. A full-suite
 * run puts a jsdom worker on every core at once, and on a loaded machine a commit
 * has stayed queued for longer than that second: three tests that take between a
 * tenth and a third of a second on their own have measured 1.2s, 1.3s and worse,
 * and failed reporting a missing element rather than a page still loading.
 *
 * So this is a bound on a hang, not a delay anybody pays — a query that is going
 * to pass returns on its first poll and never sees this number. It is the second
 * half of the fix; `test-gates.ts` is the first, and the one that matters, because
 * a longer budget for an unnamed wait only moves the coin flip.
 *
 * **It has to stay under the project's `testTimeout`**, which `vitest.config.ts`
 * raises to twenty seconds for exactly this reason. Set to five against Vitest's
 * own five-second default, a slow query spends the entire test and the failure
 * arrives as "Test timed out in 5000ms" — which names neither the query nor the
 * gate, and is a worse report than the one this is here to fix.
 */
configure({ asyncUtilTimeout: 5000 });

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

/**
 * jsdom ships without `ImageData`, which belongs to the canvas API it stubs out.
 *
 * The world renderer builds its ocean fill and its day/night field as `ImageData`
 * because that is the one image source deck.gl will actually **upload**: handed a
 * plain `{ data, width, height }` it creates a texture of the right dimensions
 * containing nothing at all, and the world renders black. So the shape matters in
 * production and has to exist here.
 *
 * Data only — no decoding, no colour management, nothing jsdom would need a real
 * canvas for. `layers.test.ts` reads `width`, `height` and `data` and no more.
 */
if (!globalThis.ImageData) {
  Object.defineProperty(globalThis, 'ImageData', {
    writable: true,
    value: class {
      readonly data: Uint8ClampedArray;
      readonly width: number;
      readonly height: number;
      readonly colorSpace = 'srgb' as const;

      constructor(data: Uint8ClampedArray, width: number, height?: number) {
        this.data = data;
        this.width = width;
        this.height = height ?? data.length / 4 / width;
      }
    },
  });
}
