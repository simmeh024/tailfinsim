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

  beforeEach(() => {
    vi.useFakeTimers();
    paybackQueue = [];
    paybackCalls = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, init?: RequestInit): Promise<Response> => {
        if (url === '/api/service/catalogue') {
          return Promise.resolve(new Response(JSON.stringify(CATALOGUE), { status: 200 }));
        }
        if (url === '/api/service/route-groups') {
          return Promise.resolve(new Response(JSON.stringify(GROUPS), { status: 200 }));
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
});
