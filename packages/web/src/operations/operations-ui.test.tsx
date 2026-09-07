import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { MeResponse, OperationsDashboardResponse } from '@tailfin/shared';

import { App } from '../App';

/**
 * §14.3's operational dashboards — M8-12's three acceptance criteria.
 *
 * The third one is the interesting one to test: *"each dashboard shares one
 * consistent chart language"*. That is not something a render assertion can
 * see, so it is enforced structurally — this suite reads the page's own source
 * and fails if it declares a component class that `dashboard.css` does not.
 *
 * A second visual vocabulary inside one milestone is exactly what §14.6 rules
 * out, and the way it happens is somebody adding one page with its own idea of
 * a bar.
 */

const here = dirname(fileURLToPath(import.meta.url));
const DASHBOARD_CSS = readFileSync(resolve(here, '..', 'dashboard', 'dashboard.css'), 'utf8');
const SHELL_CSS = readFileSync(resolve(here, '..', 'shell', 'shell.css'), 'utf8');
const UI_CSS = readFileSync(resolve(here, '..', 'ui', 'ui.css'), 'utf8');

const SIGNED_IN: MeResponse = {
  player: {
    id: '11111111-2222-3333-4444-555555555555',
    displayName: 'Ops Tester',
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
    name: 'Ops Air',
    iataCode: 'OP',
    icaoCode: 'OPS',
    callsign: 'OPS',
    baseCountry: 'NL',
    cash: 50_000_000,
    reputation: 0.44,
    status: 'active',
    statusChangedAt: '2026-08-17T10:00:00.000Z',
    ceasedAt: null,
    createdAt: '2026-08-17T10:00:00.000Z',
  },
  rebrand: { costMinor: 2_500_000, mutableFields: ['name'], immutableFields: ['iataCode'] },
};

function operations(
  overrides: Partial<OperationsDashboardResponse> = {},
): OperationsDashboardResponse {
  return {
    gameNow: '2027-03-10T00:00:00.000Z',
    windowDays: 30,
    flights: 240,
    traffic: {
      passengers: 32_400,
      cargoTonnes: 84.5,
      askKm: 8_640_000,
      rpkKm: 6_912_000,
      rtkKm: 42_250,
      loadFactor: 0.8,
      spilledPassengers: 1_240,
      spillRate: 0.037,
      yieldMinor: 12.5,
    },
    punctuality: {
      onTimeD0: 0.52,
      onTimeD15: 0.86,
      cancellationRate: 0.02,
      cancelledFlights: 5,
      totalDelayMinutes: 1_860,
      byCause: [
        { cause: 'technical', minutes: 720, flights: 12 },
        { cause: 'unattributed', minutes: 540, flights: 40 },
        { cause: 'weather_origin', minutes: 380, flights: 9 },
        { cause: 'crew_timeout', minutes: 220, flights: 3 },
      ],
    },
    fleet: {
      airframes: 8,
      aogCount: 1,
      inCheck: 1,
      blockHoursPerDay: 9.4,
      costPerBlockHourMinor: 480_000,
      ageProfile: [
        { label: 'Under 5', airframes: 3 },
        { label: '5–10', airframes: 4 },
        { label: '10–20', airframes: 1 },
        { label: 'Over 20', airframes: 0 },
      ],
    },
    crew: {
      headcount: 120,
      byRank: [
        { rank: 'captain', headcount: 24, onDuty: 8, reserve: 4, unavailable: 2, sick: 1 },
        { rank: 'cabin_crew', headcount: 72, onDuty: 30, reserve: 10, unavailable: 0, sick: 3 },
      ],
      moraleByBase: [
        { airportIcao: 'EHAM', morale: 0.62, headcount: 80 },
        { airportIcao: 'EGLL', morale: null, headcount: 40 },
      ],
      reserveCoverage: 0.12,
      converting: 2,
    },
    ground: {
      activeContracts: 3,
      selfHandledStations: 1,
      expiries: [
        {
          airportIcao: 'EHAM',
          serviceLine: 'ramp',
          grade: 'premium',
          termEnd: '2027-03-18T00:00:00.000Z',
          daysRemaining: 8,
        },
        {
          airportIcao: 'EGLL',
          serviceLine: 'passenger',
          grade: 'standard',
          termEnd: null,
          daysRemaining: null,
        },
      ],
    },
    productScore: null,
    reputation: 0.44,
    revenueMinor: 20_000_000,
    costMinor: 16_000_000,
    ...overrides,
  };
}

function stubFetch(body: unknown = operations()): void {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: unknown) => {
      const url = String(input).split('?')[0] ?? '';
      const payload =
        url === '/api/me'
          ? SIGNED_IN
          : url === '/api/airlines/me'
            ? AIRLINE
            : url === '/api/statistics/operations'
              ? body
              : {};
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(payload) });
    }),
  );
}

async function renderOperations() {
  const result = render(
    <MemoryRouter initialEntries={['/operations']}>
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

describe('the operations page', () => {
  it('shows all five of §14.3’s operational dashboards', async () => {
    stubFetch();
    await renderOperations();
    for (const section of [
      'Traffic and commercial',
      'Punctuality',
      'Fleet and maintenance',
      'Crew',
      'Ground and vendors',
    ]) {
      expect(await screen.findByLabelText(section)).toBeInTheDocument();
    }
  });

  it('attributes delay minutes by the M2-08 taxonomy (AC1)', async () => {
    stubFetch();
    await renderOperations();

    const chart = await screen.findByLabelText('Delay minutes by cause');
    const labels = [...chart.querySelectorAll('.profit-chart__label')].map(
      (node) => node.textContent,
    );
    // M2-08's own causes, in words, worst first.
    expect(labels[0]).toBe('Technical');
    expect(labels).toContain('Weather at origin');
    expect(labels).toContain('Crew out of hours');
  });

  it('lists unattributed delay rather than dropping it (AC1)', async () => {
    stubFetch();
    await renderOperations();

    const chart = await screen.findByLabelText('Delay minutes by cause');
    /*
     * The row that keeps the attribution honest. Dropping it would show a
     * player less delay than they suffered, and the causes would silently
     * disagree with the total beside them.
     */
    expect(within(chart).getByText('Not attributed')).toBeInTheDocument();

    const panel = screen.getByLabelText('Punctuality');
    expect(panel.textContent).toContain('1,860 min');
    // 720 + 540 + 380 + 220 = 1,860, so nothing is unaccounted for and the page
    // says nothing about a discrepancy.
    expect(panel.textContent).not.toContain('unaccounted for');
    expect(panel.textContent).toContain('not one of M2-08');
  });

  it('says when the causes do not add up to the total', async () => {
    // A discrepancy is worth showing rather than hiding: it means the fold and
    // the headline disagree, which is a bug in the server, not in the page.
    stubFetch(
      operations({
        punctuality: {
          ...operations().punctuality,
          totalDelayMinutes: 2_000,
        },
      }),
    );
    await renderOperations();
    const panel = await screen.findByLabelText('Punctuality');
    await waitFor(() => expect(panel.textContent).toContain('140 unaccounted for'));
  });

  it('surfaces spill as passengers turned away (AC2)', async () => {
    stubFetch();
    await renderOperations();

    const traffic = await screen.findByLabelText('Traffic and commercial');
    // The count leads. A rate says you are losing 3.7% of something; a count
    // says you turned away 1,240 people, which is a decision.
    expect(traffic.textContent).toContain('Turned away');
    expect(traffic.textContent).toContain('1,240 passengers');
    // The rate is context beside it, not the headline.
    expect(traffic.textContent).toContain('3.7% of demand');
  });

  it('reads a never-reviewed base as never reviewed, not as unhappy crew', async () => {
    stubFetch();
    await renderOperations();
    const crew = await screen.findByLabelText('Crew');
    // `crew_base.morale` null has meant "never reviewed" since M5-03, and a
    // production world without a worker never reviews one.
    expect(crew.textContent).toContain('not reviewed');
  });

  it('names a contract with no term rather than inventing one', async () => {
    stubFetch();
    await renderOperations();
    const ground = await screen.findByLabelText('Ground and vendors');
    // A legacy contract signed before terms existed never lapses. That is a
    // real answer, not an unknown one.
    expect(ground.textContent).toContain('no term');
    expect(ground.textContent).toContain('8 game days');
  });

  it('names what §14.3 asks for and the game cannot answer', async () => {
    stubFetch();
    const { container } = await renderOperations();
    await screen.findByLabelText('Traffic and commercial');
    const notes = [...container.querySelectorAll('.page__note')]
      .map((node) => node.textContent ?? '')
      .join(' ');
    for (const absent of ['booking curve', 'scorecards', 'satisfaction by class']) {
      expect(notes).toContain(absent);
    }
    // And the production trap, said in words on the page itself.
    expect(notes).toContain('Only the worker settles a flight');
  });

  it('says the page is broken rather than showing a zeroed airline', async () => {
    stubFetch({ traffic: 'nope' });
    await renderOperations();
    await waitFor(() => expect(screen.getByText(/could not be read/i)).toBeInTheDocument());
  });
});

describe('one chart language (AC3)', () => {
  it('declares no component class the shared stylesheets do not', () => {
    /*
     * The structural form of *"each dashboard shares one consistent chart
     * language"*. Every `className` this page writes must already be declared
     * in `dashboard.css`, `shell.css` or `ui.css` — the three stylesheets
     * M8-10's chart language lives in.
     *
     * A render assertion cannot see this: a page with its own `.ops-bar` would
     * look fine in jsdom and be a second vocabulary in the product.
     */
    const declared = `${DASHBOARD_CSS}\n${SHELL_CSS}\n${UI_CSS}`;
    const sources = readdirSync(here)
      .filter((name) => name.endsWith('.tsx') && !name.endsWith('.test.tsx'))
      .map((name) => readFileSync(join(here, name), 'utf8'));
    expect(sources.length).toBeGreaterThan(0);

    const undeclared = new Set<string>();
    for (const source of sources) {
      for (const match of source.matchAll(/className=(?:"([^"]+)"|\{'([^']+)'\})/g)) {
        for (const token of (match[1] ?? match[2] ?? '').split(/\s+/)) {
          if (token === '' || token.startsWith('${')) continue;
          if (!declared.includes(`.${token}`)) undeclared.add(token);
        }
      }
    }

    expect(
      [...undeclared],
      'These classes are written by the operations page and declared by none of ' +
        'the shared stylesheets. §14.6 asks for one chart language across every ' +
        'dashboard; a page with its own is how a second one starts:\n  ' +
        [...undeclared].join('\n  '),
    ).toEqual([]);
  });

  it('reuses the profit chart’s own bar rather than inventing a second', () => {
    const source = readFileSync(join(here, 'DelayAttribution.tsx'), 'utf8');
    expect(source).toContain('profit-chart__rows');
    expect(source).toContain('profit-chart__bar');
    // And it adds no stylesheet of its own.
    expect(readdirSync(here).filter((name) => name.endsWith('.css'))).toEqual([]);
  });
});
