import type {
  AcademiesResponse,
  AcademyBuildQuote,
  AcademyModuleOffer,
  AcademyView,
} from '@tailfin/shared';

/**
 * Academy payloads for the SURFACE-10 tests (a test helper).
 *
 * Named `test-*` like `finance/test-finance.ts`, and imported only by tests.
 *
 * Every figure is **deliberately not the shipped balance** — a Training Room
 * here costs 12,345.67 rather than 20,000 — so a test that finds the figure on
 * the page proves the page printed the server's number rather than one of its
 * own. Shaped exactly as `GET /api/academies` answers.
 */

export const GAME_NOW = new Date('2031-03-01T12:00:00.000Z');

export const EHAM_ID = '11111111-1111-4111-8111-111111111111';
export const EGLL_ID = '22222222-2222-4222-8222-222222222222';
export const EHAM_BASE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
export const EGLL_BASE = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
export const LFPG_BASE = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

export function quote(
  capitalCostMinor: number,
  buildWeeks: number,
  monthlyUpkeepMinor: number,
): AcademyBuildQuote {
  return { capitalCostMinor, buildWeeks, monthlyUpkeepMinor };
}

export function offer(over: Partial<AcademyModuleOffer> & Pick<AcademyModuleOffer, 'kind'>) {
  const base: AcademyModuleOffer = {
    kind: over.kind,
    name: over.kind,
    purpose: 'A room.',
    perFamily: false,
    fromLevel: 1,
    readToday: true,
    quote: quote(100_000, 2, 10_000),
    availableFamilies: [],
    blockedBy: null,
  };
  return { ...base, ...over };
}

/** A level-2 Training Centre at EHAM with one module installed and one building. */
export function trainingCentre(over: Partial<AcademyView> = {}): AcademyView {
  return {
    id: EHAM_ID,
    crewBaseId: EHAM_BASE,
    airportIcao: 'EHAM',
    level: 2,
    levelName: 'Training Centre',
    pendingLevel: null,
    constructionReadyAt: null,
    ceiling: {
      flightDeckUpTo: 'first_officer',
      cabinUpTo: 'senior_cabin_crew',
      researchTier: 1,
      trainingSlots: 11,
      slotsInUse: 3,
    },
    modules: [
      {
        id: 'd0000000-0000-4000-8000-000000000001',
        kind: 'cbt_suite',
        family: null,
        status: 'operational',
        readyAt: '2031-01-20T00:00:00.000Z',
        installedAt: '2031-01-20T06:00:00.000Z',
      },
      {
        id: 'd0000000-0000-4000-8000-000000000002',
        kind: 'cabin_service_mockup',
        family: null,
        status: 'under_construction',
        readyAt: '2031-03-11T12:00:00.000Z',
        installedAt: null,
      },
    ],
    nextLevel: quote(13_579_100, 17, 812_300),
    moduleOffers: [
      offer({
        kind: 'cbt_suite',
        name: 'CBT Suite',
        purpose: 'Computer-based training and induction.',
        quote: quote(612_300, 3, 41_100),
        blockedBy: 'already_built',
      }),
      offer({
        kind: 'cabin_service_mockup',
        name: 'Cabin Service Mock-up',
        purpose: 'Cabin crew service and door training, in-house.',
        quote: quote(2_400_000, 6, 120_000),
        blockedBy: 'under_construction',
      }),
      offer({
        kind: 'emergency_drill',
        name: 'Emergency & Wet Drill',
        purpose: 'Recurrent safety, evacuation and ditching drills.',
        fromLevel: 2,
        readToday: false,
        quote: quote(3_210_900, 9, 181_700),
      }),
      offer({
        kind: 'fixed_base_sim',
        name: 'Fixed-Base Sim',
        purpose: 'Procedures training for the flight deck.',
        fromLevel: 3,
        quote: quote(9_000_000, 12, 450_000),
        blockedBy: 'level',
      }),
      offer({
        kind: 'full_flight_sim',
        name: 'Full-Flight Sim',
        purpose: 'Full-motion simulator for one aircraft family.',
        perFamily: true,
        fromLevel: 4,
        quote: quote(30_000_000, 20, 1_200_000),
        availableFamilies: ['737 MAX', 'A320neo'],
        blockedBy: 'level',
      }),
    ],
    monthlyUpkeepMinor: 391_300,
    ...over,
  };
}

/** Level 0 at EGLL: the money is spent and nothing has arrived. */
export function buildingSite(over: Partial<AcademyView> = {}): AcademyView {
  return {
    id: EGLL_ID,
    crewBaseId: EGLL_BASE,
    airportIcao: 'EGLL',
    level: 0,
    levelName: null,
    pendingLevel: 1,
    constructionReadyAt: '2031-03-29T12:00:00.000Z',
    ceiling: null,
    modules: [],
    nextLevel: null,
    moduleOffers: [
      offer({
        kind: 'cbt_suite',
        name: 'CBT Suite',
        purpose: 'Computer-based training and induction.',
        fromLevel: 1,
        quote: quote(612_300, 3, 41_100),
        blockedBy: 'level',
      }),
    ],
    monthlyUpkeepMinor: 0,
    ...over,
  };
}

export function academies(over: Partial<AcademiesResponse> = {}): AcademiesResponse {
  return {
    academies: [trainingCentre(), buildingSite()],
    sites: [{ crewBaseId: LFPG_BASE, airportIcao: 'LFPG', quote: quote(1_234_567, 5, 151_500) }],
    families: ['737 MAX', 'A320neo', 'ATR 72'],
    outsourcedConversionPerHeadMinor: 219_900,
    ...over,
  };
}
