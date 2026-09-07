import { render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CashRunwayResponse, MeResponse } from '@tailfin/shared';

import { App } from '../App';

/**
 * §13.6's runway in the status strip, and M8-08's second acceptance criterion.
 *
 * > Below 30 days it becomes the most prominent number on screen.
 *
 * Which is a claim about **layout**, not about colour, so that is what these
 * assert: the item leads the strip rather than sitting third in a row of small
 * figures, and it carries the critical treatment. The threshold itself is the
 * server's — these tests hand the client a `critical` flag and never recompute
 * it, because neither does the client.
 */

const SIGNED_IN: MeResponse = {
  player: {
    id: '11111111-2222-3333-4444-555555555555',
    displayName: 'Runway Tester',
    avatarUrl: null,
    displayCurrency: 'USD',
    createdAt: '2026-08-17T09:00:00.000Z',
  },
  registrationOpen: false,
  signInProviders: [],
  isAdmin: false,
};

const AIRLINE = {
  airline: {
    id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    worldId: 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff',
    playerId: SIGNED_IN.player?.id,
    name: 'Runway Air',
    iataCode: 'RW',
    icaoCode: 'RWY',
    callsign: 'RUNWAY',
    baseCountry: 'NL',
    cash: 50_000_000,
    reputation: 0.35,
    status: 'active',
    statusChangedAt: '2026-08-17T10:00:00.000Z',
    ceasedAt: null,
    createdAt: '2026-08-17T10:00:00.000Z',
  },
  rebrand: {
    costMinor: 2_500_000,
    mutableFields: ['name'],
    immutableFields: ['iataCode'],
  },
};

function runwayBody(overrides: Partial<CashRunwayResponse> = {}): CashRunwayResponse {
  return {
    gameNow: '2027-03-10T00:00:00.000Z',
    cashMinor: 50_000_000,
    days: 184,
    horizonDays: 365,
    critical: false,
    criticalBelowDays: 30,
    dailyOperatingMinor: -250_000,
    rateWindowDays: 30,
    committedMinor: 12_000_000,
    owedNowMinor: 0,
    tippedBy: null,
    upcoming: [],
    ...overrides,
  };
}

/** The shell's other reads answered plainly, so only the runway varies. */
function stubFetch(runway: unknown): void {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: unknown) => {
      const url = String(input);
      const body =
        url === '/api/me'
          ? SIGNED_IN
          : url === '/api/airlines/me'
            ? AIRLINE
            : url === '/api/finance/runway'
              ? runway
              : {};
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
    }),
  );
}

async function renderShell() {
  const result = render(
    <MemoryRouter initialEntries={['/fleet']}>
      <App />
    </MemoryRouter>,
  );
  await screen.findByRole('navigation', { name: 'Main' });
  return result;
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('the cash runway in the status strip', () => {
  it('shows the runway in game days, at all times', async () => {
    stubFetch(runwayBody());
    await renderShell();

    const strip = screen.getByLabelText('Status');
    await waitFor(() => expect(within(strip).getByText('184 days')).toBeInTheDocument());
    expect(within(strip).getByText('Runway')).toBeInTheDocument();
  });

  it('leads the strip and takes the critical treatment below 30 days (AC2)', async () => {
    stubFetch(runwayBody({ days: 11, critical: true }));
    const { container } = await renderShell();

    const strip = screen.getByLabelText('Status');
    await waitFor(() => expect(within(strip).getByText(/11 days/)).toBeInTheDocument());

    // Position: first item in the strip, ahead of Cash. A red figure third in a
    // row of six is not "the single most prominent number on screen".
    const items = [...strip.querySelectorAll('.strip__item')];
    expect(items[0]?.classList.contains('strip__item--critical')).toBe(true);
    expect(items[0]?.textContent).toContain('Runway');
    expect(items[1]?.textContent).toContain('Cash');

    // …and it announces itself rather than only changing colour (H.4, H.7).
    expect(container.querySelector('.strip__item--critical')?.getAttribute('role')).toBe('status');
    expect(within(strip).getByText(/left/)).toBeInTheDocument();
  });

  it('stays quiet, and third, above the threshold', async () => {
    stubFetch(runwayBody({ days: 31 }));
    await renderShell();

    const strip = screen.getByLabelText('Status');
    await waitFor(() => expect(within(strip).getByText('31 days')).toBeInTheDocument());
    const items = [...strip.querySelectorAll('.strip__item')];
    expect(items[0]?.textContent).toContain('Cash');
    expect(strip.querySelector('.strip__item--critical')).toBeNull();
  });

  it('says "365+ days" rather than inventing a number past the horizon', async () => {
    stubFetch(runwayBody({ days: null }));
    await renderShell();
    await waitFor(() =>
      expect(within(screen.getByLabelText('Status')).getByText('365+ days')).toBeInTheDocument(),
    );
  });

  it('renders an unknown runway rather than taking the shell down', async () => {
    // The strip is on every page, so an unshaped body here would break the whole
    // app rather than one panel. The client parses; a body that does not is null.
    stubFetch({ days: 'soon' });
    await renderShell();

    const strip = screen.getByLabelText('Status');
    expect(within(strip).getByText('Runway')).toBeInTheDocument();
    /*
     * `getAllByText` since M8-13: the alert count renders the same em dash when
     * no sweep has run, and this fixture stubs neither endpoint. Two unknown
     * figures in the strip is the correct render, so the query is the ambiguous
     * one rather than the page.
     */
    await waitFor(() => {
      expect(within(strip).getAllByText('—').length).toBeGreaterThan(0);
    });
  });
});
