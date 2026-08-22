import { WorldRenderer } from './WorldRenderer';

import type { ReactNode } from 'react';

/**
 * The world, on the World page and nowhere else.
 *
 * App. H.4 describes the world as a permanent backdrop behind every screen, and
 * the shell was built that way: `<Outlet />` rendered *over* the renderer, in the
 * same grid area. In practice that was worse than the doc's intent in three ways
 * at once.
 *
 *   - **Every other page's content sat on top of the canvas.** A fleet table is
 *     opaque and full-width, so the world it covered was not a backdrop, it was
 *     a hidden layer that only cost frames.
 *   - **The map could not be driven from anywhere but the World page**, because
 *     the page content above it took the pointer. Dragging did nothing.
 *   - **The world was never seen properly**, which is the one thing §1's
 *     _"come back the next morning to see where your aircraft ended up"_ needs.
 *
 * So the renderer moved here. The World page is the world at full size, with
 * nothing over it; every other page gets the plain inset background. When the
 * live aircraft layer arrives (M7-02) this is the page it lands on.
 */
export function WorldPage(): ReactNode {
  return (
    <div className="world-page">
      {/* Named for screen readers, and visually hidden: the page *is* the map,
          and a heading floating over it would be the first thing covering the
          world again. */}
      <h1 className="visually-hidden">World</h1>
      <WorldRenderer />
    </div>
  );
}
