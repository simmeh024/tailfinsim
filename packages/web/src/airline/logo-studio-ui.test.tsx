import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { OwnAirlineResponse } from '@tailfin/shared';

import { LogoStudioPage } from './LogoStudioPage';

const OWN: OwnAirlineResponse = {
  airline: {
    id: '33333333-4444-4555-8666-777777777777',
    worldId: '22222222-3333-4444-8555-666666666666',
    playerId: '11111111-2222-4333-8444-555555555555',
    kind: 'player',
    archetype: null,
    name: 'Tailfin Air',
    iataCode: 'TF',
    icaoCode: 'TFN',
    callsign: 'TAILFIN',
    baseCountry: 'NL',
    logo: null,
    cash: 50_000_000,
    reputation: 0.35,
    status: 'active',
    statusChangedAt: '2026-08-20T10:00:00.000Z',
    ceasedAt: null,
    createdAt: '2026-08-20T10:00:00.000Z',
  },
  rebrand: {
    costMinor: 2_500_000,
    mutableFields: ['name', 'callsign', 'baseCountry', 'logo'],
    immutableFields: ['iataCode', 'icaoCode', 'cash', 'reputation'],
  },
};

function answer(status: number, body: unknown) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  });
}

function stub(own: OwnAirlineResponse = OWN) {
  const updates: unknown[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/airlines/me' && init?.method === 'PATCH') {
        updates.push(JSON.parse(typeof init.body === 'string' ? init.body : '{}'));
        return answer(200, {
          airline: own.airline,
          changed: true,
          chargedMinor: 2_500_000,
          identityChangeId: 'x',
        });
      }
      if (url === '/api/airlines/me') return answer(200, own);
      return Promise.reject(new Error(`unexpected fetch: ${url}`));
    }),
  );
  return updates;
}

function renderStudio() {
  return render(
    <MemoryRouter initialEntries={['/airline/logo']}>
      <LogoStudioPage />
    </MemoryRouter>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the logo studio', () => {
  it('opens on the airline’s emblem with one seeded layer', async () => {
    stub();
    renderStudio();
    expect(
      await screen.findByRole('heading', { level: 1, name: /brand logo editor/i }),
    ).toBeInTheDocument();
    expect(screen.getByText('1 / 24')).toBeInTheDocument();
    // The initials layer is selected, so its properties are shown.
    expect(screen.getByLabelText('Initials')).toBeInTheDocument();
  });

  it('adds a layer, and undo removes it again', async () => {
    stub();
    renderStudio();
    await screen.findByRole('heading', { level: 1, name: /brand logo editor/i });

    fireEvent.click(screen.getByRole('button', { name: 'Circle' }));
    expect(screen.getByText('2 / 24')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Undo/ }));
    expect(screen.getByText('1 / 24')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Redo/ }));
    expect(screen.getByText('2 / 24')).toBeInTheDocument();
  });

  it('changes the frame shape from the toolbar', async () => {
    stub();
    renderStudio();
    await screen.findByRole('heading', { level: 1, name: /brand logo editor/i });

    const shield = screen.getByRole('button', { name: 'Shield' });
    expect(shield).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(shield);
    expect(shield).toHaveAttribute('aria-pressed', 'true');
  });

  it('edits a brand palette colour', async () => {
    stub();
    renderStudio();
    await screen.findByRole('heading', { level: 1, name: /brand logo editor/i });

    fireEvent.change(screen.getByLabelText('Background'), { target: { value: '#123456' } });
    expect(screen.getByText('#123456')).toBeInTheDocument();
  });

  it('rebrands: PATCHes a composed logo, carrying the identity fields unchanged', async () => {
    const updates = stub();
    renderStudio();
    await screen.findByRole('heading', { level: 1, name: /brand logo editor/i });

    fireEvent.click(screen.getByRole('button', { name: 'Rebrand for 25,000.00' }));
    await waitFor(() => expect(updates).toHaveLength(1));

    const body = updates[0] as {
      name: string;
      callsign: string;
      baseCountry: string;
      logo: { v: number; layers: unknown[] };
    };
    expect(body.name).toBe('Tailfin Air');
    expect(body.callsign).toBe('TAILFIN');
    expect(body.baseCountry).toBe('NL');
    expect(body.logo.v).toBe(2);
    expect(body.logo.layers.length).toBeGreaterThanOrEqual(1);
  });

  it('refuses to open a non-active airline', async () => {
    stub({ airline: { ...OWN.airline!, status: 'ceased' }, rebrand: null });
    renderStudio();
    expect(await screen.findByText(/cannot be rebranded right now/i)).toBeInTheDocument();
  });
});
