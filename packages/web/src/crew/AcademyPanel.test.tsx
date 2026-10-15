import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AcademiesResponse } from '@tailfin/shared';

import { setDisplayCurrency } from '../currency/display';

import { AcademyPanel } from './AcademyPanel';
import {
  academies,
  buildingSite,
  EHAM_ID,
  GAME_NOW,
  LFPG_BASE,
  offer,
  quote,
  trainingCentre,
} from './test-academies';

/**
 * The training academies section of the Crew page (SURFACE-10).
 *
 * What is tested is what the section *says* and what it *sends*: every figure is
 * the server's (the fixtures use prices the shipped balance does not, so a
 * figure found on the page was printed from the response), a write is two clicks
 * and sent exactly once, the answer replaces the page's state whole, a refusal
 * replaces nothing and names its code, and nothing claims an academy makes the
 * airline more popular (§10.4).
 */

interface Call {
  url: string;
  method: string;
  body: unknown;
}

interface Server {
  read: AcademiesResponse | 'fail' | 'pending' | 'no-airline';
  /** What the next write answers; `'reject'` drops the connection, `'pending'` never answers. */
  write?: { status: number; body: unknown } | 'reject' | 'pending';
  calls: Call[];
}

function serve(server: Server): void {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: unknown, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      server.calls.push({
        url,
        method,
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      });
      const json = (status: number, body: unknown) =>
        Promise.resolve({ ok: status < 300, status, json: () => Promise.resolve(body) });

      if (url === '/api/academies' && method === 'GET') {
        if (server.read === 'pending') return new Promise(() => undefined);
        if (server.read === 'fail') return json(500, {});
        if (server.read === 'no-airline') {
          return json(409, { code: 'airline_required', message: 'Found an airline first' });
        }
        return json(200, server.read);
      }
      if (url.startsWith('/api/academies') && method === 'POST') {
        const write = server.write ?? { status: 500, body: {} };
        if (write === 'reject') return Promise.reject(new Error('connection reset'));
        if (write === 'pending') return new Promise(() => undefined);
        return json(write.status, write.body);
      }
      return Promise.reject(new Error(`unexpected fetch: ${method} ${url}`));
    }),
  );
}

function posts(server: Server): Call[] {
  return server.calls.filter((call) => call.method === 'POST');
}

function reads(server: Server): Call[] {
  return server.calls.filter((call) => call.method === 'GET');
}

function renderPanel(gameNow: Date | null = GAME_NOW): void {
  render(<AcademyPanel inGameTime={gameNow} />);
}

async function card(icao: string): Promise<HTMLElement> {
  const heading = await screen.findByRole('heading', { level: 3, name: new RegExp(icao) });
  const article = heading.closest('article');
  if (article === null) throw new Error(`no card for ${icao}`);
  return article;
}

afterEach(() => {
  vi.unstubAllGlobals();
  setDisplayCurrency('USD', []);
});

describe('the four states (StateBlock)', () => {
  it('says it is loading while the read is in flight', () => {
    serve({ read: 'pending', calls: [] });
    renderPanel();
    expect(screen.getByRole('status')).toHaveTextContent('Reading your academies…');
  });

  it('tells a failed read apart from having none, and reloads on request', async () => {
    const server: Server = { read: 'fail', calls: [] };
    serve(server);
    renderPanel();
    expect(await screen.findByRole('alert')).toHaveTextContent(/Could not load your academies/);

    server.read = academies();
    fireEvent.click(screen.getByRole('button', { name: 'Reload academies' }));
    expect(await screen.findByRole('heading', { name: /EHAM/ })).toBeInTheDocument();
    expect(reads(server)).toHaveLength(2);
  });

  it('answers a player with no airline as an ordinary empty state', async () => {
    serve({ read: 'no-airline', calls: [] });
    renderPanel();
    expect(await screen.findByText(/Found an airline first/)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('says where an academy goes when there is no crew base to build at', async () => {
    serve({ read: academies({ academies: [], sites: [] }), calls: [] });
    renderPanel();
    expect(await screen.findByText(/No crew base to build at/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Found an academy/ })).toBeNull();
  });

  it('offers the open bases when the airline has no academy yet', async () => {
    serve({ read: academies({ academies: [] }), calls: [] });
    renderPanel();
    expect(await screen.findByText(/No academy yet/)).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Found an academy at LFPG — $12,346' }),
    ).toBeInTheDocument();
  });
});

describe('what an academy shows, as the server reports it', () => {
  it('shows the level, the ceiling, the slots and the upkeep from the response', async () => {
    serve({ read: academies(), calls: [] });
    renderPanel();
    const eham = await card('EHAM');

    expect(within(eham).getByRole('heading', { level: 3 })).toHaveTextContent(
      'EHAM · Training Centre',
    );
    expect(eham).toHaveTextContent('Level 2 of 5');
    expect(eham).toHaveTextContent('First Officer');
    expect(eham).toHaveTextContent('Senior Cabin Crew');
    expect(eham).toHaveTextContent('Up to tier 1');
    // 11 is not a shipped slot count: the figure is the server's.
    expect(eham).toHaveTextContent('3 of 11 in use');
    expect(eham).toHaveTextContent('$3,913 a game month');
  });

  it('lists installed and building modules with their world dates', async () => {
    serve({ read: academies(), calls: [] });
    renderPanel();
    const eham = await card('EHAM');
    const modules = within(eham).getByRole('heading', { name: 'Modules' }).parentElement;
    if (modules === null) throw new Error('no modules section');

    expect(modules).toHaveTextContent(/CBT Suite\s*Installed 2031-01-20/);
    expect(modules).toHaveTextContent(/Cabin Service Mock-up\s*Being built/);
    expect(modules).toHaveTextContent('Ready 2031-03-11, 10 game days from now.');
  });

  it('quotes the next level before anything is paid, in the server’s figures', async () => {
    serve({ read: academies(), calls: [] });
    renderPanel();
    const eham = await card('EHAM');
    const next = within(eham).getByRole('heading', { name: 'Next level' }).parentElement;
    if (next === null) throw new Error('no next-level section');

    expect(next).toHaveTextContent('Level 3, Flight Academy');
    expect(next).toHaveTextContent('$135,791');
    expect(next).toHaveTextContent('17 game weeks');
    expect(next).toHaveTextContent('$8,123 a game month');
    expect(
      within(next).getByRole('button', { name: 'Build level 3 — $135,791' }),
    ).toBeInTheDocument();
  });

  it('places each module offer beside what blocks it, and says which do nothing yet', async () => {
    serve({ read: academies(), calls: [] });
    renderPanel();
    const eham = await card('EHAM');
    const offers = within(eham).getByRole('heading', { name: 'Build a module' }).parentElement;
    if (offers === null) throw new Error('no offers section');
    const row = (name: string): HTMLElement => {
      const item = within(offers).getByText(name).closest('li');
      if (item === null) throw new Error(`no row for ${name}`);
      return item;
    };

    expect(row('CBT Suite')).toHaveTextContent('Built');
    expect(row('Cabin Service Mock-up')).toHaveTextContent('Being built');
    expect(row('Fixed-Base Sim')).toHaveTextContent('From level 3 (Flight Academy)');
    expect(within(row('Fixed-Base Sim')).queryByRole('button')).toBeNull();

    // Priced, buildable — and honest that nothing reads it today.
    const drill = row('Emergency & Wet Drill');
    expect(drill).toHaveTextContent('Not used yet');
    expect(drill).toHaveTextContent('nothing in the game reads it yet');
    expect(drill).toHaveTextContent('$32,109');
    expect(drill).toHaveTextContent('+$1,817 a game month');
    expect(within(drill).getByRole('button', { name: 'Build — $32,109' })).toBeEnabled();
  });

  it('says a building site permits nothing and charges no upkeep yet', async () => {
    serve({ read: academies(), calls: [] });
    renderPanel();
    const egll = await card('EGLL');

    expect(within(egll).getByRole('heading', { level: 3 })).toHaveTextContent(
      'EGLL · Building site',
    );
    expect(egll).toHaveTextContent('No level yet');
    expect(egll).toHaveTextContent(/permits nothing/);
    expect(egll).toHaveTextContent('Under construction');
    expect(egll).toHaveTextContent(
      'Level 1 (Training Room). Ready 2031-03-29, 28 game days from now.',
    );
    // Never level 1's ceiling while level 1 is still going up.
    expect(egll).not.toHaveTextContent('Training slots');
    expect(egll).toHaveTextContent(/next can start once level 1 is commissioned/);
  });

  it('shows the date and no countdown before the world clock has synced', async () => {
    serve({ read: academies(), calls: [] });
    renderPanel(null);
    const egll = await card('EGLL');
    expect(egll).toHaveTextContent('Ready 2031-03-29, world time.');
    expect(egll).not.toHaveTextContent(/game days from now/);
  });

  it('calls a build the worker has not finished stalled rather than slow', async () => {
    serve({
      read: academies({
        academies: [buildingSite({ constructionReadyAt: '2031-03-01T10:00:00.000Z' })],
      }),
      calls: [],
    });
    renderPanel();
    const egll = await card('EGLL');
    expect(egll).toHaveTextContent('Not finishing');
    expect(egll).toHaveTextContent(/completed by the world’s worker, and none has run since/);
  });

  it('says what an academy is for in §10.4’s terms: cheaper, never more popular', async () => {
    serve({ read: academies(), calls: [] });
    renderPanel();
    const section = (await screen.findByRole('heading', { name: 'Training academies' })).closest(
      'section',
    );
    if (section === null) throw new Error('no section');
    await card('EHAM');

    // The outsourced rate is the server's; the in-house one is not on the wire.
    expect(section).toHaveTextContent('bought in at $2,199 a head');
    expect(section).toHaveTextContent('costs a fraction of that');
    expect(section).toHaveTextContent('cheaper to run, not more popular');
    // No sentence on the section is about demand, fares, reputation or market share.
    expect(section.textContent).not.toMatch(
      /demand|reputation|price tolerance|\bfares?\b|load factor|market share/i,
    );
  });
});

describe('founding, levelling and equipping: two steps, sent once', () => {
  const founded = academies({
    academies: [
      trainingCentre(),
      buildingSite(),
      buildingSite({
        id: '33333333-3333-4333-8333-333333333333',
        crewBaseId: LFPG_BASE,
        airportIcao: 'LFPG',
        constructionReadyAt: '2031-04-05T12:00:00.000Z',
      }),
    ],
    sites: [],
  });

  it('founds an academy only after the confirmation, and renders the whole answer', async () => {
    const server: Server = { read: academies(), write: { status: 200, body: founded }, calls: [] };
    serve(server);
    renderPanel();

    fireEvent.click(
      await screen.findByRole('button', { name: 'Found an academy at LFPG — $12,346' }),
    );
    // The first click quotes; nothing is sent.
    expect(posts(server)).toHaveLength(0);
    const confirm = screen.getByRole('group', { name: 'Confirm the build' });
    expect(confirm).toHaveTextContent('$12,346 now');
    expect(confirm).toHaveTextContent('5 game weeks');
    expect(confirm).toHaveTextContent('$1,515 a game month');
    expect(confirm).toHaveTextContent(/cannot be sold or demolished/);

    fireEvent.click(within(confirm).getByRole('button', { name: 'Confirm — pay $12,346' }));
    await waitFor(() => {
      expect(posts(server)).toHaveLength(1);
    });
    expect(posts(server)[0]).toMatchObject({
      url: '/api/academies',
      body: { crewBaseId: LFPG_BASE },
    });

    // The server's state replaces the page's: the site is now a building site.
    expect(
      await screen.findByRole('heading', { name: 'LFPG · Building site' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Found an academy at LFPG/ })).toBeNull();
    expect(screen.getByRole('status')).toHaveTextContent(
      'Academy founded at LFPG: level 1 is under construction, ready 2031-04-05, world time.',
    );
    // One read, one write: the answer was the state, so nothing was refetched.
    expect(reads(server)).toHaveLength(1);
  });

  it('withdraws a confirmation without sending anything', async () => {
    const server: Server = { read: academies(), calls: [] };
    serve(server);
    renderPanel();

    fireEvent.click(await screen.findByRole('button', { name: 'Build level 3 — $135,791' }));
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }));
    expect(screen.queryByRole('group', { name: 'Confirm the build' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Build level 3 — $135,791' })).toBeInTheDocument();
    expect(posts(server)).toHaveLength(0);
  });

  it('starts the next level with a bodyless request the server prices', async () => {
    const upgraded = academies({
      academies: [
        trainingCentre({
          pendingLevel: 3,
          constructionReadyAt: '2031-06-28T12:00:00.000Z',
          nextLevel: null,
        }),
        buildingSite(),
      ],
    });
    const server: Server = { read: academies(), write: { status: 200, body: upgraded }, calls: [] };
    serve(server);
    renderPanel();

    fireEvent.click(await screen.findByRole('button', { name: 'Build level 3 — $135,791' }));
    const confirm = screen.getByRole('group', { name: 'Confirm the build' });
    expect(confirm).toHaveTextContent(/in place of this level’s/);
    fireEvent.click(within(confirm).getByRole('button', { name: 'Confirm — pay $135,791' }));

    await waitFor(() => {
      expect(posts(server)).toHaveLength(1);
    });
    expect(posts(server)[0]).toEqual({
      url: `/api/academies/${EHAM_ID}/levels`,
      method: 'POST',
      body: undefined,
    });
    const eham = await card('EHAM');
    expect(await within(eham).findByText(/Level 3 \(Flight Academy\)\./)).toBeInTheDocument();
    expect(eham).toHaveTextContent(/next can start once level 3 is commissioned/);
    expect(within(eham).queryByRole('button', { name: /Build level/ })).toBeNull();
  });

  it('builds a module, naming only its kind', async () => {
    const server: Server = {
      read: academies(),
      write: { status: 200, body: academies() },
      calls: [],
    };
    serve(server);
    renderPanel();

    fireEvent.click(await screen.findByRole('button', { name: 'Build — $32,109' }));
    const confirm = screen.getByRole('group', { name: 'Confirm the build' });
    expect(confirm).toHaveTextContent(/teaches nothing today/);
    fireEvent.click(within(confirm).getByRole('button', { name: 'Confirm — pay $32,109' }));

    await waitFor(() => {
      expect(posts(server)).toHaveLength(1);
    });
    expect(posts(server)[0]).toMatchObject({
      url: `/api/academies/${EHAM_ID}/modules`,
      body: { kind: 'emergency_drill' },
    });
    expect(posts(server)[0]?.body).not.toHaveProperty('family');
  });

  it('builds a full-flight sim for the family picked from the server’s list', async () => {
    const level4 = academies({
      academies: [
        trainingCentre({
          level: 4,
          levelName: 'Full-Flight Sim Centre',
          moduleOffers: [
            offer({
              kind: 'full_flight_sim',
              name: 'Full-Flight Sim',
              perFamily: true,
              fromLevel: 4,
              quote: quote(30_000_000, 20, 1_200_000),
              availableFamilies: ['737 MAX', 'A320neo'],
            }),
          ],
        }),
      ],
    });
    const server: Server = { read: level4, write: { status: 200, body: level4 }, calls: [] };
    serve(server);
    renderPanel();

    const family = await screen.findByRole('combobox', { name: 'Family' });
    expect(
      within(family)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['737 MAX', 'A320neo']);

    // Arm, then change the family: the confirmation named the other one, so it goes.
    fireEvent.click(screen.getByRole('button', { name: 'Build — $300,000' }));
    expect(screen.getByRole('group', { name: 'Confirm the build' })).toHaveTextContent(
      'for the 737 MAX',
    );
    fireEvent.change(family, { target: { value: 'A320neo' } });
    expect(screen.queryByRole('group', { name: 'Confirm the build' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Build — $300,000' }));
    const confirm = screen.getByRole('group', { name: 'Confirm the build' });
    expect(confirm).toHaveTextContent('for the A320neo');
    fireEvent.click(within(confirm).getByRole('button', { name: 'Confirm — pay $300,000' }));

    await waitFor(() => {
      expect(posts(server)).toHaveLength(1);
    });
    expect(posts(server)[0]?.body).toEqual({ kind: 'full_flight_sim', family: 'A320neo' });
  });

  it('holds every other control while a write is in flight', async () => {
    const server: Server = { read: academies(), write: 'pending', calls: [] };
    serve(server);
    renderPanel();

    fireEvent.click(await screen.findByRole('button', { name: 'Build level 3 — $135,791' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm — pay $135,791' }));

    expect(await screen.findByRole('button', { name: 'Paying…' })).toBeDisabled();
    expect(
      screen.getByRole('button', { name: 'Found an academy at LFPG — $12,346' }),
    ).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Build — $32,109' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Paying…' }));
    expect(posts(server)).toHaveLength(1);
  });
});

describe('a refusal, and an answer that never came', () => {
  it('shows a refusal with the server’s code beside the control, and changes nothing', async () => {
    const server: Server = {
      read: academies(),
      write: {
        status: 409,
        body: { code: 'insufficient_funds', message: 'The airline cannot afford this' },
      },
      calls: [],
    };
    serve(server);
    renderPanel();

    fireEvent.click(await screen.findByRole('button', { name: 'Build level 3 — $135,791' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm — pay $135,791' }));

    const refusal = await screen.findByRole('alert');
    expect(refusal).toHaveTextContent('The airline cannot afford this.');
    expect(refusal).toHaveTextContent('(insufficient_funds)');
    expect(refusal).toHaveTextContent('Nothing was charged and nothing changed.');
    expect(refusal.closest('section')).toHaveTextContent('Next level');

    // The academies on screen are exactly as they were, and it was sent once.
    const eham = await card('EHAM');
    expect(eham).toHaveTextContent('Level 2 of 5');
    expect(eham).toHaveTextContent('$3,913 a game month');
    expect(posts(server)).toHaveLength(1);
    expect(reads(server)).toHaveLength(1);
  });

  it('reports a dropped connection as unknown, never retries, and reloads on request', async () => {
    const server: Server = { read: academies(), write: 'reject', calls: [] };
    serve(server);
    renderPanel();

    fireEvent.click(
      await screen.findByRole('button', { name: 'Found an academy at LFPG — $12,346' }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Confirm — pay $12,346' }));

    const unknown = await screen.findByRole('alert');
    expect(unknown).toHaveTextContent(/whether it went through is unknown/);
    expect(unknown).toHaveTextContent(/never sent twice/);
    expect(posts(server)).toHaveLength(1);
    // The same write waits for the server's state before it can be asked again.
    expect(
      screen.getByRole('button', { name: 'Found an academy at LFPG — $12,346' }),
    ).toBeDisabled();

    fireEvent.click(within(unknown).getByRole('button', { name: 'Reload academies' }));
    await waitFor(() => {
      expect(reads(server)).toHaveLength(2);
    });
    expect(
      await screen.findByRole('button', { name: 'Found an academy at LFPG — $12,346' }),
    ).toBeEnabled();
    expect(posts(server)).toHaveLength(1);
  });

  it('treats a server error as unknown rather than as a refusal', async () => {
    const server: Server = {
      read: academies(),
      write: { status: 500, body: { code: 'internal_error', message: 'Something went wrong' } },
      calls: [],
    };
    serve(server);
    renderPanel();

    fireEvent.click(await screen.findByRole('button', { name: 'Build level 3 — $135,791' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm — pay $135,791' }));

    const unknown = await screen.findByRole('alert');
    expect(unknown).toHaveTextContent(/unknown/);
    expect(unknown).not.toHaveTextContent('Nothing was charged');
  });
});

describe('money through the display currency (M8-02)', () => {
  it('shows every quote in the player’s chosen currency', async () => {
    setDisplayCurrency('EUR', [
      {
        code: 'EUR',
        name: 'Euro',
        symbol: '€',
        decimals: 2,
        rateE6: 500_000,
        refreshedAt: '2031-01-01T00:00:00.000Z',
        top: true,
      },
    ]);
    serve({ read: academies(), calls: [] });
    renderPanel();

    const section = (await screen.findByRole('heading', { name: 'Training academies' })).closest(
      'section',
    );
    if (section === null) throw new Error('no section');
    await card('EHAM');
    // $135,791 at 0.5 is €67,896; $12,346 is €6,173.
    expect(screen.getByRole('button', { name: 'Build level 3 — €67,896' })).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Found an academy at LFPG — €6,173' }),
    ).toBeInTheDocument();
    expect(section.textContent).not.toMatch(/\$/);
  });
});

describe('the clock', () => {
  it('counts down on the world’s clock as it moves', async () => {
    serve({ read: academies({ academies: [buildingSite()], sites: [] }), calls: [] });
    const { rerender } = render(<AcademyPanel inGameTime={GAME_NOW} />);
    const egll = await card('EGLL');
    expect(egll).toHaveTextContent('28 game days from now');

    act(() => {
      rerender(<AcademyPanel inGameTime={new Date('2031-03-22T12:00:00.000Z')} />);
    });
    expect(egll).toHaveTextContent('7 game days from now');
  });
});
