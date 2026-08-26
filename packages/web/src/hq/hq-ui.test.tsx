import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { HeadquartersPage } from './HeadquartersPage';
import { candidatesForRole, HQ_CANDIDATES, HQ_ROLES } from './hq-roster';

/**
 * Headquarters — the office hires (M5-04, §9.1).
 *
 * The page is a scaffold, so these are the invariants that keep it honest: every
 * candidate has a portrait, every role's effect is a concrete unlock, the Safety
 * & Compliance gate is present and marked, and the two rules the brief asked for
 * — greyed when unhired, colour when hired; a seat holds one person — actually
 * hold.
 */

describe('the office roster', () => {
  it('has the six MVP seats from the issue, in §9.1 order', () => {
    expect(HQ_ROLES.map((role) => role.id)).toEqual([
      'route-planner',
      'revenue-manager',
      'ops-controller',
      'chief-pilot',
      'ground-ops',
      'safety-compliance',
    ]);
  });

  it('carries a market of candidates, three of them for the Route Planner', () => {
    expect(candidatesForRole('route-planner').map((c) => c.name)).toEqual([
      'Mara Ellison',
      'Tom Bakker',
      'Victor Lindqvist',
    ]);
    // Every candidate names a real seat and carries a portrait.
    const roleIds = new Set(HQ_ROLES.map((role) => role.id));
    for (const candidate of HQ_CANDIDATES) {
      expect(roleIds.has(candidate.roleId), candidate.id).toBe(true);
      expect(candidate.portrait, candidate.id).toBeTruthy();
    }
    // Ids are unique.
    const ids = HQ_CANDIDATES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("makes each seat's effect a concrete unlock, not a percentage — M5-04's rule", () => {
    for (const role of HQ_ROLES) {
      expect(role.unlock.length, role.id).toBeGreaterThan(0);
      expect(role.unlock, role.id).not.toMatch(/\d+\s?%/);
    }
  });

  it('gates long-haul only behind Safety & Compliance', () => {
    const gated = HQ_ROLES.filter((role) => role.gates !== undefined);
    expect(gated.map((role) => role.id)).toEqual(['safety-compliance']);
    expect(gated[0]?.gates?.toLowerCase()).toContain('long-haul');
  });
});

describe('the Headquarters page', () => {
  it('shows every seat and every candidate', () => {
    render(<HeadquartersPage />);
    expect(screen.getByRole('heading', { level: 1, name: 'Headquarters' })).toBeInTheDocument();
    for (const role of HQ_ROLES) {
      expect(screen.getByRole('heading', { level: 2, name: role.role })).toBeInTheDocument();
    }
    for (const candidate of HQ_CANDIDATES) {
      expect(screen.getByText(candidate.name)).toBeInTheDocument();
    }
    expect(screen.getByRole('status')).toHaveTextContent(`0 of ${String(HQ_ROLES.length)} seats`);
  });

  it('starts every candidate greyed, and colours the one hired', () => {
    render(<HeadquartersPage />);
    const mara = HQ_CANDIDATES.find((c) => c.id === 'route-planner-mara')!;
    const card = screen.getByText(mara.name).closest<HTMLElement>('.hq-card');
    if (!card) throw new Error('no card for Mara');
    const portrait = card.querySelector<HTMLElement>('.hq-card__portrait');
    if (!portrait) throw new Error('no portrait');

    expect(portrait.dataset.hired).toBe('false');
    fireEvent.click(within(card).getByRole('button', { name: /Hire Mara/i }));
    expect(portrait.dataset.hired).toBe('true');
    expect(screen.getByRole('status')).toHaveTextContent('1 of');
    // The seat now names its hire.
    const seat = screen.getByRole('region', { name: 'Route Planner' });
    expect(within(seat).getByText(/Seat filled by Mara Ellison/i)).toBeInTheDocument();
  });

  it('holds one person per seat — hiring a rival swaps, it does not stack', () => {
    render(<HeadquartersPage />);
    const seat = screen.getByRole('region', { name: 'Route Planner' });

    fireEvent.click(within(seat).getByRole('button', { name: /Hire Mara/i }));
    fireEvent.click(within(seat).getByRole('button', { name: /Hire Tom/i }));

    // Still one seat filled across the whole office, and it is Tom now.
    expect(screen.getByRole('status')).toHaveTextContent('1 of');
    expect(within(seat).getByText(/Seat filled by Tom Bakker/i)).toBeInTheDocument();

    const maraCard = within(seat).getByText('Mara Ellison').closest<HTMLElement>('.hq-card');
    const tomCard = within(seat).getByText('Tom Bakker').closest<HTMLElement>('.hq-card');
    expect(maraCard?.dataset.hired).toBe('false');
    expect(tomCard?.dataset.hired).toBe('true');
  });

  it('flags the seat that gates long-haul authority', () => {
    render(<HeadquartersPage />);
    const seat = screen.getByRole('region', { name: 'Safety & Compliance' });
    expect(within(seat).getByText('Gate')).toBeInTheDocument();
    // Scoped to the gate paragraph, not any of the several mentions of "long-haul".
    const gate = seat.querySelector('.hq-card__gate');
    expect(gate?.textContent?.toLowerCase()).toContain('long-haul');
  });
});
