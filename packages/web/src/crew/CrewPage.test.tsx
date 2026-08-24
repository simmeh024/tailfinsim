import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { CrewResponse } from '@tailfin/shared';

import { CrewPage } from './CrewPage';

/**
 * The Crew page (M5-01, §9.2).
 *
 * Two acceptance criteria are visible here rather than in the server, and this
 * is where they are held:
 *
 *   - *"the player interacts with pool sizes and policies, never with individual
 *     rosters"* — so the page must not grow a person, ever;
 *   - *"a mixed fleet visibly fragments the crew pool and reduces availability"*
 *     — and **visibly** is the word, because §9.2's complaint is that
 *     fragmentation is quiet.
 */

const costs: CrewResponse['costs'] = {
  baseOpeningMinor: 3_000_000,
  hireFlightDeckMinor: 400_000,
  hireCabinMinor: 100_000,
  conversionPerHeadMinor: 200_000,
  conversionDurationDays: 14,
  weeklyHiringCapacity: 12,
  monthlyPayrollMinor: 4_200_000,
  hotelPerHeadPerNightMinor: 15_000,
};

function state(overrides: Partial<CrewResponse> = {}): CrewResponse {
  return {
    bases: [],
    fragmentation: {
      families: [],
      totalAvailable: 0,
      largestFamilyAvailable: 0,
      strandedHeads: 0,
    },
    demand: { rows: [], totalRequired: 0, metRequired: 0, covered: true, uncoveredFamilies: [] },
    families: ['A320neo', '737 MAX', 'ATR 72'],
    costs,
    ...overrides,
  };
}

function respondWith(value: CrewResponse | null): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(() =>
      Promise.resolve({
        ok: value !== null,
        status: value === null ? 409 : 200,
        json: () => Promise.resolve(value ?? { code: 'active_world_required', message: 'no' }),
      } as Response),
    ),
  );
}

const mixedFleet = state({
  bases: [
    {
      id: '00000000-0000-4000-8000-000000000001',
      airportIcao: 'EHAM',
      status: 'open',
      openedAt: '2024-10-20T00:00:00.000Z',
      pools: [
        {
          id: '00000000-0000-4000-8000-000000000010',
          family: 'A320neo',
          rank: 'captain',
          headcount: 6,
          unavailable: 2,
          onDuty: 0,
          reserve: 0,
          available: 4,
        },
        {
          id: '00000000-0000-4000-8000-000000000011',
          family: '737 MAX',
          rank: 'captain',
          headcount: 3,
          unavailable: 0,
          onDuty: 0,
          reserve: 0,
          available: 3,
        },
      ],
      conversions: [
        {
          id: '00000000-0000-4000-8000-000000000020',
          fromFamily: 'A320neo',
          toFamily: '737 MAX',
          rank: 'captain',
          heads: 2,
          startedAt: '2024-10-20T00:00:00.000Z',
          completesAt: '2024-11-03T00:00:00.000Z',
        },
      ],
      duty: [
        {
          id: '00000000-0000-4000-8000-000000000030',
          family: 'A320neo',
          heads: 4,
          status: 'open',
          fromReserve: false,
          reportAt: '2024-10-21T06:00:00.000Z',
          offDutyAt: null,
          restUntil: null,
          sectors: 2,
          locationIcao: 'EGLL',
          awayFromBase: true,
        },
        {
          id: '00000000-0000-4000-8000-000000000031',
          family: '737 MAX',
          heads: 4,
          status: 'resting',
          fromReserve: true,
          reportAt: '2024-10-20T06:00:00.000Z',
          offDutyAt: '2024-10-20T18:30:00.000Z',
          restUntil: '2024-10-21T06:30:00.000Z',
          sectors: 4,
          locationIcao: 'EHAM',
          awayFromBase: false,
        },
      ],
    },
  ],
  fragmentation: {
    families: ['737 MAX', 'A320neo'],
    totalAvailable: 7,
    largestFamilyAvailable: 4,
    strandedHeads: 3,
  },
  demand: {
    rows: [
      { family: 'A320neo', rank: 'captain', required: 3, available: 4, delta: 1 },
      { family: '737 MAX', rank: 'captain', required: 5, available: 3, delta: -2 },
    ],
    totalRequired: 8,
    metRequired: 6,
    covered: false,
    uncoveredFamilies: [],
  },
  families: ['A320neo', '737 MAX', 'ATR 72'],
});

describe('the crew page', () => {
  /* ------------------------------------------------------------------ *
   * M5-02: duty, rest and standby
   * ------------------------------------------------------------------ */

  it('says where the crew are, which the game could not answer before', async () => {
    respondWith(mixedFleet);
    render(<CrewPage />);

    const table = await screen.findByRole('table', { name: 'Crew sets on duty or resting' });
    // One set flying, one resting. Both are counts on an aeroplane, not people.
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain('EGLL');
    expect(rows[1]?.textContent).toContain('Resting until');
  });

  it('marks a set that stopped away from base, in words', async () => {
    respondWith(mixedFleet);
    render(<CrewPage />);

    const table = await screen.findByRole('table', { name: 'Crew sets on duty or resting' });
    // §9.2's hotel bill, findable. Colour is never the only signal (App. H.7),
    // so it is the word "hotel" rather than a red cell — and a rotation that
    // ends away looks almost identical on a map to one that gets home.
    expect(within(table).getByText(/hotel/)).toBeInTheDocument();
    expect(within(table).getByText(/standby/)).toBeInTheDocument();
  });

  it('tells duty apart from training in the pool table', async () => {
    /*
     * The two have different fixes, which is the whole reason they are separate
     * columns: a classroom is a fortnight and you wait, a duty is a night and
     * you hire or you keep a reserve. One column would make them look like one
     * problem.
     */
    respondWith(
      state({
        bases: [
          {
            id: '00000000-0000-4000-8000-000000000001',
            airportIcao: 'EHAM',
            status: 'open',
            openedAt: '2024-10-20T00:00:00.000Z',
            pools: [
              {
                id: '00000000-0000-4000-8000-000000000010',
                family: 'A320neo',
                rank: 'captain',
                headcount: 9,
                unavailable: 2,
                onDuty: 3,
                reserve: 1,
                available: 4,
              },
            ],
            conversions: [],
            duty: [],
          },
        ],
      }),
    );
    render(<CrewPage />);

    const table = await screen.findByRole('table', { name: 'Crew at EHAM' });
    const cells = within(table).getAllByRole('row')[1]?.querySelectorAll('td');
    // family, rank, on strength, in training, on duty, standby, available
    expect([...(cells ?? [])].map((cell) => cell.textContent)).toEqual([
      'A320neo',
      'Captain',
      '9',
      '2',
      '3',
      '1',
      '4',
    ]);
  });

  it('offers a standby level rather than a standby purchase', async () => {
    respondWith(mixedFleet);
    render(<CrewPage />);

    // A reserve is a designation and not a hire: the heads are already paid for.
    // So the control sets a number, and there is no price beside it.
    const button = await screen.findByRole('button', { name: 'Set standby' });
    expect(button).toBeInTheDocument();
    const card = button.closest('section');
    expect(card?.textContent).toContain('paid exactly like everyone else');
  });

  it('sends the standby level as a level, not a change', async () => {
    // Typed arguments, so the assertions below can read the call back. A bare
    // `vi.fn(() => ...)` gives an empty parameter tuple and indexing it is a
    // type error rather than a runtime one.
    const fetchMock = vi.fn((_path: string, _init?: RequestInit) =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(mixedFleet),
      } as Response),
    );
    vi.stubGlobal('fetch', fetchMock);
    render(<CrewPage />);

    const input = await screen.findByLabelText('Standby heads');
    fireEvent.change(input, { target: { value: '3' } });
    fireEvent.click(screen.getByRole('button', { name: 'Set standby' }));

    const call = fetchMock.mock.calls.find(
      ([path]) => typeof path === 'string' && path === '/api/crew/reserves',
    );
    expect(call).toBeDefined();
    const init = call?.[1];
    /*
     * PUT and an absolute number. A delta would race: two tabs both sending
     * "+2" produce four reserves and neither screen can explain it.
     */
    expect(init?.method).toBe('PUT');
    const body: unknown = JSON.parse(typeof init?.body === 'string' ? init.body : '{}');
    expect(body).toMatchObject({ reserve: 3 });
  });

  it('does not name a person in the duty board either', async () => {
    respondWith(mixedFleet);
    render(<CrewPage />);

    // M5-01's invariant, extended. A duty period is a span of time with a head
    // count on it; the regulation constrains a duty, not a person, and the page
    // must never grow one.
    const table = await screen.findByRole('table', { name: 'Crew sets on duty or resting' });
    const headers = [...table.querySelectorAll('th')].map((th) => th.textContent);
    expect(headers).toEqual(['Base', 'Family', 'Heads', 'Sectors', 'Where', 'State']);
    expect(table.textContent).not.toContain('00000000-0000-4000-8000-000000000030');
  });

  it('leads with what a mixed fleet is costing', async () => {
    respondWith(mixedFleet);
    render(<CrewPage />);

    // The numbers, not a mood: "3 cannot fly it" is the acceptance criterion
    // made visible, where a coloured badge would not be. Asserted on the
    // sentence rather than the bare digits, because "4" is also an availability
    // cell and matching that would pass for the wrong reason.
    // and asserting on a bare number would pass for the wrong reason.
    const headline = await screen.findByText(/cannot fly it/);
    expect(headline.textContent).toContain('7');
    expect(headline.textContent).toContain('4');
    expect(headline.textContent).toContain('3');
  });

  it('says fragmentation is not a penalty, because it is not one', async () => {
    respondWith(mixedFleet);
    render(<CrewPage />);

    // A figure that reads as a fine invites "how do I avoid the fine?", and the
    // answer is not a payment — it is flying one family.
    expect(await screen.findByText(/Not a penalty/)).toBeInTheDocument();
  });

  it('shows crew in training as still on strength', async () => {
    respondWith(mixedFleet);
    render(<CrewPage />);

    // Scoped to the base's own table: the page now leads with fleet cover, so
    // "the first table" is no longer the pools.
    const table = await screen.findByRole('table', { name: 'Crew at EHAM' });
    const rows = within(table).getAllByRole('row');
    const a320 = rows.find((row) => row.textContent?.includes('A320neo'));
    // 6 on strength, 2 in a classroom, 4 available. Netting them off would hide
    // the entire point of a conversion taking a fortnight.
    expect(a320?.textContent).toContain('6');
    expect(a320?.textContent).toContain('2');
    expect(a320?.textContent).toContain('4');
  });

  it('never names a person', async () => {
    respondWith(mixedFleet);
    render(<CrewPage />);
    await screen.findByText(/cannot fly it/);

    /*
     * The guard on the acceptance criterion. Every column is a count, a rank or
     * a family — the moment one is an identity, the page has started down the
     * road the issue exists to prevent.
     *
     * Asserted on the columns rather than by grepping the page for words like
     * "roster": the first version did that and failed on this page's own copy,
     * which says a conversion costs fourteen days *off the roster*. Prose about
     * rostering is fine; a column of people is not.
     */
    const table = screen.getByRole('table', { name: 'Crew at EHAM' });
    const headers = [...table.querySelectorAll('th')].map((th) => th.textContent);
    expect(headers).toEqual([
      'Family',
      'Rank',
      'On strength',
      'In training',
      'On duty',
      'Standby',
      'Available',
    ]);

    // And nothing renders an identifier. A pool id reaching the page would be
    // the first crack in "counts, never people".
    expect(document.body.textContent).not.toMatch(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
    );
  });

  it('keeps its heading when the body is not a crew payload', async () => {
    /*
     * The regression CI found. The shell's routing test stubs every unrecognised
     * URL with `{}`, so a page that trusts the shape crashes on the first nested
     * property and takes its own heading down with it — which passed locally only
     * because the promise had not resolved before the assertion.
     */
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) } as Response),
      ),
    );
    render(<CrewPage />);

    expect(await screen.findByText(/Could not load your crew/)).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'Crew' })).toBeInTheDocument();
  });

  it('keeps what it is showing when a mutation is refused', async () => {
    /*
     * Found on dev rather than here. Opening a base and then asking for the same
     * one again reverted the whole page to "no crew yet" while the base sat
     * happily in the database — the refusal path wrote back the state captured in
     * the render closure, which is stale the moment anything has succeeded.
     */
    let call = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(() => {
        call += 1;
        // First the GET, then a refused POST.
        return Promise.resolve(
          call === 1
            ? ({ ok: true, status: 200, json: () => Promise.resolve(mixedFleet) } as Response)
            : ({
                ok: false,
                status: 409,
                json: () => Promise.resolve({ code: 'base_exists', message: 'Already there' }),
              } as Response),
        );
      }),
    );
    render(<CrewPage />);
    await screen.findByText(/cannot fly it/);

    // The field is `required`, so an empty submit never leaves the form.
    fireEvent.change(screen.getByLabelText('Airport'), { target: { value: 'EHAM' } });
    fireEvent.click(screen.getByRole('button', { name: 'Open base' }));

    expect(await screen.findByText('Already there')).toBeInTheDocument();
    // Still showing the crew it had. The refusal is news, not an erasure.
    expect(screen.getByText(/cannot fly it/)).toBeInTheDocument();
    // The heading specifically: 'EHAM' is now also an option in the base picker.
    expect(screen.getByRole('heading', { name: /EHAM/ })).toBeInTheDocument();
  });

  it('swaps the banner when the rank picker changes', async () => {
    /*
     * The banner illustrates the rank being hired. It is the one place the page
     * shows a person and that is allowed — an illustration of a rank is not a
     * member of staff who exists.
     */
    respondWith(mixedFleet);
    render(<CrewPage />);
    await screen.findByRole('img', { name: /^Captain\./ });

    fireEvent.change(screen.getByLabelText('Rank'), { target: { value: 'purser' } });

    expect(await screen.findByRole('img', { name: /^Purser\./ })).toBeInTheDocument();
    expect(screen.queryByRole('img', { name: /^Captain\./ })).not.toBeInTheDocument();
  });

  it('offers families as a picker, never as free text', async () => {
    /*
     * The free-text version put a pool rated on a family called `test` into the
     * dev database. A rating that matches no aeroplane can never be used and no
     * amount of money can undo it.
     */
    respondWith(mixedFleet);
    render(<CrewPage />);
    const family = await screen.findByLabelText('Family');

    expect(family.tagName).toBe('SELECT');
    const options = [...family.querySelectorAll('option')].map((option) => option.value);
    expect(options).toContain('A320neo');
    expect(options).toContain('ATR 72');
    expect(options).not.toContain('test');
  });

  it('never reads fully covered while a rank is short', async () => {
    /*
     * Seen in a sandbox: 24 available against 23 required rendered "100%
     * covered" directly above "not enough crew to launch your whole fleet",
     * because a surplus of A320neo cabin crew was filling in for a shortage of
     * 737 MAX captains. Crew are not fungible, so cover is summed per rank.
     */
    respondWith(mixedFleet);
    render(<CrewPage />);

    // metRequired 6 of 8 -> 75%, and never 100% while `covered` is false.
    expect(await screen.findByText('75%')).toBeInTheDocument();
    expect(screen.queryByText('100%')).not.toBeInTheDocument();
    expect(screen.getByText(/Not enough crew/)).toBeInTheDocument();
  });

  it('tells a player with no airline what to do first', async () => {
    respondWith(null);
    render(<CrewPage />);
    expect(await screen.findByText(/Found an airline first/)).toBeInTheDocument();
  });

  it('says an airline with no crew cannot schedule', async () => {
    respondWith(state());
    render(<CrewPage />);
    // The consequence of the legality rule, said where a player will meet it
    // rather than only in a refusal after they try.
    expect(await screen.findByText(/cannot put one on the books/)).toBeInTheDocument();
  });
});
