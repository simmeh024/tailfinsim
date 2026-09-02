import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CurrenciesResponse, MeResponse } from '@tailfin/shared';

import { SessionProvider } from '../auth/SessionProvider';
import { CurrencyProvider } from '../currency/CurrencyProvider';

import * as reloadModule from './reload';
import { SettingsPage } from './SettingsPage';

/**
 * The Settings page (M8-02).
 *
 * The currency selector pins the top five above the rest and persists a choice
 * through `PUT /api/me/currency`. Rendered inside its real providers with a
 * stubbed fetch, so the wiring — session → currency → selector — is exercised.
 */
const SIGNED_IN: MeResponse = {
  player: {
    id: '11111111-2222-3333-4444-555555555555',
    displayName: 'Currency Pilot',
    avatarUrl: null,
    displayCurrency: 'USD',
    createdAt: '2026-08-17T09:00:00.000Z',
  },
  registrationOpen: false,
  isAdmin: false,
};

function rate(code: string, name: string, symbol: string, rateE6: number, top: boolean) {
  return {
    code,
    name,
    symbol,
    decimals: code === 'JPY' ? 0 : 2,
    rateE6,
    refreshedAt: '2024-01-01T00:00:00.000Z',
    top,
  };
}

const CURRENCIES: CurrenciesResponse = {
  currencies: [
    rate('USD', 'US Dollar', '$', 1_000_000, true),
    rate('EUR', 'Euro', '€', 900_000, true),
    rate('GBP', 'British Pound', '£', 790_000, true),
    rate('JPY', 'Japanese Yen', '¥', 149_000_000, true),
    rate('AUD', 'Australian Dollar', 'A$', 1_520_000, true),
    rate('CAD', 'Canadian Dollar', 'C$', 1_360_000, false),
  ],
  top: ['USD', 'EUR', 'GBP', 'JPY', 'AUD'],
};

let putCalls: unknown[];

beforeEach(() => {
  putCalls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/currencies') {
        return Promise.resolve(new Response(JSON.stringify(CURRENCIES), { status: 200 }));
      }
      if (url === '/api/me/currency') {
        putCalls.push(JSON.parse((init?.body as string | undefined) ?? '{}'));
        return Promise.resolve(new Response(JSON.stringify({ currency: 'EUR' }), { status: 200 }));
      }
      // /api/me and anything else: a signed-in session.
      return Promise.resolve(new Response(JSON.stringify(SIGNED_IN), { status: 200 }));
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function renderSettings() {
  return render(
    <MemoryRouter>
      <SessionProvider>
        <CurrencyProvider>
          <SettingsPage />
        </CurrencyProvider>
      </SessionProvider>
    </MemoryRouter>,
  );
}

describe('SettingsPage currency selector', () => {
  it('pins the top five above the rest, in order', async () => {
    renderSettings();
    const topLabel = await screen.findByText('Top currencies');
    const pinnedGrid = topLabel.nextElementSibling as HTMLElement;
    const codes = within(pinnedGrid)
      .getAllByRole('button')
      .map((b) => within(b).getByText(/^[A-Z]{3}$/).textContent);
    expect(codes).toEqual(['USD', 'EUR', 'GBP', 'JPY', 'AUD']);

    // CAD is under "All currencies", not pinned.
    expect(screen.getByText('All currencies')).toBeInTheDocument();
    expect(screen.getByText('Canadian Dollar')).toBeInTheDocument();
  });

  it('selects a currency, then persists and refreshes only on Save', async () => {
    const reload = vi.spyOn(reloadModule, 'reloadPage').mockImplementation(() => undefined);

    renderSettings();
    const usd = await screen.findByRole('button', { name: /US Dollar/ });
    expect(usd).toHaveAttribute('aria-pressed', 'true');

    // Save is disabled until a different currency is picked.
    const save = screen.getByRole('button', { name: 'Save' });
    expect(save).toBeDisabled();

    // Picking Euro selects it but does not save yet.
    fireEvent.click(screen.getByRole('button', { name: /Euro/ }));
    expect(screen.getByRole('button', { name: /Euro/ })).toHaveAttribute('aria-pressed', 'true');
    expect(save).toBeEnabled();
    expect(putCalls).toEqual([]);

    // Save persists the choice and refreshes.
    fireEvent.click(save);
    await waitFor(() => {
      expect(putCalls).toEqual([{ currency: 'EUR' }]);
    });
    await waitFor(() => {
      expect(reload).toHaveBeenCalledTimes(1);
    });
  });
});
