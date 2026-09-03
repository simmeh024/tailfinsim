import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CabinConfiguratorPage } from './CabinConfiguratorPage';

/**
 * A smoke test of the whole configurator (M6-08): it opens on a type, draws its
 * cabin, shows the live summary, and lets a row be selected and inspected. The
 * arithmetic is proved in `analysis.test.ts` and the history in `editor.test.ts`;
 * this proves the page wires them to the mockup's surfaces.
 */

function renderAt(type: string): void {
  render(
    <MemoryRouter initialEntries={[`/fleet/cabin?type=${encodeURIComponent(type)}`]}>
      <CabinConfiguratorPage />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  window.localStorage.clear();
});

describe('CabinConfiguratorPage', () => {
  it('opens on the requested type with its certified ceiling', () => {
    renderAt('A320neo');
    expect(screen.getByRole('heading', { level: 1, name: 'A320neo' })).toBeInTheDocument();
    expect(screen.getByText(/Certified max seats/)).toBeInTheDocument();
    expect(screen.getByText('186')).toBeInTheDocument();
  });

  it('shows the class split with a business chip', () => {
    renderAt('A320neo');
    // The J (business) chip code appears in the summary bar.
    expect(screen.getByText('J')).toBeInTheDocument();
  });

  it('selects a row and shows its detail in the inspector', () => {
    renderAt('A320neo');
    const row = screen.getByRole('button', { name: /^Row 1,/ });
    fireEvent.click(row);
    expect(screen.getByRole('heading', { name: 'Row 1' })).toBeInTheDocument();
    expect(screen.getByText('Seats in row')).toBeInTheDocument();
  });

  it('starts with Undo disabled and enables it after an edit', () => {
    renderAt('A320neo');
    const undo = screen.getByRole('button', { name: /Undo/ });
    expect(undo).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'Seat row' }));
    expect(undo).toBeEnabled();
  });

  it('flashes a confirmation when the config is saved', () => {
    renderAt('ATR 72');
    fireEvent.click(screen.getByRole('button', { name: 'Save config' }));
    expect(screen.getByRole('status')).toHaveTextContent(/saved/i);
  });
});
