import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { CrewMemberView, CrewRosterResponse, TrainingCaptainRefusal } from '@tailfin/shared';

import { convertRefusalText, CrewRoster } from './CrewRoster';

import type { CrewFailure } from './api';

/**
 * The roster board's Training Captain controls (M9-04, §10.2).
 *
 * The rules are the server's; what the page owes the player is three things,
 * each with a test here: the action is offered exactly when the server says it
 * is open, a closed action says *why* in words that point at the fix, and a
 * decision with a price takes two clicks — the first stating what this step and
 * its undoing cost.
 */

const BASE_ID = '00000000-0000-4000-8000-0000000000b1';

function member(
  id: string,
  name: string,
  over: Partial<CrewMemberView> = {},
  trainingCaptain: Partial<CrewMemberView['trainingCaptain']> = {},
): CrewMemberView {
  return {
    id,
    name,
    rank: 'captain',
    family: 'A320neo',
    crewBaseId: BASE_ID,
    airportIcao: 'EHAM',
    level: 20,
    xp: 2_400_000,
    xpToNextLevel: null,
    spent: {},
    unspentPoints: 19,
    career: { blockHours: 812.5, sectors: 410, typesFlown: ['A320neo'], incidentsHandled: 3 },
    namedAt: '2026-03-01T00:00:00.000Z',
    typeMasteryActive: true,
    ...over,
    trainingCaptain: {
      since: null,
      convertRefusal: null,
      conversionCostMinor: 2_000_000,
      reversionCostMinor: 3_000_000,
      ...trainingCaptain,
    },
  };
}

const ELIGIBLE = '00000000-0000-4000-8000-000000000001';
const TRAINER = '00000000-0000-4000-8000-000000000002';
const JUNIOR = '00000000-0000-4000-8000-000000000003';
const PURSER = '00000000-0000-4000-8000-000000000004';

function roster(members: CrewMemberView[]): CrewRosterResponse {
  return {
    members,
    branches: [],
    boosts: [],
    operatedFamilies: ['A320neo'],
    namedFromLevel: 8,
    maxLevel: 20,
    trainingCoverage: [
      {
        crewBaseId: BASE_ID,
        airportIcao: 'EHAM',
        family: 'A320neo',
        trainingCaptains: 1,
        flightDeckHeads: 10,
        coverage: 1,
        multiplier: 1.5,
        capped: false,
      },
    ],
  };
}

const ALL = roster([
  member(ELIGIBLE, 'Anna Visser'),
  member(
    TRAINER,
    'Bram de Wit',
    {},
    { since: '2026-04-02T09:00:00.000Z', convertRefusal: 'already_training_captain' },
  ),
  member(JUNIOR, 'Carla Jansen', { level: 12 }, { convertRefusal: 'below_max_level' }),
  member(PURSER, 'Daan Smit', { rank: 'purser' }, { convertRefusal: 'not_flight_deck' }),
]);

function renderBoard(
  value: CrewRosterResponse = ALL,
  refusal: CrewFailure | null = null,
): { onTrainingCaptain: ReturnType<typeof vi.fn> } {
  const onTrainingCaptain = vi.fn();
  render(
    <CrewRoster
      roster={value}
      loading={false}
      failed={false}
      onSpend={vi.fn()}
      onTrainingCaptain={onTrainingCaptain}
      refusal={refusal}
      pendingMemberId={null}
    />,
  );
  return { onTrainingCaptain };
}

function select(name: string): HTMLElement {
  fireEvent.click(screen.getByRole('button', { name }));
  return screen.getByLabelText('Training Captain');
}

describe('the Training Captain on the roster board', () => {
  it('marks a Training Captain in the roster', () => {
    renderBoard();
    const row = screen.getByRole('button', { name: 'Bram de Wit' }).closest('tr');
    expect(within(row!).getByText('Training Captain')).toBeInTheDocument();
    const other = screen.getByRole('button', { name: 'Anna Visser' }).closest('tr');
    expect(within(other!).queryByText('Training Captain')).toBeNull();
  });

  it('offers the conversion with its price, and spends it only on the second click', () => {
    const { onTrainingCaptain } = renderBoard();
    const panel = select('Anna Visser');

    fireEvent.click(
      within(panel).getByRole('button', { name: /Make Training Captain · .*20,000/ }),
    );
    // The first click states both prices and spends nothing.
    expect(onTrainingCaptain).not.toHaveBeenCalled();
    expect(panel.textContent).toMatch(/20,000/);
    expect(panel.textContent).toMatch(/Returning them to the line later costs .*30,000/);

    fireEvent.click(within(panel).getByRole('button', { name: 'Confirm — make Training Captain' }));
    expect(onTrainingCaptain).toHaveBeenCalledWith(ELIGIBLE, true);
  });

  it('lets the player step back from the confirmation', () => {
    const { onTrainingCaptain } = renderBoard();
    const panel = select('Anna Visser');
    fireEvent.click(within(panel).getByRole('button', { name: /Make Training Captain/ }));
    fireEvent.click(within(panel).getByRole('button', { name: 'Keep' }));
    expect(
      within(panel).getByRole('button', { name: /Make Training Captain/ }),
    ).toBeInTheDocument();
    expect(onTrainingCaptain).not.toHaveBeenCalled();
  });

  it('returns a Training Captain to the line at the reversion price, confirmed', () => {
    const { onTrainingCaptain } = renderBoard();
    const panel = select('Bram de Wit');
    expect(panel.textContent).toMatch(/since 2026-04-02/);

    fireEvent.click(within(panel).getByRole('button', { name: /Return to the line · .*30,000/ }));
    expect(panel.textContent).toMatch(/not refunded/);
    fireEvent.click(within(panel).getByRole('button', { name: 'Confirm — return to the line' }));
    expect(onTrainingCaptain).toHaveBeenCalledWith(TRAINER, false);
  });

  it('says why the conversion is closed rather than offering a dead button', () => {
    renderBoard();
    const panel = select('Carla Jansen');
    expect(panel.textContent).toMatch(/Reaches level 20 first/);
    expect(within(panel).queryByRole('button')).toBeNull();
  });

  it('says nothing about it on a cabin crew member’s card', () => {
    renderBoard();
    fireEvent.click(screen.getByRole('button', { name: 'Daan Smit' }));
    expect(screen.queryByLabelText('Training Captain')).toBeNull();
  });

  it('shows a refusal the server returned, beside the control', () => {
    renderBoard(ALL, {
      status: 409,
      code: 'insufficient_funds',
      message: 'The airline cannot pay for this',
    });
    expect(screen.getByLabelText('Training Captain').textContent).toMatch(/cannot pay/);
  });

  it('shows the XP multiplier per base and type, and when it has stopped growing', () => {
    renderBoard();
    const table = screen.getByRole('table', { name: 'Training Captains and pilot XP' });
    expect(table.textContent).toMatch(/×1\.50/);
    expect(table.textContent).toMatch(/fully covered/);
    expect(table.textContent).toMatch(/100%/);
  });

  it('leaves the coverage table out when the airline has no pilots to cover', () => {
    renderBoard({ ...ALL, trainingCoverage: [] });
    expect(screen.queryByRole('table', { name: 'Training Captains and pilot XP' })).toBeNull();
  });
});

describe('the refusal wording', () => {
  it.each([
    ['no_academy', /Centre of Excellence \(academy level 5\)/],
    ['academy_level', /has not reached it/],
    ['not_command_rank', /Only a Captain/],
    ['below_max_level', /level 20 first/],
  ] as const)('explains %s in words that point at the fix', (refusal, pattern) => {
    expect(convertRefusalText(refusal, 20)).toMatch(pattern);
  });

  it.each(['not_flight_deck', 'already_training_captain'] as TrainingCaptainRefusal[])(
    'says nothing for %s, where saying anything would be noise',
    (refusal) => {
      expect(convertRefusalText(refusal, 20)).toBeNull();
    },
  );
});
