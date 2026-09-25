import { fireEvent, render, screen } from '@testing-library/react';
import { Link, MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PageErrorBoundary } from './PageErrorBoundary';

import type { MockInstance } from 'vitest';

/**
 * A page that throws while rendering shows as broken; everything around it stays.
 *
 * Before this boundary existed nothing in the client caught a render error, so
 * one page's bug unmounted the root and left a blank window.
 */

function Explodes(): never {
  throw new Error('This page cannot render');
}

let quiet: MockInstance;

beforeEach(() => {
  // React reports every caught render error to the console; that is expected here.
  quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  quiet.mockRestore();
});

describe('PageErrorBoundary', () => {
  it('shows the page as broken instead of unmounting what surrounds it', () => {
    render(
      <MemoryRouter>
        <nav>The rail</nav>
        <PageErrorBoundary>
          <Explodes />
        </PageErrorBoundary>
      </MemoryRouter>,
    );

    expect(screen.getByText(/This page hit an error/)).toBeInTheDocument();
    expect(screen.getByText('The rail')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reload' })).toBeInTheDocument();
  });

  it('clears when the player moves to another page', () => {
    render(
      <MemoryRouter initialEntries={['/broken']}>
        <Link to="/fine">Somewhere else</Link>
        <PageErrorBoundary>
          <Routes>
            <Route path="/broken" element={<Explodes />} />
            <Route path="/fine" element={<p>A page that works</p>} />
          </Routes>
        </PageErrorBoundary>
      </MemoryRouter>,
    );
    expect(screen.getByText(/This page hit an error/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('link', { name: 'Somewhere else' }));
    expect(screen.getByText('A page that works')).toBeInTheDocument();
    expect(screen.queryByText(/This page hit an error/)).not.toBeInTheDocument();
  });
});
