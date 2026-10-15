import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ServicePage } from './ServicePage';

/**
 * The service configurator (M8-05, App. D.4).
 *
 * The acceptance criterion this file is for:
 *
 * > Updates live as options are toggled.
 *
 * "Live" is two claims, and both are tested: the table re-prices when a tier
 * changes, and it re-prices against the **package that is actually on screen**
 * rather than whichever request happened to come back last. The second is the
 * one that breaks quietly — a slow reply for an older draft overwriting a newer
 * one looks like an intermittently wrong number rather than like a bug.
 */

const CATALOGUE = {
  categories: [
    {
      category: 'catering',
      tiers: [
        {
          tier: 0,
          name: 'Nothing at all',
          requires: [],
          costPerPaxMinor: 0,
          revenuePerPaxMinor: 0,
          scoreBand: { min: 0, max: 0.05 },
          turnaroundDeltaMinutes: 0,
        },
        {
          tier: 1,
          name: 'Buy-on-board only',
          requires: [],
          costPerPaxMinor: 0,
          revenuePerPaxMinor: 420,
          scoreBand: { min: 0.1, max: 0.25 },
          turnaroundDeltaMinutes: 0,
        },
        {
          tier: 3,
          name: 'Hot meal service',
          requires: [],
          costPerPaxMinor: 840,
          revenuePerPaxMinor: 0,
          scoreBand: { min: 0.45, max: 0.62 },
          turnaroundDeltaMinutes: 5,
        },
      ],
    },
  ],
  commercialIntensity: {
    revenueMultiplierAtMax: 2,
    satisfactionPenaltyAtMax: 0.2,
    reputationRiskAbove: 0.75,
  },
};

/** What the one saved package in these tests contains. */
const EXISTING_CONTENT = { perClass: { economy: { catering: 3 } }, commercialIntensity: 0 };

const GROUPS = {
  groups: [
    {
      id: '11111111-1111-4111-8111-111111111111',
      name: 'Leisure',
      servicePackageId: null,
      servicePackageName: null,
      routes: [],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
  ],
  ungrouped: [],
};

/** The shape the stub server holds route groups in, so a write can change them. */
interface StubGroups {
  groups: {
    id: string;
    name: string;
    servicePackageId: string | null;
    servicePackageName: string | null;
    routes: { routeId: string; originIcao: string; destinationIcao: string }[];
    createdAt: string;
    updatedAt: string;
  }[];
  ungrouped: { routeId: string; originIcao: string; destinationIcao: string }[];
}

const ROUTE_AMS_LHR = {
  routeId: '22222222-2222-4222-8222-222222222221',
  originIcao: 'EHAM',
  destinationIcao: 'EGLL',
};
const ROUTE_AMS_CDG = {
  routeId: '22222222-2222-4222-8222-222222222222',
  originIcao: 'EHAM',
  destinationIcao: 'LFPG',
};
const ROUTE_AMS_FCO = {
  routeId: '22222222-2222-4222-8222-222222222223',
  originIcao: 'EHAM',
  destinationIcao: 'LIRF',
};

/** A network with routes: two in Leisure, one in no group. */
function networkWithRoutes(): StubGroups {
  return {
    groups: [
      {
        ...GROUPS.groups[0]!,
        routes: [ROUTE_AMS_LHR, ROUTE_AMS_CDG],
      },
    ],
    ungrouped: [ROUTE_AMS_FCO],
  };
}

/** A payback body whose numbers vary with the catering tier, so a change shows. */
function paybackFor(tier: number) {
  const cost = tier === 3 ? 840 : 0;
  return {
    context: { routes: 4, averageFareMinor: 10_133, routeGroupName: null },
    cabins: [
      {
        cabin: 'economy',
        costPerPaxMinor: cost,
        revenuePerPaxMinor: tier === 1 ? 420 : 0,
        netPerPaxMinor: (tier === 1 ? 420 : 0) - cost,
        turnaroundDeltaMinutes: tier === 3 ? 5 : 0,
        productScore: tier === 3 ? 0.31 : 0.05,
        productDelta: tier === 3 ? 0.18 : 0,
      },
    ],
    segments: [
      {
        segment: 'business',
        utilityGain: 0.396,
        farePremiumSupportedMinor: 3_648,
        netPerPaxMinor: 2_408,
        share: 0.4,
      },
      {
        segment: 'leisure',
        utilityGain: 0.144,
        farePremiumSupportedMinor: 486,
        netPerPaxMinor: -754,
        share: 0.45,
      },
      {
        segment: 'vfr',
        utilityGain: 0.108,
        farePremiumSupportedMinor: 456,
        netPerPaxMinor: -784,
        share: 0.15,
      },
    ],
    weightedNetPerPaxMinor: tier === 3 ? 300 : -100,
    execution: {
      value: 0.72,
      weakest: ['crewMorale'],
      absent: ['crewServiceSkill'],
      fromFallback: false,
    },
  };
}

describe('the service configurator', () => {
  /** Bodies queued for `/api/service/payback`, so a test can control ordering. */
  let paybackQueue: (() => Promise<Response>)[];
  let paybackCalls: unknown[];
  /** The airline's saved packages, as the stub server holds them. */
  let saved: {
    id: string;
    name: string;
    content: unknown;
    assignedGroups: number;
    createdAt: string;
    updatedAt: string;
  }[];
  let writes: { url: string; method: string; body: unknown }[];
  /** A status the next write should refuse with, instead of succeeding. */
  let refuseWith: { status: number; body: unknown } | null;
  /** The airline's route groups, as the stub server holds them. */
  let groups: StubGroups;
  /** Route-group reads answer this status instead, when set. */
  let groupsStatus: number;

  /** The next write's refusal, consumed — or null to let it through. */
  function takeRefusal(): Promise<Response> | null {
    if (refuseWith === null) return null;
    const refusal = refuseWith;
    refuseWith = null;
    return Promise.resolve(new Response(JSON.stringify(refusal.body), { status: refusal.status }));
  }

  beforeEach(() => {
    vi.useFakeTimers();
    paybackQueue = [];
    paybackCalls = [];
    saved = [];
    writes = [];
    refuseWith = null;
    groups = structuredClone(GROUPS);
    groupsStatus = 200;
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, init?: RequestInit): Promise<Response> => {
        if (url === '/api/service/catalogue') {
          return Promise.resolve(new Response(JSON.stringify(CATALOGUE), { status: 200 }));
        }
        if (url === '/api/service/route-groups' && (init?.method ?? 'GET') === 'GET') {
          return Promise.resolve(
            groupsStatus === 200
              ? new Response(JSON.stringify(groups), { status: 200 })
              : new Response('{}', { status: groupsStatus }),
          );
        }
        // The three SURFACE-11 writes, behaving as the server does: a create
        // moves the routes it names out of whatever group held them, and a
        // delete answers 204 with no body.
        if (url === '/api/service/route-groups' && init?.method === 'POST') {
          const body = JSON.parse(typeof init.body === 'string' ? init.body : '{}') as {
            name: string;
            routeIds?: string[];
          };
          writes.push({ url, method: 'POST', body });
          const refused = takeRefusal();
          if (refused !== null) return refused;
          const picked = new Set(body.routeIds ?? []);
          const everyRoute = [
            ...groups.groups.flatMap((group) => group.routes),
            ...groups.ungrouped,
          ];
          for (const group of groups.groups) {
            group.routes = group.routes.filter((route) => !picked.has(route.routeId));
          }
          groups.ungrouped = groups.ungrouped.filter((route) => !picked.has(route.routeId));
          groups.groups.push({
            ...GROUPS.groups[0]!,
            id: '33333333-3333-4333-8333-333333333333',
            name: body.name,
            routes: everyRoute.filter((route) => picked.has(route.routeId)),
          });
          return Promise.resolve(new Response('{}', { status: 201 }));
        }
        if (url.startsWith('/api/service/route-groups/') && init?.method === 'DELETE') {
          writes.push({ url, method: 'DELETE', body: init.body });
          const refused = takeRefusal();
          if (refused !== null) return refused;
          const gone = groups.groups.find((group) => url.endsWith(group.id));
          groups.groups = groups.groups.filter((group) => group !== gone);
          groups.ungrouped.push(...(gone?.routes ?? []));
          return Promise.resolve(new Response(null, { status: 204 }));
        }
        if (url.startsWith('/api/service/packages/') && init?.method === 'DELETE') {
          writes.push({ url, method: 'DELETE', body: init.body });
          const refused = takeRefusal();
          if (refused !== null) return refused;
          saved = saved.filter((entry) => !url.endsWith(entry.id));
          return Promise.resolve(new Response(null, { status: 204 }));
        }
        if (url === '/api/service/packages' && (init?.method ?? 'GET') === 'GET') {
          return Promise.resolve(
            new Response(JSON.stringify({ packages: saved }), { status: 200 }),
          );
        }
        if (
          (url === '/api/service/packages' || url.startsWith('/api/service/packages/')) &&
          init?.method !== undefined &&
          init.method !== 'GET'
        ) {
          const body = JSON.parse(typeof init.body === 'string' ? init.body : '{}') as {
            name: string;
            content: unknown;
          };
          writes.push({ url, method: init.method, body });
          if (refuseWith !== null) {
            const refusal = refuseWith;
            refuseWith = null;
            return Promise.resolve(
              new Response(JSON.stringify(refusal.body), { status: refusal.status }),
            );
          }
          const existing = saved.find((entry) => url.endsWith(entry.id));
          if (existing) {
            existing.name = body.name;
            existing.content = body.content;
            return Promise.resolve(new Response(null, { status: 200 }));
          }
          saved.push({
            id: 'pkg-1',
            name: body.name,
            content: body.content,
            assignedGroups: 0,
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          });
          return Promise.resolve(new Response(null, { status: 201 }));
        }
        if (url.startsWith('/api/service/route-groups/') && init?.method === 'PUT') {
          writes.push({
            url,
            method: 'PUT',
            body: JSON.parse(typeof init.body === 'string' ? init.body : '{}'),
          });
          return Promise.resolve(new Response(JSON.stringify(groups), { status: 200 }));
        }
        if (url === '/api/service/payback') {
          paybackCalls.push(JSON.parse(typeof init?.body === 'string' ? init.body : '{}'));
          const queued = paybackQueue.shift();
          if (queued) return queued();
          return Promise.resolve(new Response(JSON.stringify(paybackFor(0)), { status: 200 }));
        }
        throw new Error(`unexpected fetch ${url}`);
      }),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  /**
   * Advance past the debounce and let React apply what the replies set.
   *
   * Inside `act`, because the fetch continuations call `setState`: advancing the
   * timers alone fires the request and resolves the promise, but the render that
   * shows its answer happens in a later task that the assertion would otherwise
   * run ahead of.
   */
  async function settle(ms = 300): Promise<void> {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  }

  /**
   * Render, let the catalogue land, then let the first debounced price fire.
   *
   * Two passes, and the reason is ordering rather than impatience: the debounce
   * timer is only scheduled by the effect that runs *after* the catalogue's
   * reply sets state, so a single advance fires nothing — the timer does not
   * exist yet when the clock moves.
   */
  async function open(): Promise<void> {
    render(<ServicePage />);
    await settle();
    await settle();
  }

  it('shows the catalogue’s ladders with their prices', async () => {
    await open();
    expect(screen.getByRole('heading', { level: 1, name: 'Service' })).toBeInTheDocument();
    expect(screen.getByLabelText(/Hot meal service/)).toBeInTheDocument();
    // Buy-on-board earns, and the page shows that as a plus rather than a cost.
    expect(screen.getByText('+$4.20')).toBeInTheDocument();
    // Each ladder is named as App. D.2 names it, not by its enum key.
    expect(screen.getByRole('group', { name: 'Food & beverage' })).toBeInTheDocument();
    expect(screen.queryByText('catering')).toBeNull();
  });

  it('prices the package against the airline’s own routes', async () => {
    await open();
    const panel = screen.getByRole('complementary', { name: 'Payback' });
    expect(within(panel).getByText(/Against/)).toHaveTextContent('4');
    expect(within(panel).getByText(/average fare/)).toHaveTextContent('$101.33');
  });

  it('shows the same package as a loss on leisure and a win on business', async () => {
    await open();
    const panel = screen.getByRole('complementary', { name: 'Payback' });
    const business = within(panel).getByRole('row', { name: /Business/ });
    const leisure = within(panel).getByRole('row', { name: /Leisure/ });
    expect(business).toHaveTextContent('+$24.08');
    expect(leisure).toHaveTextContent('-$7.54');
  });

  it('re-prices live when a tier is toggled', async () => {
    await open();
    expect(paybackCalls).toHaveLength(1);

    paybackQueue.push(() =>
      Promise.resolve(new Response(JSON.stringify(paybackFor(3)), { status: 200 })),
    );
    fireEvent.click(screen.getByLabelText(/Hot meal service/));
    await settle();

    expect(paybackCalls).toHaveLength(2);
    // The package that went to the server is the one on screen.
    expect(paybackCalls[1]).toMatchObject({
      content: { perClass: { economy: { catering: 3 } } },
    });
    const panel = screen.getByRole('complementary', { name: 'Payback' });
    expect(within(panel).getByText(/per passenger/)).toHaveTextContent('+$3.00');
  });

  it('sends one request for a flurry of toggles rather than one each', async () => {
    await open();
    const before = paybackCalls.length;
    fireEvent.click(screen.getByLabelText(/Buy-on-board only/));
    await settle(50);
    fireEvent.click(screen.getByLabelText(/Hot meal service/));
    await settle(50);
    fireEvent.click(screen.getByLabelText(/Nothing at all/));
    await settle();
    expect(paybackCalls.length - before).toBe(1);
  });

  it('ignores a slow reply for a package that is no longer on screen', async () => {
    await open();

    // The first toggle's reply is held open; the second answers immediately.
    // Typed through a holder: assigned inside a Promise executor, TypeScript's
    // control flow narrows a bare `let` to `never` at the call site below.
    const stale: { release: (() => void) | null } = { release: null };
    paybackQueue.push(
      () =>
        new Promise<Response>((resolve) => {
          stale.release = () =>
            resolve(new Response(JSON.stringify(paybackFor(1)), { status: 200 }));
        }),
    );
    paybackQueue.push(() =>
      Promise.resolve(new Response(JSON.stringify(paybackFor(3)), { status: 200 })),
    );

    fireEvent.click(screen.getByLabelText(/Buy-on-board only/));
    await settle();
    fireEvent.click(screen.getByLabelText(/Hot meal service/));
    await settle();

    const panel = screen.getByRole('complementary', { name: 'Payback' });
    expect(within(panel).getByText(/per passenger/)).toHaveTextContent('+$3.00');

    // Now the stale one lands. It must not overwrite the newer table.
    stale.release?.();
    await settle(50);
    expect(within(panel).getByText(/per passenger/)).toHaveTextContent('+$3.00');
  });

  it('keeps the last good table when a price fails rather than blanking it', async () => {
    await open();
    paybackQueue.push(() => Promise.resolve(new Response('nope', { status: 500 })));
    fireEvent.click(screen.getByLabelText(/Hot meal service/));
    await settle();

    const panel = screen.getByRole('complementary', { name: 'Payback' });
    // Still the previous answer, not an empty panel.
    expect(within(panel).getByText(/per passenger/)).toHaveTextContent('-$1.00');
  });

  it('names the lever holding execution down', async () => {
    await open();
    const panel = screen.getByRole('complementary', { name: 'Payback' });
    expect(within(panel).getByText(/Execution 72%/)).toHaveTextContent('crew morale');
  });

  it('says a catalogue it cannot read is broken rather than crashing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string): Promise<Response> => {
        if (url === '/api/service/catalogue') {
          // A 200 carrying a body from some other release.
          return Promise.resolve(
            new Response(JSON.stringify({ unexpected: true }), { status: 200 }),
          );
        }
        return Promise.resolve(new Response(JSON.stringify(GROUPS), { status: 200 }));
      }),
    );
    render(<ServicePage />);
    await settle();
    await settle();
    expect(screen.getByText(/could not be read/)).toBeInTheDocument();
  });

  describe('saving and putting a package to work', () => {
    /** One saved package the stub already holds. */
    function existing(name = 'Existing', content: unknown = EXISTING_CONTENT) {
      return [
        {
          id: 'pkg-1',
          name,
          content,
          assignedGroups: 0,
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      ];
    }

    it('refuses to save a package with no name, before asking the server', async () => {
      await open();
      fireEvent.click(screen.getByRole('button', { name: 'Save package' }));
      await settle(0);
      expect(screen.getByText(/Give the package a name/)).toBeInTheDocument();
      expect(writes).toEqual([]);
    });

    it('saves the package on the bench under its name', async () => {
      await open();
      fireEvent.click(screen.getByLabelText(/Hot meal service/));
      fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Premium short-haul' } });
      await settle();
      fireEvent.click(screen.getByRole('button', { name: 'Save package' }));
      await settle();

      expect(writes[0]).toMatchObject({
        url: '/api/service/packages',
        method: 'POST',
        body: { name: 'Premium short-haul', content: { perClass: { economy: { catering: 3 } } } },
      });
      expect(screen.getByText(/Saved/)).toHaveTextContent('Premium short-haul');
    });

    it('edits a saved package in place rather than making a second one', async () => {
      await open();
      fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Budget' } });
      await settle();
      fireEvent.click(screen.getByRole('button', { name: 'Save package' }));
      await settle();

      // The bench now edits what it just saved, so the next save is a PUT.
      fireEvent.click(screen.getByLabelText(/Buy-on-board only/));
      await settle();
      fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
      await settle();

      expect(writes.map((entry) => entry.method)).toEqual(['POST', 'PUT']);
      expect(writes[1]?.url).toBe('/api/service/packages/pkg-1');
      expect(saved).toHaveLength(1);
    });

    it('loads a saved package back onto the bench', async () => {
      saved = existing();
      await open();
      fireEvent.change(screen.getByLabelText('Editing'), { target: { value: 'pkg-1' } });
      await settle();

      expect(screen.getByLabelText('Name')).toHaveValue('Existing');
      expect(screen.getByLabelText(/Hot meal service/)).toBeChecked();
    });

    it('assigns a package to a route group, which is what puts it in service', async () => {
      saved = existing('Budget', { perClass: {}, commercialIntensity: 0 });
      await open();
      const panel = screen.getByRole('region', { name: 'Route groups' });
      fireEvent.change(within(panel).getByLabelText('Leisure'), { target: { value: 'pkg-1' } });
      await settle();

      expect(writes[0]).toMatchObject({
        url: '/api/service/route-groups/11111111-1111-4111-8111-111111111111',
        method: 'PUT',
        body: { servicePackageId: 'pkg-1' },
      });
    });

    it('takes a group back to baseline service by clearing its package', async () => {
      saved = existing('Budget', { perClass: {}, commercialIntensity: 0 });
      await open();
      const panel = screen.getByRole('region', { name: 'Route groups' });
      fireEvent.change(within(panel).getByLabelText('Leisure'), { target: { value: '' } });
      await settle();
      expect(writes[0]).toMatchObject({ body: { servicePackageId: null } });
    });

    it('shows a refused save as refused, and a dropped one as broken', async () => {
      await open();
      fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Clash' } });
      await settle();

      refuseWith = { status: 409, body: { code: 'duplicate_name', message: 'Name already used.' } };
      fireEvent.click(screen.getByRole('button', { name: 'Save package' }));
      await settle();
      expect(
        screen.getByText('Name already used.').closest<HTMLElement>('.state')?.dataset.state,
      ).toBe('refused');

      refuseWith = { status: 500, body: { code: 'oops', message: 'Something broke.' } };
      fireEvent.click(screen.getByRole('button', { name: 'Save package' }));
      await settle();
      expect(
        screen.getByText('Something broke.').closest<HTMLElement>('.state')?.dataset.state,
      ).toBe('broken');
    });
  });

  /*
   * SURFACE-11: the lifecycle runs both ways. A route group is created from what
   * M8-03 says a group is — a name and the airline's routes — and a group or a
   * package is deleted only on the second click. Every refusal is shown as the
   * server sent it, and the page re-reads rather than patching its own copy.
   */
  describe('creating and deleting route groups and packages', () => {
    const LEISURE_ID = '11111111-1111-4111-8111-111111111111';

    /** The state a StateBlock carrying this text is in. */
    function stateOf(text: string | RegExp): string | undefined {
      return screen.getByText(text).closest<HTMLElement>('.state')?.dataset.state;
    }

    function groupsPanel(): HTMLElement {
      return screen.getByRole('region', { name: 'Route groups' });
    }

    function savedPackage(assignedGroups = 0) {
      return {
        id: 'pkg-1',
        name: 'Existing',
        content: EXISTING_CONTENT,
        assignedGroups,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      };
    }

    it('lists each group with the routes in it', async () => {
      groups = networkWithRoutes();
      await open();
      const panel = groupsPanel();
      expect(within(panel).getByText(/2 routes: EHAM → EGLL, EHAM → LFPG/)).toBeInTheDocument();
      // The package select is still labelled by its group, as it was.
      expect(within(panel).getByLabelText('Leisure')).toHaveValue('');
    });

    it('says an airline with no groups has none, as empty rather than broken', async () => {
      groups = { groups: [], ungrouped: [ROUTE_AMS_FCO] };
      await open();
      expect(stateOf(/No route groups yet/)).toBe('empty');
      // The form is there regardless: an empty list is where the lifecycle starts.
      expect(within(groupsPanel()).getByRole('button', { name: 'Create group' })).toBeEnabled();
    });

    it('says groups it could not read are broken, and offers no form against them', async () => {
      groupsStatus = 500;
      await open();
      expect(stateOf(/route groups could not be read/)).toBe('broken');
      expect(within(groupsPanel()).queryByRole('button', { name: 'Create group' })).toBeNull();
    });

    it('creates a group from a name and the routes picked, then re-reads the configuration', async () => {
      groups = networkWithRoutes();
      await open();
      const form = screen.getByRole('form', { name: 'New route group' });
      // A route already in a group says so: picking it moves it.
      expect(within(form).getByLabelText(/EHAM → LFPG\s*in Leisure/)).not.toBeChecked();

      fireEvent.change(within(form).getByLabelText('Group name'), {
        target: { value: '  City breaks  ' },
      });
      fireEvent.click(within(form).getByLabelText(/EHAM → LIRF/));
      fireEvent.click(within(form).getByLabelText(/EHAM → LFPG/));
      fireEvent.click(within(form).getByRole('button', { name: 'Create group' }));
      await settle();

      expect(writes).toEqual([
        {
          url: '/api/service/route-groups',
          method: 'POST',
          body: {
            name: 'City breaks',
            routeIds: [ROUTE_AMS_CDG.routeId, ROUTE_AMS_FCO.routeId],
          },
        },
      ]);
      // What is on screen is the server's answer: the new group holds both
      // routes, and Leisure lost the one that moved.
      const panel = groupsPanel();
      expect(within(panel).getByLabelText('City breaks')).toBeInTheDocument();
      expect(within(panel).getByText(/2 routes: EHAM → LFPG, EHAM → LIRF/)).toBeInTheDocument();
      expect(within(panel).getByText(/1 route: EHAM → EGLL/)).toBeInTheDocument();
      expect(within(panel).getByRole('status')).toHaveTextContent('Created “City breaks”.');
      // The form is cleared for the next one.
      expect(within(form).getByLabelText('Group name')).toHaveValue('');
      // And the new group is something a package can be priced against.
      expect(screen.getByLabelText('Priced against')).toHaveTextContent('City breaks');
    });

    it('sends a name alone when no route is picked — the schema’s routes are optional', async () => {
      await open();
      const form = screen.getByRole('form', { name: 'New route group' });
      expect(within(form).getByText(/You fly no routes yet/)).toBeInTheDocument();
      fireEvent.change(within(form).getByLabelText('Group name'), { target: { value: 'Later' } });
      fireEvent.click(within(form).getByRole('button', { name: 'Create group' }));
      await settle();
      expect(writes).toEqual([
        { url: '/api/service/route-groups', method: 'POST', body: { name: 'Later' } },
      ]);
    });

    it('refuses a group with no name before asking the server', async () => {
      await open();
      fireEvent.click(within(groupsPanel()).getByRole('button', { name: 'Create group' }));
      await settle(0);
      expect(stateOf('Give the group a name first.')).toBe('refused');
      expect(writes).toEqual([]);
    });

    it.each([
      [409, 'duplicate_name', 'You already have one with that name.'],
      [404, 'unknown_routes', 'One or more of those routes is not yours.'],
      [409, 'airline_restricted', 'This airline is restricted and cannot make new commitments'],
    ])(
      'shows a %i %s create refusal as the server sent it, and keeps the form',
      async (status, code, message) => {
        groups = networkWithRoutes();
        await open();
        const form = screen.getByRole('form', { name: 'New route group' });
        fireEvent.change(within(form).getByLabelText('Group name'), {
          target: { value: 'Leisure' },
        });
        fireEvent.click(within(form).getByLabelText(/EHAM → LIRF/));
        refuseWith = { status, body: { code, message } };
        fireEvent.click(within(form).getByRole('button', { name: 'Create group' }));
        await settle();

        expect(stateOf(message)).toBe('refused');
        // Nothing the player typed is lost, and the groups are as they were.
        expect(within(form).getByLabelText('Group name')).toHaveValue('Leisure');
        expect(within(form).getByLabelText(/EHAM → LIRF/)).toBeChecked();
        expect(within(groupsPanel()).getAllByRole('listitem')).toHaveLength(1);
      },
    );

    it('deletes a group only on the second click, saying what happens to its routes', async () => {
      groups = networkWithRoutes();
      await open();
      const panel = groupsPanel();

      fireEvent.click(within(panel).getByRole('button', { name: 'Delete Leisure' }));
      await settle(0);
      expect(writes).toEqual([]);
      expect(
        within(panel).getByText('2 routes fall back to baseline service.'),
      ).toBeInTheDocument();

      // Keep backs out without a write.
      fireEvent.click(within(panel).getByRole('button', { name: 'Keep Leisure' }));
      await settle(0);
      expect(writes).toEqual([]);

      fireEvent.click(within(panel).getByRole('button', { name: 'Delete Leisure' }));
      fireEvent.click(within(panel).getByRole('button', { name: 'Confirm delete Leisure' }));
      await settle();

      // No body: the id is in the path.
      expect(writes).toEqual([
        { url: `/api/service/route-groups/${LEISURE_ID}`, method: 'DELETE', body: undefined },
      ]);
      expect(within(panel).queryByLabelText('Leisure')).toBeNull();
      expect(stateOf(/No route groups yet/)).toBe('empty');
      expect(within(panel).getByRole('status')).toHaveTextContent(
        'Deleted “Leisure”. Its 2 routes fly baseline service now.',
      );
      // Its routes are back in the picker, in no group.
      const form = screen.getByRole('form', { name: 'New route group' });
      expect(within(form).queryByText(/in Leisure/)).toBeNull();
    });

    it('stops pricing against a group once it is deleted', async () => {
      await open();
      fireEvent.change(screen.getByLabelText('Priced against'), { target: { value: LEISURE_ID } });
      await settle();
      fireEvent.click(within(groupsPanel()).getByRole('button', { name: 'Delete Leisure' }));
      fireEvent.click(
        within(groupsPanel()).getByRole('button', { name: 'Confirm delete Leisure' }),
      );
      await settle();
      expect(screen.getByLabelText('Priced against')).toHaveValue('');
    });

    it('shows a refused group delete through StateBlock and re-reads the list', async () => {
      await open();
      refuseWith = {
        status: 404,
        body: { code: 'not_found', message: 'No such service package or route group.' },
      };
      // The group went in another tab: the server no longer holds it either.
      groups = { groups: [], ungrouped: [] };
      fireEvent.click(within(groupsPanel()).getByRole('button', { name: 'Delete Leisure' }));
      fireEvent.click(
        within(groupsPanel()).getByRole('button', { name: 'Confirm delete Leisure' }),
      );
      await settle();

      expect(stateOf('No such service package or route group.')).toBe('refused');
      expect(within(groupsPanel()).queryByLabelText('Leisure')).toBeNull();
    });

    it('deletes a saved package only on the second click, and keeps the draft', async () => {
      saved = [savedPackage()];
      await open();
      fireEvent.change(screen.getByLabelText('Editing'), { target: { value: 'pkg-1' } });
      await settle();

      fireEvent.click(screen.getByRole('button', { name: 'Delete package' }));
      await settle(0);
      expect(writes).toEqual([]);
      fireEvent.click(screen.getByRole('button', { name: 'Keep' }));
      await settle(0);
      expect(writes).toEqual([]);

      fireEvent.click(screen.getByRole('button', { name: 'Delete package' }));
      fireEvent.click(screen.getByRole('button', { name: 'Confirm delete' }));
      await settle();

      expect(writes).toEqual([
        { url: '/api/service/packages/pkg-1', method: 'DELETE', body: undefined },
      ]);
      const editing = screen.getByLabelText('Editing');
      expect(within(editing).queryByRole('option', { name: /Existing/ })).toBeNull();
      expect(editing).toHaveValue('');
      // What was on the bench is still there, now as an unsaved package.
      expect(screen.getByRole('button', { name: 'Save package' })).toBeInTheDocument();
      expect(screen.getByLabelText(/Hot meal service/)).toBeChecked();
      expect(screen.getByText('Deleted “Existing”.')).toBeInTheDocument();
    });

    it('shows the server’s package_in_use refusal and keeps the package', async () => {
      saved = [savedPackage(1)];
      await open();
      fireEvent.change(screen.getByLabelText('Editing'), { target: { value: 'pkg-1' } });
      await settle();

      // Not pre-judged: the button is live although a group flies the package.
      refuseWith = {
        status: 409,
        body: {
          code: 'package_in_use',
          message: 'Still flown by Leisure. Reassign those route groups first.',
        },
      };
      fireEvent.click(screen.getByRole('button', { name: 'Delete package' }));
      fireEvent.click(screen.getByRole('button', { name: 'Confirm delete' }));
      await settle();

      expect(stateOf('Still flown by Leisure. Reassign those route groups first.')).toBe('refused');
      expect(screen.getByLabelText('Editing')).toHaveValue('pkg-1');
      expect(screen.getByRole('button', { name: 'Save changes' })).toBeInTheDocument();

      // Taking the group away is what the refusal points to; once it has gone,
      // "Still flown by Leisure" is no longer true and is not left standing.
      fireEvent.click(within(groupsPanel()).getByRole('button', { name: 'Delete Leisure' }));
      fireEvent.click(
        within(groupsPanel()).getByRole('button', { name: 'Confirm delete Leisure' }),
      );
      await settle();
      expect(screen.queryByText(/Still flown by Leisure/)).toBeNull();
    });

    it('lets a package that went in another tab be saved again as new', async () => {
      saved = [savedPackage()];
      await open();
      fireEvent.change(screen.getByLabelText('Editing'), { target: { value: 'pkg-1' } });
      await settle();

      refuseWith = {
        status: 404,
        body: { code: 'not_found', message: 'No such service package or route group.' },
      };
      saved = [];
      fireEvent.click(screen.getByRole('button', { name: 'Delete package' }));
      fireEvent.click(screen.getByRole('button', { name: 'Confirm delete' }));
      await settle();

      expect(stateOf('No such service package or route group.')).toBe('refused');
      expect(screen.getByLabelText('Editing')).toHaveValue('');
      expect(screen.getByLabelText('Name')).toHaveValue('Existing');
    });

    it('shows a delete that never reached the server as broken', async () => {
      saved = [savedPackage()];
      await open();
      fireEvent.change(screen.getByLabelText('Editing'), { target: { value: 'pkg-1' } });
      await settle();

      const working = globalThis.fetch;
      vi.stubGlobal(
        'fetch',
        vi.fn((url: string, init?: RequestInit) =>
          init?.method === 'DELETE' ? Promise.reject(new TypeError('offline')) : working(url, init),
        ),
      );
      fireEvent.click(screen.getByRole('button', { name: 'Delete package' }));
      fireEvent.click(screen.getByRole('button', { name: 'Confirm delete' }));
      await settle();

      expect(stateOf('The server could not be reached.')).toBe('broken');
      expect(screen.getByLabelText('Editing')).toHaveValue('pkg-1');
    });
  });
});
