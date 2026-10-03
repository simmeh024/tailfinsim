import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';

import {
  ACADEMY_LEVELS,
  RESEARCH_BRANCH_DEFINITIONS,
  ResearchResponse,
  academyLevelForResearchTier,
  researchNodesInBranch,
  type ResearchNodeId,
  type ResearchNodeView,
} from '@tailfin/shared';

import { ResearchPage, ResearchView } from './ResearchPage';

/**
 * The research tree (M9-05, §10.3, §10.5).
 *
 * The claims worth a test each:
 *
 *   - **every tier says what opens it, in words.** §10.5's locked tiers come
 *     *"with the facility level required stated plainly"* — so the assertions
 *     read text, never a class or a colour;
 *   - **a locked node says why**, one sentence per refusal code;
 *   - **an airline with no academy is told why nothing accrues**, rather than
 *     being shown a bare zero (§10.3, *"size alone doesn't buy competence"*);
 *   - **the start is two clicks and posts exactly `{ nodeId }`**, and the
 *     response replaces the page's state;
 *   - **a 409 is shown in words**, whichever field the server names the code in.
 *
 * Every fixture goes through `ResearchResponse.parse`, so a fixture that drifts
 * from the wire contract fails here loudly rather than testing a shape the
 * server can never send.
 */

/**
 * The world's clock when the fixture was read. Every other instant is derived
 * from it, so nothing here is a date that can expire.
 */
const GAME_NOW_MS = Date.UTC(2025, 2, 1);
const DAY_MS = 86_400_000;
const gameInstant = (days: number): string => new Date(GAME_NOW_MS + days * DAY_MS).toISOString();

interface NodeOverride {
  status: ResearchNodeView['status'];
  startRefusal?: ResearchNodeView['startRefusal'];
  startedAt?: string | null;
  completesAt?: string | null;
}

interface FixtureOptions {
  /** The highest commissioned academy level. 0 for none. */
  academyLevel?: number;
  balance?: number;
  recentPerDay?: number;
  fleetFlightHoursPerDay?: number;
  academyLevelSum?: number;
  nodes?: Partial<Record<ResearchNodeId, NodeOverride>>;
  active?: { nodeId: ResearchNodeId; startedAt: string; completesAt: string } | null;
}

/**
 * A research state shaped like the server's, defaulting to an airline with a
 * level 1 academy and nothing researched: tier 1 open, tier 2 refused for the
 * academy, tiers 3 and 4 refused as unreleased.
 */
function fixture(options: FixtureOptions = {}): ResearchResponse {
  const academyLevel = options.academyLevel ?? 1;
  const researchTier = ACADEMY_LEVELS.find((row) => row.level === academyLevel)?.researchTier;

  const branches = RESEARCH_BRANCH_DEFINITIONS.map((definition) => ({
    branch: definition.branch,
    name: definition.name,
    summary: definition.summary,
    nodes: researchNodesInBranch(definition.branch).map((node) => {
      const required = academyLevelForResearchTier(node.tier);
      const startRefusal = !node.released
        ? ('not_released' as const)
        : required.level > academyLevel
          ? ('academy_level' as const)
          : node.tier > 1
            ? ('prerequisite' as const)
            : null;
      const override = options.nodes?.[node.id];
      return {
        id: node.id,
        branch: node.branch,
        tier: node.tier,
        name: node.name,
        description: node.description,
        effects: node.released
          ? node.targets.map((target) => ({
              target,
              fraction: target === 'crewXp' ? 0.05 : target === 'turnaroundTime' ? 0.04 : 0.015,
            }))
          : [],
        cost: {
          researchPoints: 40 * node.tier * node.tier,
          cashMinor: 2_500_000 * node.tier,
          buildWeeks: 2 * node.tier,
        },
        released: node.released,
        status: override?.status ?? (startRefusal === null ? 'available' : 'locked'),
        requiredAcademyLevel: required.level,
        requiredAcademyName: required.name,
        startRefusal: override === undefined ? startRefusal : (override.startRefusal ?? null),
        startedAt: override?.startedAt ?? null,
        completesAt: override?.completesAt ?? null,
      };
    }),
  }));

  return ResearchResponse.parse({
    points: {
      balance: options.balance ?? 120,
      earnedTotal: 180.25,
      recentPerDay: options.recentPerDay ?? 2.4,
    },
    formula: {
      academyLevelSum: options.academyLevelSum ?? academyLevel,
      academyStaffQuality: 1,
      scalingFactorHours: 1000,
      fleetFlightHoursPerDay: options.fleetFlightHoursPerDay ?? 640,
    },
    academy: { highestLevel: academyLevel, researchTier: researchTier ?? null },
    branches,
    active: options.active ?? null,
    gameNow: gameInstant(0),
  });
}

type Reply = { status: number; body: unknown } | 'pending';

/**
 * Stubs `fetch` with a handler per call. Returns the mock so a test can read
 * what was sent.
 */
function stubFetch(handler: (url: string, init: RequestInit | undefined) => Reply) {
  const mock = vi.fn((input: unknown, init?: RequestInit) => {
    const reply = handler(String(input), init);
    if (reply === 'pending') return new Promise<Response>(() => undefined);
    return Promise.resolve({
      ok: reply.status >= 200 && reply.status < 300,
      status: reply.status,
      json: () => Promise.resolve(reply.body),
    } as Response);
  });
  vi.stubGlobal('fetch', mock);
  return mock;
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/research']}>
      <ResearchPage />
    </MemoryRouter>,
  );
}

/** The card for a node, found by its accessible name — the node's own heading. */
function card(name: string): HTMLElement {
  return screen.getByRole('article', { name });
}

describe('the tree', () => {
  it('draws six branches of four tiers each', async () => {
    stubFetch(() => ({ status: 200, body: fixture() }));
    renderPage();

    expect(screen.getByRole('heading', { level: 1, name: 'Research' })).toBeInTheDocument();
    await screen.findByRole('region', { name: 'Doctrine tree' });
    for (const definition of RESEARCH_BRANCH_DEFINITIONS) {
      const branch = screen.getByRole('region', { name: definition.name });
      const nodes = within(branch).getAllByRole('article');
      expect(nodes).toHaveLength(4);
      // Tier 1 first, in §10.3's order.
      expect(nodes.map((node) => within(node).getByText(/^Tier \d$/).textContent)).toEqual([
        'Tier 1',
        'Tier 2',
        'Tier 3',
        'Tier 4',
      ]);
    }
    expect(screen.getAllByRole('heading', { level: 4 })).toHaveLength(24);
  });

  it('states the academy every tier needs, in words, met or not', async () => {
    stubFetch(() => ({ status: 200, body: fixture() }));
    renderPage();
    await screen.findByRole('region', { name: 'Doctrine tree' });

    const legend = screen.getByRole('list', { name: /Research tiers/ });
    for (const sentence of [
      'Requires a Training Room — academy level 1',
      'Requires a Flight Academy — academy level 3',
      'Requires a Full-Flight Sim Centre — academy level 4',
      'Requires a Centre of Excellence — academy level 5',
    ]) {
      expect(within(legend).getByText(sentence)).toBeInTheDocument();
    }

    // A met tier is still labelled with what opened it.
    const open = card('Cost-index SOP');
    expect(
      within(open).getByText('Requires a Training Room — academy level 1'),
    ).toBeInTheDocument();
    expect(within(open).getByText(/Your academy meets this/)).toBeInTheDocument();

    // A locked tier names the facility and how far short the airline is.
    const locked = card('Continuous descent approach');
    expect(within(locked).getByText(/^Locked$/)).toBeInTheDocument();
    expect(
      within(locked).getByText('Requires a Flight Academy — academy level 3'),
    ).toBeInTheDocument();
    expect(
      within(locked).getByText(
        /Needs a Flight Academy \(academy level 3\) to open tier 2\. Your highest academy is level 1\./,
      ),
    ).toBeInTheDocument();
  });

  it('says a tier 3 node arrives later, and still shows what it costs', async () => {
    stubFetch(() => ({ status: 200, body: fixture({ academyLevel: 5 }) }));
    renderPage();
    await screen.findByRole('region', { name: 'Doctrine tree' });

    const later = card('Tankering doctrine');
    expect(within(later).getByText(/Arrives in a later release/)).toBeInTheDocument();
    // §10.3: the player can see exactly what they are working toward.
    expect(within(later).getByText('360.0 RP')).toBeInTheDocument();
    expect(within(later).getByText('$75,000')).toBeInTheDocument();
    expect(within(later).getByText('6 game weeks')).toBeInTheDocument();
    // No balance amount exists for it yet, so the catalogue's target is named without one.
    expect(within(later).getByText(/Improves fuel burn — the amount is set/)).toBeInTheDocument();
    expect(within(later).queryByRole('button')).toBeNull();
  });

  it('names the tier below when the prerequisite is missing', async () => {
    stubFetch(() => ({ status: 200, body: fixture({ academyLevel: 3 }) }));
    renderPage();
    await screen.findByRole('region', { name: 'Doctrine tree' });

    const node = card('Continuous descent approach');
    expect(within(node).getByText(/Research Cost-index SOP first\./)).toBeInTheDocument();
    expect(within(node).queryByRole('button')).toBeNull();
  });

  it('shows each effect as the change a player feels', async () => {
    stubFetch(() => ({ status: 200, body: fixture() }));
    renderPage();
    await screen.findByRole('region', { name: 'Doctrine tree' });

    expect(within(card('Cost-index SOP')).getByText('−1.5% fuel burn')).toBeInTheDocument();
    expect(within(card('Boarding SOP')).getByText('−4% turnaround time')).toBeInTheDocument();
    expect(within(card('Efficient conversion')).getByText('+5% crew XP')).toBeInTheDocument();
  });

  it('marks a researched node as done, and draws its link to the next tier as complete', async () => {
    stubFetch(() => ({
      status: 200,
      body: fixture({
        academyLevel: 3,
        nodes: {
          cost_index_sop: { status: 'complete', completesAt: gameInstant(-3) },
          continuous_descent: { status: 'available' },
        },
      }),
    }));
    const { container } = renderPage();
    await screen.findByRole('region', { name: 'Doctrine tree' });

    const done = card('Cost-index SOP');
    expect(within(done).getByText('Researched')).toBeInTheDocument();
    expect(within(done).queryByRole('button')).toBeNull();
    expect(done).toHaveAttribute('data-status', 'complete');

    const next = card('Continuous descent approach');
    expect(next.closest('li')).toHaveAttribute('data-link', 'complete');
    expect(container.querySelectorAll('[data-link="complete"]')).toHaveLength(1);
  });
});

describe('research points', () => {
  it('shows the balance, the rate and the formula with the airline’s own numbers', async () => {
    stubFetch(() => ({
      status: 200,
      body: fixture({ academyLevel: 3, academyLevelSum: 4, balance: 42.56, recentPerDay: 2.44 }),
    }));
    renderPage();
    const panel = await screen.findByRole('region', { name: 'Research points' });

    // One decimal, rounded down: 42.56 is never shown as 42.6 beside a cost it cannot meet.
    expect(within(panel).getByText('42.5 RP')).toBeInTheDocument();
    expect(within(panel).getByText('2.4 RP')).toBeInTheDocument();
    expect(
      within(panel).getByText(/RP\/day = Σ academy levels × academy staff quality/),
    ).toBeInTheDocument();
    const yours = within(panel)
      .getByText(/^Yours:/)
      .closest('p');
    expect(yours).toHaveTextContent(
      'Yours: Σ academy levels 4 × staff quality 1.00 × (640 h fleet flight hours a day ÷ 1,000 h)',
    );
    expect(within(panel).getByText(/cannot be bought/)).toBeInTheDocument();
    expect(within(panel).queryByText(/Nothing accrues/)).toBeNull();
  });

  it('explains why an airline with no academy earns nothing, and what fixes it', async () => {
    stubFetch(() => ({
      status: 200,
      body: fixture({ academyLevel: 0, academyLevelSum: 0, balance: 0, recentPerDay: 0 }),
    }));
    renderPage();
    const panel = await screen.findByRole('region', { name: 'Research points' });

    expect(within(panel).getByText(/Nothing accrues/)).toBeInTheDocument();
    expect(within(panel).getByText(/Build a training academy/)).toBeInTheDocument();
    expect(within(panel).getByText(/Size alone does not buy competence/)).toBeInTheDocument();
    expect(within(panel).getByText(/No commissioned academy/)).toBeInTheDocument();
    // The hours are there and the academies are not: the formula shows which factor is zero.
    expect(
      within(panel)
        .getByText(/^Yours:/)
        .closest('p'),
    ).toHaveTextContent(
      'Σ academy levels 0 × staff quality 1.00 × (640 h fleet flight hours a day',
    );

    // And with no academy even tier 1 is locked, for the facility.
    expect(
      within(card('Cost-index SOP')).getByText(/Needs a Training Room \(academy level 1\)/),
    ).toBeInTheDocument();
    expect(
      within(card('Cost-index SOP')).getByText(/You have no commissioned academy/),
    ).toBeInTheDocument();
  });
});

describe('starting a project', () => {
  it('asks first, then posts { nodeId } and renders the returned state', async () => {
    const after = fixture({
      balance: 80,
      nodes: {
        cost_index_sop: {
          status: 'in_progress',
          startedAt: gameInstant(0),
          completesAt: gameInstant(14),
        },
        boarding_sop: { status: 'available', startRefusal: 'project_running' },
      },
      active: { nodeId: 'cost_index_sop', startedAt: gameInstant(0), completesAt: gameInstant(14) },
    });
    const fetchMock = stubFetch((url, init) =>
      url === '/api/research/projects' && init?.method === 'POST'
        ? { status: 200, body: after }
        : { status: 200, body: fixture() },
    );
    renderPage();
    await screen.findByRole('region', { name: 'Doctrine tree' });

    // Step one: nothing is sent, and the cost is stated.
    fireEvent.click(within(card('Cost-index SOP')).getByRole('button', { name: 'Start research' }));
    const confirm = within(card('Cost-index SOP')).getByRole('group', {
      name: 'Confirm starting Cost-index SOP',
    });
    expect(confirm).toHaveTextContent(
      'Spends 40.0 RP and $25,000 now, and takes 2 game weeks. Nothing can rush it',
    );
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
    // Focus follows the control the player is now deciding on.
    const confirmButton = within(confirm).getByRole('button', {
      name: 'Confirm — start Cost-index SOP',
    });
    expect(confirmButton).toHaveFocus();

    // Step two: the post, and the response replaces the page.
    fireEvent.click(confirmButton);
    const active = screen.getByRole('region', { name: 'Active project' });
    expect(await within(active).findByText('Cost-index SOP')).toBeInTheDocument();
    expect(within(active).getByText('2 game weeks remaining')).toBeInTheDocument();

    const post = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST');
    expect(post?.[0]).toBe('/api/research/projects');
    const sent = post?.[1]?.body;
    expect(typeof sent).toBe('string');
    expect(JSON.parse(sent as string)).toEqual({ nodeId: 'cost_index_sop' });

    expect(within(card('Cost-index SOP')).getByText('Researching')).toBeInTheDocument();
    expect(
      within(card('Boarding SOP')).getByText(/Cost-index SOP is being researched/),
    ).toBeInTheDocument();
    expect(
      within(card('Boarding SOP')).getByRole('button', { name: 'Start research' }),
    ).toBeDisabled();
  });

  it('cancels without sending anything, and gives focus back', async () => {
    const fetchMock = stubFetch(() => ({ status: 200, body: fixture() }));
    renderPage();
    await screen.findByRole('region', { name: 'Doctrine tree' });

    fireEvent.click(within(card('Boarding SOP')).getByRole('button', { name: 'Start research' }));
    fireEvent.click(within(card('Boarding SOP')).getByRole('button', { name: 'Cancel' }));

    const startAgain = within(card('Boarding SOP')).getByRole('button', { name: 'Start research' });
    expect(startAgain).toHaveFocus();
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
  });

  it('puts a refusal it already knows beside a disabled control', async () => {
    stubFetch(() => ({
      status: 200,
      body: fixture({
        balance: 10,
        nodes: {
          cost_index_sop: { status: 'available', startRefusal: 'insufficient_points' },
          boarding_sop: { status: 'available', startRefusal: 'insufficient_funds' },
        },
      }),
    }));
    renderPage();
    await screen.findByRole('region', { name: 'Doctrine tree' });

    const short = within(card('Cost-index SOP')).getByRole('button', { name: 'Start research' });
    expect(short).toBeDisabled();
    expect(short).toHaveAccessibleDescription(/Needs 40\.0 RP; you have 10\.0 RP/);

    const broke = within(card('Boarding SOP')).getByRole('button', { name: 'Start research' });
    expect(broke).toBeDisabled();
    expect(broke).toHaveAccessibleDescription(/Needs \$25,000 in cash/);
  });

  it('shows a 409 in words and re-reads the tree', async () => {
    let reads = 0;
    const fetchMock = stubFetch((url, init) => {
      if (url === '/api/research/projects' && init?.method === 'POST') {
        return {
          status: 409,
          body: { code: 'insufficient_points', message: 'Not enough research points' },
        };
      }
      reads += 1;
      // The second read is the truth the stale button did not know.
      return {
        status: 200,
        body:
          reads === 1
            ? fixture({ balance: 120 })
            : fixture({
                balance: 12.5,
                nodes: {
                  cost_index_sop: { status: 'available', startRefusal: 'insufficient_points' },
                },
              }),
      };
    });
    renderPage();
    await screen.findByRole('region', { name: 'Doctrine tree' });

    fireEvent.click(within(card('Cost-index SOP')).getByRole('button', { name: 'Start research' }));
    fireEvent.click(
      within(card('Cost-index SOP')).getByRole('button', {
        name: 'Confirm — start Cost-index SOP',
      }),
    );

    // Words against the re-read state: the balance it names is the one the server now holds.
    await waitFor(() => {
      expect(within(card('Cost-index SOP')).getByRole('alert')).toHaveTextContent(
        'Not started. Needs 40.0 RP; you have 12.5 RP. Points come only from academies and flying.',
      );
    });
    await waitFor(() => {
      expect(
        within(card('Cost-index SOP')).getByRole('button', { name: 'Start research' }),
      ).toBeDisabled();
    });
    expect(fetchMock.mock.calls.filter(([url]) => url === '/api/research')).toHaveLength(2);
  });

  it('reads the refusal whichever field the server puts it in', async () => {
    stubFetch((url, init) =>
      url === '/api/research/projects' && init?.method === 'POST'
        ? { status: 409, body: { refusal: 'project_running' } }
        : { status: 200, body: fixture() },
    );
    renderPage();
    await screen.findByRole('region', { name: 'Doctrine tree' });

    fireEvent.click(within(card('Boarding SOP')).getByRole('button', { name: 'Start research' }));
    fireEvent.click(
      within(card('Boarding SOP')).getByRole('button', { name: 'Confirm — start Boarding SOP' }),
    );

    expect(await within(card('Boarding SOP')).findByRole('alert')).toHaveTextContent(
      'Not started. Another project is running. One project at a time, airline-wide.',
    );
  });
});

describe('the active project', () => {
  it('counts down in game time from the world’s clock, not the browser’s', async () => {
    stubFetch(() => ({
      status: 200,
      body: fixture({
        nodes: {
          boarding_sop: {
            status: 'in_progress',
            startedAt: gameInstant(-10),
            completesAt: gameInstant(18),
          },
        },
        active: {
          nodeId: 'boarding_sop',
          startedAt: gameInstant(-10),
          completesAt: gameInstant(18),
        },
      }),
    }));
    renderPage();
    const active = await screen.findByRole('region', { name: 'Active project' });

    expect(within(active).getByText('Boarding SOP')).toBeInTheDocument();
    expect(within(active).getByText('Turnaround & Ground · Tier 1')).toBeInTheDocument();
    expect(within(active).getByText('2 game weeks, 4 game days remaining')).toBeInTheDocument();
    expect(within(active).getByRole('progressbar')).toHaveAttribute('aria-valuenow', '36');
    expect(within(active).getByText(gameInstant(-10).slice(0, 10))).toBeInTheDocument();
    expect(within(active).getByText(gameInstant(18).slice(0, 10))).toBeInTheDocument();
  });

  it('says plainly when nothing is running', async () => {
    stubFetch(() => ({ status: 200, body: fixture() }));
    renderPage();
    const active = await screen.findByRole('region', { name: 'Active project' });
    expect(within(active).getByText(/No project running/)).toBeInTheDocument();
  });
});

describe('page states', () => {
  it('announces loading while the read is in flight', () => {
    stubFetch(() => 'pending');
    renderPage();
    expect(screen.getByRole('heading', { level: 1, name: 'Research' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Reading your research…');
  });

  it('says the tree is unknown when the read fails, and can try again', async () => {
    let attempt = 0;
    const fetchMock = stubFetch(() => {
      attempt += 1;
      return attempt === 1 ? { status: 500, body: {} } : { status: 200, body: fixture() };
    });
    renderPage();

    expect(await screen.findByRole('alert')).toHaveTextContent(/Could not read your research/);
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('region', { name: 'Doctrine tree' })).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('treats a body that is not research as broken rather than crashing', async () => {
    stubFetch(() => ({ status: 200, body: {} }));
    renderPage();
    expect(await screen.findByRole('alert')).toHaveTextContent(/Could not read your research/);
  });

  it('is empty, not broken, for a player with no airline', async () => {
    stubFetch(() => ({ status: 409, body: { code: 'airline_required', message: 'No airline' } }));
    renderPage();
    expect(await screen.findByText(/No airline to research for yet/)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('link', { name: 'Open the founding desk' })).toHaveAttribute(
      'href',
      '/found',
    );
  });
});

describe('room for M9-06', () => {
  it('renders a readout slot and a per-node footer without disturbing the tree', () => {
    render(
      <MemoryRouter>
        <ResearchView
          research={fixture()}
          confirming={null}
          pending={null}
          failureFor={() => null}
          onRequestStart={() => undefined}
          onCancelStart={() => undefined}
          onConfirmStart={() => undefined}
          readout={<section aria-label="Efficiency readout">readout</section>}
          nodeFooter={(node) => <p>Doctrine strength for {node.name}</p>}
        />
      </MemoryRouter>,
    );

    expect(screen.getByRole('region', { name: 'Efficiency readout' })).toBeInTheDocument();
    expect(
      within(card('Cost-index SOP')).getByText('Doctrine strength for Cost-index SOP'),
    ).toBeInTheDocument();
    expect(screen.getAllByRole('article')).toHaveLength(24);
  });
});
