import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';

import type {
  AirframeDetailResponse,
  FleetAirframesResponse,
  FleetCatalogueResponse,
  MeResponse,
  VersionResponse,
} from '@tailfin/shared';

import { App } from '../App';
import { waitForSignInCheck } from '../test-gates';

/**
 * The fleet page, as a player meets it (M4-02, M4-07).
 *
 * The catalogue's criterion: *"Types arriving soon are visible with their EIS
 * date, not hidden."* Its opposite matters just as much — a type that has not
 * flown must not appear at all, because §7.2b says it *does not exist* in that
 * world, and the server is what enforces that.
 *
 * M4-07 adds the fleet a player owns, and two claims this file is accountable
 * for:
 *
 *   1. **The effective spec shows the base value and the delta per option.** The
 *      first acceptance criterion, and the reason the detail view exists at all.
 *   2. **The livery cell is a server-decided image or nothing.** The second
 *      criterion cannot be *met* — the renderer is M6-06 and there is no livery
 *      document to render — so what is asserted is the property standing in for
 *      it: the client never composes a livery, and the moment the server sends a
 *      URL the cell becomes that image.
 */

const ME: MeResponse = {
  player: {
    id: '11111111-2222-3333-4444-555555555555',
    displayName: 'Amelia Hart',
    avatarUrl: null,
    createdAt: '2026-08-17T09:00:00.000Z',
  },
  registrationOpen: false,
  isAdmin: false,
};

const VERSION: VersionResponse = {
  build: 240,
  commit: 'abc9999',
  environment: 'dev',
  startedAt: '2026-08-21T12:00:00.000Z',
  ref: 'origin/main',
  deployedAt: '2026-08-21T11:55:00.000Z',
  serverTime: '2026-08-21T12:05:00.000Z',
};

const entry = (over: Partial<FleetCatalogueResponse['types'][number]> = {}) => ({
  designation: 'A320neo',
  family: 'A320neo',
  manufacturer: 'Airbus',
  class: 'narrowbody' as const,
  availability: 'orderable' as const,
  detail: 'Available to order new, lease, or buy used.',
  arrivesOn: null,
  seatsTwoClass: 165,
  maxSeats: 180,
  rangeNm: 3_500,
  mtowTonnes: 79,
  runwayRequirementM: 2_100,
  wingspanCode: 'C' as const,
  listPrice: 11_000_000_000,
  monthlyLeaseRate: 88_000_000,
  baseDeliveryLeadWeeks: 4,
  restrictions: [],
  restrictionCostPerDepartureMinor: 0,
  // M4-03. The page does not render the configurator — that is M4-07's detail
  // view — but the response carries it, so the fixture does too.
  availableOptionIds: [],
  ...over,
});

const CATALOGUE: FleetCatalogueResponse = {
  inGameDate: '2024-10-20T00:00:00.000Z',
  catalogueVersion: 'v1',
  options: [],
  types: [
    entry(),
    entry({
      designation: 'A321XLR',
      availability: 'prototype',
      arrivesOn: '2024-11-11',
      detail: 'Flying as a prototype. Enters service on 2024-11-11, and can be ordered from then.',
      seatsTwoClass: 180,
      rangeNm: 4_700,
    }),
    entry({
      designation: '737-800',
      manufacturer: 'Boeing',
      availability: 'used_only',
      detail: 'Out of production since 2020-01-01. Available on the used market and by lease only.',
      listPrice: null,
    }),
  ],
};

const AIRFRAME_ID = '9f8e7d6c-5b4a-4392-8271-605f4e3d2c1b';
const GROUNDED_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

/** The grounded ATR, which the server sorts to the top: it cannot fly. */
const GROUNDED = {
  airframeId: GROUNDED_ID,
  registration: 'PH-TFB',
  typeDesignation: 'ATR 72-600',
  family: 'ATR 72',
  manufacturer: 'ATR',
  aircraftClass: 'turboprop_regional' as const,
  liveryId: null,
  liveryThumbnailUrl: null,
  locationIcao: 'EHRD',
  status: 'grounded' as const,
  checkTier: null,
  checkCompletesAt: null,
  airworthy: false,
  technicalRisk: 0.21,
  ownership: 'owned' as const,
  hours: 22_100,
  cycles: 18_400,
  ageYears: 12.4,
  utilisation: { windowDays: 7, blockHours: 0, blockHoursPerDay: 0 },
  nextCheck: {
    tier: 'c' as const,
    hoursRemaining: -180,
    cyclesRemaining: -40,
    binding: 'hours' as const,
    usedFraction: 1.6,
    due: true,
    costMinor: 24_000_000,
    downtimeDays: 10,
  },
  activeScheduleCount: 0,
};

/** The working A320neo, with a rate and a plan. */
const FLYING = {
  airframeId: AIRFRAME_ID,
  registration: 'PH-TFA',
  typeDesignation: 'A320neo',
  family: 'A320neo',
  manufacturer: 'Airbus',
  aircraftClass: 'narrowbody' as const,
  liveryId: null,
  liveryThumbnailUrl: null,
  locationIcao: 'EHAM',
  status: 'in_service' as const,
  checkTier: null,
  checkCompletesAt: null,
  airworthy: true,
  technicalRisk: 0.004,
  ownership: 'leased' as const,
  hours: 1_240.5,
  cycles: 610,
  ageYears: null,
  utilisation: { windowDays: 7, blockHours: 43.4, blockHoursPerDay: 6.2 },
  nextCheck: {
    tier: 'a' as const,
    hoursRemaining: 210,
    cyclesRemaining: 95,
    binding: 'cycles' as const,
    usedFraction: 0.72,
    due: false,
    costMinor: 1_800_000,
    downtimeDays: 1,
  },
  activeScheduleCount: 1,
};

/**
 * As the server sends it: most urgent first, so the grounded ATR leads. The
 * client must not reorder this — `urgency` is the server's decision, and a table
 * that re-sorted would put a different aeroplane at the top of the page from the
 * one the API says needs attention.
 */
const FLEET: FleetAirframesResponse = { airframes: [GROUNDED, FLYING] };

const A320_BASE = {
  maxSeats: 180,
  seatsTwoClass: 165,
  maxPayloadTonnes: 20,
  rangeNm: 3_500,
  cruiseSpeedKt: 447,
  mtowTonnes: 79,
  oewTonnes: 44.3,
  runwayRequirementM: 2_100,
  fuelBurnKgPerHour: 2_100,
  wingspanCode: 'C' as const,
  noiseChapter: 14,
  turnaroundBaselineMin: 40,
};

/**
 * The A320neo `spec-decomposition.ts` uses as its worked example: the efficiency
 * package folded first, then sharklets. The two burn figures are the real folded
 * ones, and showing them rather than *"−2%"* and *"−3.5%"* is the whole point of
 * the first acceptance criterion.
 */
const DETAIL: AirframeDetailResponse = {
  airframe: FLYING,
  spec: {
    base: A320_BASE,
    steps: [
      {
        optionId: 'efficiency-package',
        label: 'Extra fuel-efficiency package',
        category: 'engine',
        summary: 'Two per cent off the burn, for money and a longer wait.',
        spec: { ...A320_BASE, fuelBurnKgPerHour: 2_058 },
        movements: [{ axis: 'fuelBurnKgPerHour', before: 2_100, after: 2_058 }],
        wingspan: null,
        capabilityMovements: [],
        capabilitiesGained: [],
        priceMinor: 500_000_000,
        leadTimeWeeks: 2,
      },
      {
        optionId: 'sharklets',
        label: 'Sharklets',
        category: 'aerodynamic',
        summary: 'Three and a half per cent off the burn. Pushes the wingspan code up.',
        spec: { ...A320_BASE, fuelBurnKgPerHour: 1_985.97, wingspanCode: 'D' },
        movements: [{ axis: 'fuelBurnKgPerHour', before: 2_058, after: 1_985.97 }],
        wingspan: { before: 'C', after: 'D' },
        capabilityMovements: [],
        capabilitiesGained: [],
        priceMinor: 200_000_000,
        leadTimeWeeks: 1,
      },
    ],
    effective: { ...A320_BASE, fuelBurnKgPerHour: 1_985.97, wingspanCode: 'D' },
    capabilities: {
      cargoVolumeFactor: 1,
      comfortDelta: 0,
      maintenanceCostFactor: 1,
      lowVisibilityCancellationFactor: 1,
      etopsMinutes: null,
      ulhCapable: false,
      unpavedCapable: false,
    },
    priceMinor: 11_700_000_000,
    leadTimeWeeks: 3,
  },
  options: [],
  cabinConfigId: null,
  assignments: [
    {
      scheduleId: 'cccccccc-dddd-4eee-8fff-000000000000',
      active: true,
      repeat: { kind: 'daily' },
      legs: [
        {
          legIndex: 0,
          originIcao: 'EHAM',
          destinationIcao: 'EGLL',
          departureMinute: 480,
          blockMinutes: 75,
          turnaroundMinutes: 40,
        },
        {
          legIndex: 1,
          originIcao: 'EGLL',
          destinationIcao: 'EHAM',
          departureMinute: 620,
          blockMinutes: 75,
          turnaroundMinutes: 40,
        },
      ],
      dailyBlockMinutes: 150,
    },
  ],
  maintenance: {
    airframeId: AIRFRAME_ID,
    registration: 'PH-TFA',
    typeDesignation: 'A320neo',
    maintenanceProfile: 'narrowbody',
    status: 'in_service',
    checkTier: null,
    checkCompletesAt: null,
    totalHours: 1_240.5,
    totalCycles: 610,
    technicalRisk: 0.004,
    airworthy: true,
    dueTiers: [],
    tiers: [
      {
        tier: 'a',
        hoursRemaining: 210,
        cyclesRemaining: 95,
        binding: 'cycles',
        usedFraction: 0.72,
        due: false,
        costMinor: 1_800_000,
        downtimeDays: 1,
      },
      {
        tier: 'c',
        hoursRemaining: 6_259.5,
        cyclesRemaining: 4_390,
        binding: 'cycles',
        usedFraction: 0.12,
        due: false,
        costMinor: 42_000_000,
        downtimeDays: 14,
      },
      {
        tier: 'd',
        hoursRemaining: 28_759.5,
        cyclesRemaining: 19_390,
        binding: 'cycles',
        usedFraction: 0.03,
        due: false,
        costMinor: 200_000_000,
        downtimeDays: 35,
      },
    ],
  },
  provenance: {
    builtAt: null,
    deliveredAt: '2024-10-21T09:00:00.000Z',
    deliveredToIcao: 'EHAM',
    acquisitionKind: 'lease',
    ownerHistory: [],
  },
};

function stubApi(
  catalogue: FleetCatalogueResponse | null = CATALOGUE,
  fleet: FleetAirframesResponse | null = FLEET,
) {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: unknown) => {
      const url = String(input);
      const json = (body: unknown) =>
        Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) } as Response);
      const failure = (status: number) =>
        Promise.resolve({ ok: false, status, json: () => Promise.resolve({}) } as Response);

      if (url === '/api/me') return json(ME);
      if (url === '/api/version') return json(VERSION);
      if (url === '/api/airlines/me') return json({ airline: null, rebrand: null });
      if (url === '/api/fleet/catalogue') {
        return catalogue === null ? failure(500) : json(catalogue);
      }
      if (url === '/api/fleet/airframes') {
        return fleet === null ? failure(500) : json(fleet);
      }
      if (url === `/api/fleet/airframes/${AIRFRAME_ID}`) return json(DETAIL);
      // Every other airframe id is a 404, which is what a cross-owner id gets
      // (ADR-0020) as well as one that does not exist.
      if (url.startsWith('/api/fleet/airframes/')) return failure(404);
      if (url.startsWith('/api/airlines/founding')) return json({ worlds: [], memberships: [] });
      return Promise.reject(new Error(`unexpected fetch: ${url}`));
    }),
  );
}

async function openFleet(): Promise<void> {
  render(
    <MemoryRouter initialEntries={['/fleet']}>
      <App />
    </MemoryRouter>,
  );
  await waitForSignInCheck();
}

/** The catalogue table, told apart from the fleet table by a column only it has. */
async function catalogueTable(): Promise<HTMLElement> {
  const tables = await screen.findAllByRole('table');
  const found = tables.find((table) => within(table).queryByText('Range (nm)') !== null);
  if (!found) throw new Error('No catalogue table rendered');
  return found;
}

async function fleetTable(): Promise<HTMLElement> {
  const tables = await screen.findAllByRole('table');
  const found = tables.find((table) => within(table).queryByText('Registration') !== null);
  if (!found) throw new Error('No fleet table rendered');
  return found;
}

describe('the fleet catalogue', () => {
  it('lists what this world can fly', async () => {
    stubApi();
    await openFleet();

    const catalogue = await catalogueTable();
    expect(within(catalogue).getByText('A320neo')).toBeInTheDocument();
    expect(within(catalogue).getByText('737-800')).toBeInTheDocument();
  });

  it('shows an arriving type with the date it arrives', async () => {
    stubApi();
    await openFleet();

    // M4-02's second acceptance criterion. The date is what turns a locked row
    // from a wall into a plan.
    expect(await screen.findByText('arrives 2024-11-11')).toBeInTheDocument();
    expect(screen.getByText('A321XLR')).toBeInTheDocument();
  });

  it('renders the server’s sentence rather than deciding for itself', async () => {
    stubApi();
    await openFleet();

    // §21: a browser must not reach a different conclusion about whether an
    // aircraft exists than the world did. Lint already stops the client
    // importing `@tailfin/sim`; this proves it renders what it was told.
    expect(
      await screen.findByText(
        'Flying as a prototype. Enters service on 2024-11-11, and can be ordered from then.',
      ),
    ).toBeInTheDocument();
  });

  it('says the status in words, not only by position', async () => {
    stubApi();
    await openFleet();

    const catalogue = await catalogueTable();
    expect(within(catalogue).getByText('In testing')).toBeInTheDocument();
    expect(within(catalogue).getByText('Used only')).toBeInTheDocument();
  });

  it('shows a dash where a used-only type has no list price', async () => {
    stubApi();
    await openFleet();

    // Not a zero. An aircraft you cannot buy new does not cost nothing.
    const catalogue = await catalogueTable();
    expect(within(catalogue).getAllByText('—').length).toBeGreaterThan(0);
  });

  it('says so plainly when the world is too early for any aircraft', async () => {
    // The 1950s world. A real state, and a very different one from a failure —
    // the criterion is that such a world offers no jets, not that it errors.
    stubApi({
      inGameDate: '1955-06-01T00:00:00.000Z',
      catalogueVersion: 'v1',
      types: [],
      options: [],
    });
    await openFleet();

    expect(await screen.findByText(/No aircraft type has flown yet/i)).toBeInTheDocument();
  });

  it('reports a failed catalogue load as a failure, not as an empty world', async () => {
    stubApi(null);
    await openFleet();

    expect(await screen.findByRole('alert')).toHaveTextContent(
      /Could not load the aircraft catalogue/i,
    );
    expect(screen.queryByText(/No aircraft type has flown yet/i)).toBeNull();
  });

  it('still shows the fleet when the catalogue fails', async () => {
    stubApi(null);
    await openFleet();

    // Two independent loads. A player whose aeroplane is grounded needs to know
    // that whether or not the catalogue answered.
    expect(await screen.findByText('PH-TFB')).toBeInTheDocument();
  });

  it('shows a restriction with what it costs and when it started', async () => {
    stubApi({
      ...CATALOGUE,
      types: [
        entry({
          designation: '737-800',
          availability: 'used_only',
          detail: 'Out of production. Available on the used market and by lease only.',
          restrictions: [
            {
              kind: 'noise_quota',
              since: '2030-01-01',
              amountMinor: 180_000,
              note: 'Excluded from night noise quotas at EU hubs.',
            },
          ],
          restrictionCostPerDepartureMinor: 180_000,
        }),
      ],
    });
    await openFleet();

    // §7.2b's squeeze made legible: the aircraft still flies, and the player
    // can see exactly what it is now costing them and since when.
    expect(
      await screen.findByText(/Excluded from night noise quotas at EU hubs/),
    ).toBeInTheDocument();
    expect(screen.getByText(/since 2030-01-01/)).toBeInTheDocument();
  });
});

describe('the fleet a player owns', () => {
  it('puts the aeroplane that cannot fly first', async () => {
    stubApi();
    await openFleet();

    const table = await fleetTable();
    // The server sorts; this asserts the client does not reorder it. The grounded
    // ATR is first in the response and has to be first on screen.
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows[0]?.textContent).toContain('PH-TFB');
    expect(rows[1]?.textContent).toContain('PH-TFA');
  });

  it('says once, at the top, that something cannot fly', async () => {
    stubApi();
    await openFleet();

    // A grounded aeroplane is the most expensive thing on the page. Leaving it
    // to be noticed row by row is how a player loses a week of revenue.
    expect(await screen.findByRole('status')).toHaveTextContent(/One aircraft cannot fly/i);
    expect(screen.getByRole('status')).toHaveTextContent(/can still be booked into the check/i);
  });

  it('quotes the next check by the limit that actually binds', async () => {
    stubApi();
    await openFleet();

    const table = await fleetTable();
    // Cycles bind on the A320neo in the fixture, so the row says cycles — not
    // hours, and not both. M4-06: "210 cycles from an A-check" is a plan.
    expect(within(table).getByText('A-check in 95 cycles')).toBeInTheDocument();
    expect(within(table).getByText('C-check due')).toBeInTheDocument();
  });

  it('shows utilisation as a rate, with the working behind it', async () => {
    stubApi();
    await openFleet();

    const table = await fleetTable();
    const cell = within(table).getByText('6.2 h/day');
    // §2488's onboarding warning fires off this number, so it has to be
    // traceable to the flights that produced it rather than asserted.
    expect(cell).toHaveAttribute('title', '43.4 block hours over 7.0 game days.');
  });

  it('says an empty fleet is empty, not broken', async () => {
    stubApi(CATALOGUE, { airframes: [] });
    await openFleet();

    expect(await screen.findByText(/No aircraft yet/i)).toBeInTheDocument();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('reports a failed fleet load as a failure', async () => {
    stubApi(CATALOGUE, null);
    await openFleet();

    expect(await screen.findByRole('alert')).toHaveTextContent(/Could not load your fleet/i);
  });
});

describe('the livery cell', () => {
  it('renders no image at all while there is no server-rendered livery', async () => {
    stubApi();
    await openFleet();

    const table = await fleetTable();
    // The second acceptance criterion, held as a property rather than met: the
    // client has no livery document, no template and no renderer, so it must not
    // put a picture of an aeroplane on screen. A client-composed approximation
    // would guarantee the fleet table and the world map disagreed.
    expect(within(table).queryByRole('img')).toBeNull();
    expect(within(table).getAllByTitle(/No livery yet/i).length).toBe(2);
  });

  it('renders the server’s image the moment there is one', async () => {
    const withLivery: FleetAirframesResponse = {
      airframes: [{ ...FLYING, liveryThumbnailUrl: '/sprites/abc123/side/1x.png' }],
    };
    stubApi(CATALOGUE, withLivery);
    await openFleet();

    // M6-06 fills the field; this file does not change. The URL is rendered
    // verbatim, never rebuilt from parts, so a content-addressed sprite path
    // stays cacheable forever.
    const image = await screen.findByRole('img', { name: /PH-TFA livery/i });
    expect(image).toHaveAttribute('src', '/sprites/abc123/side/1x.png');
  });
});

describe('the aircraft detail', () => {
  async function openDetail(): Promise<void> {
    stubApi();
    await openFleet();
    const table = await fleetTable();
    fireEvent.click(within(table).getByRole('button', { name: /Detail for PH-TFA/i }));
  }

  it('shows the base value beside the effective one', async () => {
    await openDetail();

    // The first half of acceptance criterion 1. An unchanged axis has to read as
    // unchanged, or the changed ones do not stand out.
    expect(await screen.findByText('2100.0 kg/h')).toBeInTheDocument();
    expect(screen.getByText('1986.0 kg/h')).toBeInTheDocument();
  });

  it('attributes the delta to each option, as folded rather than as brochured', async () => {
    await openDetail();

    // The second half, and the point of the whole file. Both options are quoted
    // by C.3 as a percentage of burn; the amounts here are what each actually
    // saved, and they differ because the second applies to a burn the first had
    // already reduced. -42.0 and -72.0, not -2% and -3.5%.
    expect(await screen.findByText('-42.0 kg/h')).toBeInTheDocument();
    expect(screen.getByText('-72.0 kg/h')).toBeInTheDocument();
    expect(screen.getByText('Extra fuel-efficiency package')).toBeInTheDocument();
    expect(screen.getByText('Sharklets')).toBeInTheDocument();
  });

  it('shows the running value so the chain can be followed', async () => {
    await openDetail();

    // Adding the deltas up by hand should not be the only way to check the total.
    expect(await screen.findByText('2058.0 kg/h → 1986.0 kg/h')).toBeInTheDocument();
  });

  it('reports a wingspan change as a step along the scale', async () => {
    await openDetail();

    // C.3 rule 3: a fuel-saving option that strands you at your own gate is a
    // mistake the game should let a player make — visibly.
    expect(await screen.findByText('C → D')).toBeInTheDocument();
    expect(screen.getByText(/gate compatibility changes/i)).toBeInTheDocument();
  });

  it('names the rotation the aeroplane flies, legs in order', async () => {
    await openDetail();

    expect(await screen.findByText(/Every day/)).toBeInTheDocument();
    expect(screen.getByText(/08:00 EHAM → EGLL/)).toBeInTheDocument();
    expect(screen.getByText(/10:20 EGLL → EHAM/)).toBeInTheDocument();
    expect(screen.getByText(/2.5 block hours a day/)).toBeInTheDocument();
  });

  it('says there is no cabin, and why', async () => {
    await openDetail();

    // Not silence. "No cabin fitted" is a real state, and naming the milestone
    // that changes it is the difference between a gap and a bug.
    expect(await screen.findByText(/No cabin fitted/i)).toBeInTheDocument();
  });

  it('says a build date is not recorded rather than inventing one', async () => {
    await openDetail();

    // A leased airframe has no known build date, and the delivery date is not a
    // substitute — using it would make every leased aeroplane eternally new.
    expect(await screen.findByText('not recorded')).toBeInTheDocument();
  });

  it('reports a detail that cannot be loaded rather than showing nothing', async () => {
    stubApi();
    await openFleet();
    const table = await fleetTable();
    fireEvent.click(within(table).getByRole('button', { name: /Detail for PH-TFB/i }));

    // The fixture answers 404 for every id but one, which is what a cross-owner
    // id gets too (ADR-0020) — indistinguishable, by design.
    expect(await screen.findByText(/Could not load that aircraft/i)).toBeInTheDocument();
  });
});
