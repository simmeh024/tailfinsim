import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router';
import { beforeEach, describe, expect, it } from 'vitest';

import { STAGE_ID, titleFor, useRouteIdentity } from './route-identity';

import type { ReactNode } from 'react';

/**
 * A route change says which page it is (UX-04).
 *
 * `<title>Tailfin</title>` was static for all twenty routes, so every browser
 * tab, history entry, bookmark and shared screenshot was identical — and
 * `document.title` was never assigned anywhere in `packages/web/src`. A
 * screen-reader user activated a rail link and heard silence: in a single-page
 * app a route change moves nothing in the accessibility tree by itself.
 */

/** The shell's two relevant parts, without the rest of the shell. */
function Harness({ children }: { children?: ReactNode }): ReactNode {
  useRouteIdentity();
  return (
    <>
      <a className="shell__skip" href={`#${STAGE_ID}`}>
        Skip to content
      </a>
      <main id={STAGE_ID} tabIndex={-1}>
        {children}
      </main>
    </>
  );
}

function Page({ name }: { name: string }): ReactNode {
  const navigate = useNavigate();
  return (
    <>
      <h1>{name}</h1>
      <button
        type="button"
        onClick={() => {
          void navigate('/fleet');
        }}
      >
        Go to fleet
      </button>
    </>
  );
}

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Harness>
        <Routes>
          <Route path="/world" element={<Page name="World" />} />
          <Route path="/fleet" element={<Page name="Fleet" />} />
          <Route path="/admin/players/:id" element={<Page name="Player" />} />
        </Routes>
      </Harness>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  document.title = 'unset';
});

describe('titleFor', () => {
  it('names the page and keeps the product', () => {
    // Both halves matter: the page name is what distinguishes a tab, and the
    // product name is what makes a bookmark recognisable out of context.
    expect(titleFor('/fleet')).toBe('Fleet · Tailfin');
    expect(titleFor('/network')).toBe('Network · Tailfin');
  });

  it('matches by longest prefix, so an id needs no row of its own', () => {
    expect(titleFor('/admin/players')).toBe('Players · Admin · Tailfin');
    expect(titleFor('/admin/players/cccccccc-1111-4222-8333-444444444444')).toBe(
      'Players · Admin · Tailfin',
    );
  });

  it('says both halves of a nested route', () => {
    // The console is a layout with its own sections, so "the route" has two
    // levels and a title that named only one would be ambiguous in a tab strip.
    expect(titleFor('/admin')).toBe('Admin console · Tailfin');
    expect(titleFor('/admin/economy')).toBe('Economy · Admin · Tailfin');
    // A more specific prefix wins over `/fleet`.
    expect(titleFor('/fleet/cabin')).toBe('Cabin · Fleet · Tailfin');
  });

  it('falls back to the product for a path it does not know', () => {
    // Rather than to whatever the previous page set, which is the failure mode
    // a per-page `useEffect` produces: a stale title is worse than a plain one
    // because it is actively wrong.
    expect(titleFor('/something-new')).toBe('Tailfin');
    expect(titleFor('/')).toBe('Tailfin');
  });
});

describe('navigating', () => {
  it('sets the title on arrival', () => {
    renderAt('/world');
    expect(document.title).toBe('World · Tailfin');
  });

  it('does not steal focus on arrival', () => {
    // The user has not navigated yet. Moving focus away from the document start
    // on load fights the browser and is its own bug.
    renderAt('/world');
    expect(document.getElementById(STAGE_ID)).not.toHaveFocus();
  });

  it('updates the title and moves focus when the route changes', async () => {
    renderAt('/world');
    screen.getByRole('button', { name: 'Go to fleet' }).click();

    await waitFor(() => {
      expect(document.title).toBe('Fleet · Tailfin');
    });
    /*
     * Focus on the stage is what makes a screen reader announce the new page and
     * puts the reader at the top of it — which is what following a link does
     * everywhere else, and what a router takes away.
     *
     * A live region would say the name and leave focus on the link just
     * activated, so the next key press would continue through the navigation.
     */
    expect(document.getElementById(STAGE_ID)).toHaveFocus();
  });
});

describe('the skip link', () => {
  it('is first in the DOM and points at the stage', () => {
    // First, because a skip link that comes after the navigation skips nothing.
    renderAt('/world');
    const skip = screen.getByRole('link', { name: 'Skip to content' });
    expect(skip).toHaveAttribute('href', `#${STAGE_ID}`);
    expect(document.body.textContent?.indexOf('Skip to content')).toBe(0);
  });

  it('stays in the tab order rather than being hidden', () => {
    // `display: none` would take it out of the tab order and defeat the point,
    // so it is positioned off-screen and comes back on focus. Asserted here as
    // "it is a real link in the document", which is the part JSDOM can see.
    renderAt('/world');
    expect(screen.getByRole('link', { name: 'Skip to content' })).toBeVisible();
  });
});
