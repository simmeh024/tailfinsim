import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';

import type {
  AircraftAcquisitionQuoteResponse,
  AircraftAcquisitionResponse,
  AircraftSpec,
  FleetCatalogueResponse,
  OwnAirlineResponse,
  UsedMarketListing,
} from '@tailfin/shared';

import { ContextSelectionProvider, useContextSelection } from '../shell/context-selection';

import { FleetMarket } from './FleetMarket';

import type { ReactNode } from 'react';

const SPEC: AircraftSpec = {
  maxSeats: 180,
  seatsTwoClass: 165,
  maxPayloadTonnes: 20,
  rangeNm: 3500,
  cruiseSpeedKt: 450,
  mtowTonnes: 79,
  oewTonnes: 44,
  runwayRequirementM: 2100,
  fuelBurnKgPerHour: 2300,
  wingspanCode: 'C',
  noiseChapter: 14,
  turnaroundBaselineMin: 45,
};

const entry = (
  over: Partial<FleetCatalogueResponse['types'][number]> = {},
): FleetCatalogueResponse['types'][number] => ({
  designation: 'A320neo',
  family: 'A320',
  manufacturer: 'Airbus',
  class: 'narrowbody',
  availability: 'orderable',
  acquisitionMethods: ['new', 'lease', 'used'],
  detail: 'Available to order new, lease, or buy used.',
  arrivesOn: null,
  seatsTwoClass: 165,
  maxSeats: 180,
  rangeNm: 3500,
  mtowTonnes: 79,
  runwayRequirementM: 2100,
  wingspanCode: 'C',
  listPrice: 11_000_000_000,
  monthlyLeaseRate: 88_000_000,
  baseDeliveryLeadWeeks: 4,
  restrictions: [],
  restrictionCostPerDepartureMinor: 0,
  availableOptionIds: ['aux-tanks'],
  ...over,
});

const CATALOGUE: FleetCatalogueResponse = {
  inGameDate: '2026-08-23T12:00:00.000Z',
  catalogueVersion: 'v1',
  options: [
    {
      id: 'aux-tanks',
      name: 'Auxiliary centre tanks',
      summary: 'Adds range at the expense of weight and belly volume.',
      category: 'fuel',
      specDeltas: { rangeDeltaNm: 500, oewDeltaTonnes: 2, cargoVolumeFactor: 0.75 },
      priceMinor: 400_000_000,
      leadTimeWeeks: 2,
      retrofittable: false,
      requiresResearch: [],
      conflictsWith: [],
    },
  ],
  types: [
    entry(),
    entry({
      designation: 'A321XLR',
      family: 'A320',
      availability: 'prototype',
      acquisitionMethods: [],
      arrivesOn: '2026-11-01',
      detail: 'Flying as a prototype and cannot yet be ordered.',
      rangeNm: 4700,
      availableOptionIds: [],
    }),
    entry({
      designation: '737-800',
      family: '737 NG',
      manufacturer: 'Boeing',
      availability: 'used_only',
      acquisitionMethods: ['lease', 'used'],
      detail: 'Out of production. Available used or by lease.',
      listPrice: null,
      availableOptionIds: [],
    }),
    entry({
      designation: '777F',
      family: '777',
      manufacturer: 'Boeing',
      class: 'freighter',
      seatsTwoClass: 0,
      maxSeats: 0,
      rangeNm: 4970,
      runwayRequirementM: 2800,
      mtowTonnes: 347,
      availableOptionIds: [],
    }),
  ],
};

const OWN: OwnAirlineResponse = {
  airline: {
    id: '33333333-4444-4555-8666-777777777777',
    worldId: '11111111-2222-4333-8444-555555555555',
    playerId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    kind: 'player',
    archetype: null,
    name: 'Tailfin Air',
    iataCode: 'TF',
    icaoCode: 'TFN',
    callsign: 'TAILFIN',
    baseCountry: 'NL',
    logo: null,
    cash: 50_000_000_000,
    reputation: 0.5,
    status: 'active',
    statusChangedAt: '2026-08-20T10:00:00.000Z',
    ceasedAt: null,
    createdAt: '2026-08-20T10:00:00.000Z',
  },
  rebrand: null,
};

function listing(designation: string, id: string, registration: string): UsedMarketListing {
  return {
    id,
    typeDesignation: designation,
    registration,
    locationIcao: 'EHAM',
    buildOptionIds: [],
    effectiveSpec: SPEC,
    builtAt: '2018-08-23T12:00:00.000Z',
    hours: 18_000,
    cycles: 9_500,
    askingPriceMinor: 5_000_000_000,
    valuation: {
      anchorMinor: 11_000_000_000,
      anchorSource: 'list_price',
      ageYears: 8,
      ageFactor: 0.7,
      hours: 18_000,
      expectedHours: 20_000,
      utilisationFactor: 0.95,
      configurationFactor: 1,
      unusualness: 0,
      configurationDrags: [],
    },
    availableAt: '2026-08-20T12:00:00.000Z',
    expiresAt: '2026-08-27T12:00:00.000Z',
  };
}

const USED = {
  slots: 24,
  listings: [
    listing('737-800', '11111111-1111-4111-8111-111111111111', 'TU-7378'),
    listing('A320neo', '22222222-2222-4222-8222-222222222222', 'TU-320N'),
  ],
};

function quote(optionIds: string[]): AircraftAcquisitionQuoteResponse {
  const configured = optionIds.includes('aux-tanks');
  return {
    kind: 'new',
    catalogueVersion: 'v1',
    typeDesignation: 'A320neo',
    buildOptionIds: [...optionIds],
    effectiveSpec: {
      ...SPEC,
      rangeNm: configured ? 4000 : 3500,
      oewTonnes: configured ? 46 : 44,
    },
    chargedMinor: configured ? 11_400_000_000 : 11_000_000_000,
    monthlyLeaseRateMinor: null,
    baseLeadTimeWeeks: 4,
    optionLeadTimeWeeks: configured ? 2 : 0,
    totalLeadTimeWeeks: configured ? 6 : 4,
    cashMinor: OWN.airline!.cash,
    resultingCashMinor: OWN.airline!.cash - (configured ? 11_400_000_000 : 11_000_000_000),
    quotedAt: '2026-08-23T12:00:00.000Z',
    estimatedDeliveryAt: configured ? '2026-10-04T12:00:00.000Z' : '2026-09-20T12:00:00.000Z',
  };
}

function acquisitionResponse(kind: 'new' | 'used' | 'lease'): AircraftAcquisitionResponse {
  const immediate = kind !== 'new';
  const typeDesignation = kind === 'used' ? '737-800' : 'A320neo';
  return {
    order: {
      id: '99999999-9999-4999-8999-999999999999',
      worldId: OWN.airline!.worldId,
      airlineId: OWN.airline!.id,
      kind,
      status: immediate ? 'delivered' : 'pending',
      catalogueVersion: 'v1',
      typeDesignation,
      buildOptionIds: kind === 'new' ? ['aux-tanks'] : [],
      effectiveSpec: SPEC,
      chargedMinor:
        kind === 'new' ? 11_400_000_000 : kind === 'lease' ? 176_000_000 : 5_000_000_000,
      monthlyLeaseRateMinor: kind === 'lease' ? 88_000_000 : null,
      baseLeadTimeWeeks: kind === 'new' ? 4 : 0,
      optionLeadTimeWeeks: kind === 'new' ? 2 : 0,
      deliveryAirportIcao: 'EHAM',
      orderedAt: '2026-08-23T12:00:00.000Z',
      deliveryAt: kind === 'new' ? '2026-10-04T12:00:00.000Z' : '2026-08-23T12:00:00.000Z',
      deliveredAt: immediate ? '2026-08-23T12:00:00.000Z' : null,
      airframeId: immediate ? '88888888-8888-4888-8888-888888888888' : null,
    },
    airframe: immediate
      ? {
          id: '88888888-8888-4888-8888-888888888888',
          worldId: OWN.airline!.worldId,
          airlineId: OWN.airline!.id,
          typeDesignation,
          catalogueVersion: 'v1',
          registration: kind === 'used' ? 'TU-7378' : 'TF-LEASE',
          buildOptionIds: [],
          cabinConfigId: null,
          liveryId: null,
          effectiveSpec: SPEC,
          hours: kind === 'used' ? 18_000 : 0,
          cycles: kind === 'used' ? 9_500 : 0,
          ownership: kind === 'lease' ? 'leased' : 'owned',
          deliveredToIcao: 'EHAM',
          deliveredAt: '2026-08-23T12:00:00.000Z',
          ownerHistory: [],
        }
      : null,
    replayed: false,
  };
}

function stubMarketApi() {
  const posts: { url: string; body: Record<string, unknown> }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((input: unknown, init?: RequestInit) => {
      const url = String(input);
      const answer = (body: unknown, status = 200) =>
        Promise.resolve({
          ok: status >= 200 && status < 300,
          status,
          json: () => Promise.resolve(body),
        } as Response);
      if (url === '/api/airlines/me') return answer(OWN);
      if (url === '/api/fleet/used-market') return answer(USED);
      if (typeof init?.body !== 'string') {
        return Promise.reject(new Error(`Expected a JSON request body for ${url}`));
      }
      const body = JSON.parse(init.body) as Record<string, unknown>;
      if (url === '/api/fleet/acquisition-quotes') {
        posts.push({ url, body });
        return answer(
          body.kind === 'lease'
            ? {
                ...quote([]),
                kind: 'lease',
                chargedMinor: 176_000_000,
                monthlyLeaseRateMinor: 88_000_000,
                baseLeadTimeWeeks: 0,
                totalLeadTimeWeeks: 0,
                estimatedDeliveryAt: '2026-08-23T12:00:00.000Z',
              }
            : quote((body.optionIds as string[]) ?? []),
        );
      }
      if (url === '/api/fleet/acquisitions') {
        posts.push({ url, body });
        return answer(acquisitionResponse(body.kind as 'new' | 'used' | 'lease'), 201);
      }
      return Promise.reject(new Error(`Unexpected fetch ${url}`));
    }),
  );
  return posts;
}

function ContextProbe(): ReactNode {
  const { selection, clear, attachPanelBody } = useContextSelection();
  return (
    <aside aria-label="Context">
      <h2 id="context-panel-title" tabIndex={selection === null ? undefined : -1}>
        {selection?.title ?? 'Context'}
      </h2>
      {selection?.subtitle !== undefined && <p>{selection.subtitle}</p>}
      {selection !== null && (
        <button
          type="button"
          onClick={() => {
            selection.onClear?.();
            clear();
          }}
        >
          Clear selection
        </button>
      )}
      <div>
        {selection === null ? (
          <p>Selection detail appears here.</p>
        ) : selection.body === null ? (
          <div ref={attachPanelBody} />
        ) : (
          selection.body
        )}
      </div>
    </aside>
  );
}

function renderMarket(onAcquired = vi.fn()) {
  render(
    <ContextSelectionProvider>
      <MemoryRouter initialEntries={['/fleet']}>
        <FleetMarket catalogue={CATALOGUE} onAcquired={onAcquired} />
      </MemoryRouter>
      <ContextProbe />
    </ContextSelectionProvider>,
  );
  return onAcquired;
}

describe('the aircraft marketplace', () => {
  it('searches and filters canonical card data without showing filtered types', async () => {
    stubMarketApi();
    renderMarket();

    const search = screen.getByRole('searchbox', { name: 'Search aircraft' });
    fireEvent.change(search, { target: { value: 'Boeing' } });
    expect(await screen.findByRole('button', { name: /View Boeing 737-800/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /View Airbus A320neo/i })).toBeNull();

    fireEvent.change(screen.getByLabelText('Role'), { target: { value: 'cargo' } });
    expect(screen.getByRole('button', { name: /View Boeing 777F/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /View Boeing 737-800/i })).toBeNull();
  });

  it('withholds acquisition actions for a prototype and order-new for a used-only type', async () => {
    stubMarketApi();
    renderMarket();

    fireEvent.click(screen.getByRole('button', { name: /View Airbus A321XLR/i }));
    await screen.findByText('Flying as a prototype and cannot yet be ordered.');
    expect(screen.queryByRole('button', { name: /Order new/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Lease$/i })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /View Boeing 737-800/i }));
    await screen.findByText('Out of production. Available used or by lease.');
    expect(screen.queryByRole('button', { name: /Order new/i })).toBeNull();
    expect(await screen.findByRole('button', { name: /View used aircraft/i })).toBeInTheDocument();
  });

  it('opens a type-filtered physical used market and submits no client price', async () => {
    const posts = stubMarketApi();
    renderMarket();

    fireEvent.click(screen.getByRole('button', { name: /View Boeing 737-800/i }));
    fireEvent.click(await screen.findByRole('button', { name: /View used aircraft/i }));
    expect(await screen.findByText('TU-7378')).toBeInTheDocument();
    expect(screen.queryByText('TU-320N')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /Review used purchase/i }));
    fireEvent.click(screen.getByRole('button', { name: /Confirm used purchase/i }));
    await screen.findByText(/737-800 acquired/i);

    const purchase = posts.find((post) => post.url === '/api/fleet/acquisitions')!;
    expect(purchase.body).toMatchObject({
      kind: 'used',
      listingId: '11111111-1111-4111-8111-111111111111',
    });
    expect(purchase.body).not.toHaveProperty('price');
    expect(purchase.body).not.toHaveProperty('askingPriceMinor');
  });

  it('uses the server quote for option effects, confirms explicitly, and submits only ids', async () => {
    const posts = stubMarketApi();
    const acquired = renderMarket();

    fireEvent.click(await screen.findByRole('button', { name: /Order new/i }));
    const option = await screen.findByRole('checkbox', { name: /Auxiliary centre tanks/i });
    fireEvent.click(option);
    await waitFor(() => {
      const quotes = posts.filter((post) => post.url === '/api/fleet/acquisition-quotes');
      expect(quotes.at(-1)?.body).toMatchObject({ optionIds: ['aux-tanks'] });
    });
    expect(await screen.findByText('4,000 nm')).toBeInTheDocument();

    fireEvent.change(await screen.findByLabelText(/Delivery airport ICAO/i), {
      target: { value: 'eham' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Review order/i }));
    expect(await screen.findByText('Explicit confirmation')).toBeInTheDocument();
    expect(screen.getByText('Auxiliary centre tanks')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Confirm and order/i }));
    await screen.findByText(/Factory order accepted/i);

    const order = posts.find((post) => post.url === '/api/fleet/acquisitions')!;
    expect(order.body).toMatchObject({
      kind: 'new',
      typeDesignation: 'A320neo',
      optionIds: ['aux-tanks'],
      deliveryAirportIcao: 'EHAM',
    });
    expect(order.body).not.toHaveProperty('price');
    expect(order.body).not.toHaveProperty('effectiveSpec');
    expect(acquired).toHaveBeenCalledOnce();
  });

  it('distinguishes a lease deposit and monthly obligation without simulating either', async () => {
    const posts = stubMarketApi();
    const acquired = renderMarket();

    fireEvent.click(await screen.findByRole('button', { name: /^Lease$/i }));
    expect(await screen.findByText('Deposit due')).toBeInTheDocument();
    expect(screen.getByText('Monthly obligation')).toBeInTheDocument();
    expect(screen.getByText('1,760,000.00')).toBeInTheDocument();
    expect(screen.getByText('880,000.00')).toBeInTheDocument();

    fireEvent.change(await screen.findByLabelText(/Delivery airport ICAO/i), {
      target: { value: 'eham' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Review lease/i }));
    fireEvent.click(await screen.findByRole('button', { name: /Confirm lease deposit/i }));
    await screen.findByText('Lease delivered');

    const lease = posts.find(
      (post) => post.url === '/api/fleet/acquisitions' && post.body.kind === 'lease',
    )!;
    expect(lease.body).toMatchObject({
      kind: 'lease',
      typeDesignation: 'A320neo',
      deliveryAirportIcao: 'EHAM',
    });
    expect(lease.body).not.toHaveProperty('price');
    expect(lease.body).not.toHaveProperty('monthlyLeaseRateMinor');
    expect(acquired).toHaveBeenCalledOnce();
  });

  it('keeps selection and acquisition usable when an image fails', async () => {
    stubMarketApi();
    renderMarket();
    const card = screen.getByRole('button', { name: /View Airbus A320neo/i });
    const image = within(card).getByRole('img', {
      name: /Airbus A320neo in a neutral catalogue finish/i,
    });
    fireEvent.error(image);
    expect(
      within(card).getByRole('img', { name: /A320neo.*image unavailable/i }),
    ).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: /Order new/i })).toBeInTheDocument();
  });

  it('moves focus into the context detail and restores it when Escape clears selection', async () => {
    stubMarketApi();
    renderMarket();
    const xlrCard = screen.getByRole('button', { name: /View Airbus A321XLR/i });

    fireEvent.click(xlrCard);
    const heading = await screen.findByRole('heading', { name: 'A321XLR' });
    const context = screen.getByRole('complementary', { name: 'Context' });
    expect(within(context).getByLabelText('Selected aircraft')).toBeInTheDocument();
    await waitFor(() => expect(heading).toHaveFocus());

    fireEvent.keyDown(screen.getByLabelText('Selected aircraft'), { key: 'Escape' });
    await waitFor(() => expect(xlrCard).toHaveFocus());
    expect(within(context).getByRole('heading', { name: 'Context' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Selected aircraft')).toBeNull();
  });

  it('lets the shell clear the aircraft selection without leaving the card selected', async () => {
    stubMarketApi();
    renderMarket();
    const card = screen.getByRole('button', { name: /View Boeing 737-800/i });

    fireEvent.click(card);
    expect(await screen.findByRole('heading', { name: '737-800' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Clear selection' }));

    await waitFor(() => expect(card).toHaveFocus());
    expect(card).not.toHaveAttribute('aria-current');
    expect(screen.queryByLabelText('Selected aircraft')).toBeNull();
  });

  it('compares a bounded set using canonical values', async () => {
    stubMarketApi();
    renderMarket();
    const compareButtons = screen.getAllByRole('button', { name: 'Compare' });
    fireEvent.click(compareButtons[0]!);
    fireEvent.click(compareButtons[1]!);
    const comparison = await screen.findByRole('heading', { name: 'Aircraft comparison' });
    const table = comparison.closest('section')!;
    expect(within(table).getByText('3,500 nm')).toBeInTheDocument();
    expect(within(table).getByText('4,700 nm')).toBeInTheDocument();

    const remaining = screen.getAllByRole('button', { name: 'Compare' });
    fireEvent.click(remaining[0]!);
    expect(screen.getAllByRole('button', { name: 'Remove from compare' })).toHaveLength(3);
    expect(
      screen
        .getAllByRole('button', { name: 'Compare' })
        .every((button) => button.hasAttribute('disabled')),
    ).toBe(true);
  });
});
