import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router';
import { describe, expect, it, vi } from 'vitest';

import { LiveryBuilderPage } from './LiveryBuilder';

import type { OwnAirlineShellContext } from '../shell/AppShell';

/**
 * The design studio before it has an airline to paint (UX pass, UX-07).
 *
 * Its three gate states used to be a heading and a bare paragraph each: the
 * loading one silent to anything but a polite live region, the failure one with
 * an unstyled button, and the no-airline one a dead end with nothing to press.
 * They go through `ui/StateBlock` now, and the dead end has a way forward.
 */

function renderWith(context: Partial<OwnAirlineShellContext>) {
  const full = {
    ownAirline: null,
    ownAirlineLoading: false,
    ownAirlineError: false,
    reloadOwnAirline: vi.fn(() => Promise.resolve()),
    ...context,
  } as unknown as OwnAirlineShellContext;
  render(
    <MemoryRouter initialEntries={['/design']}>
      <Routes>
        <Route element={<Outlet context={full} />}>
          <Route path="/design" element={<LiveryBuilderPage />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
  return full;
}

describe('the design studio gate', () => {
  it('announces the identity read as a loading state', () => {
    renderWith({ ownAirlineLoading: true });
    expect(screen.getByRole('status')).toHaveTextContent('Loading your airline identity…');
  });

  it('offers a retry when the airline could not be read', () => {
    const context = renderWith({ ownAirlineError: true });
    expect(screen.getByRole('alert')).toHaveTextContent(/could not load the airline/);
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(context.reloadOwnAirline).toHaveBeenCalledTimes(1);
  });

  it('points a player with no airline at the founding desk instead of a dead end', () => {
    renderWith({
      ownAirline: { airline: null } as unknown as OwnAirlineShellContext['ownAirline'],
    });
    expect(screen.getByRole('heading', { name: 'Found an airline first' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open the founding desk' })).toHaveAttribute(
      'href',
      '/found',
    );
  });
});
