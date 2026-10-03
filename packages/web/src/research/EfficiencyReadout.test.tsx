import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { EFFICIENCY_QUANTITIES, EfficiencyQuantityReadout } from '@tailfin/shared';

import { EfficiencyReadout } from './EfficiencyReadout';

/** All six quantities at nothing, with the shipped ceilings. Parsed, so drift fails loudly. */
function quantities(
  overrides: Partial<Record<string, Partial<EfficiencyQuantityReadout>>> = {},
): EfficiencyQuantityReadout[] {
  const ceilings: Record<string, number> = {
    fuelBurn: 0.08,
    turnaroundTime: 0.2,
    blockTime: 0.04,
    maintenanceCost: 0.12,
    incidentRate: 0.3,
    serviceCost: 0.15,
  };
  return EFFICIENCY_QUANTITIES.map((quantity) =>
    EfficiencyQuantityReadout.parse({
      quantity,
      ceiling: ceilings[quantity],
      uncapped: 0,
      fraction: 0,
      capped: false,
      bySource: { skills: 0, trainingCaptains: 0, doctrine: 0 },
      ...overrides[quantity],
    }),
  );
}

describe('EfficiencyReadout', () => {
  it('draws all six of §10.4’s quantities', () => {
    render(<EfficiencyReadout quantities={quantities()} />);
    expect(screen.getAllByRole('meter')).toHaveLength(6);
    for (const label of ['Fuel burn', 'Turnaround time', 'Block time', 'Service cost']) {
      expect(screen.getByText(label)).toBeTruthy();
    }
    expect(screen.getByText('Nothing reduces fuel burn yet.')).toBeTruthy();
  });

  it('names each source in words, not only in colour', () => {
    render(
      <EfficiencyReadout
        quantities={quantities({
          maintenanceCost: {
            uncapped: 1 - 0.95 * 0.97,
            fraction: 1 - 0.95 * 0.97,
            bySource: { skills: 0.05, trainingCaptains: 0, doctrine: 0.03 },
          },
        })}
      />,
    );
    const sources = screen.getByRole('list', { name: 'Maintenance cost by source' });
    expect(within(sources).getByText(/Crew skills/).textContent).toContain('−5.0%');
    expect(within(sources).getByText(/Doctrine/).textContent).toContain('−3.0%');
    expect(within(sources).queryByText(/Training Captains/)).toBeNull();
  });

  it('says when a ceiling has been reached, rather than drawing a full bar silently', () => {
    render(
      <EfficiencyReadout
        quantities={quantities({
          fuelBurn: {
            uncapped: 0.11,
            fraction: 0.08,
            capped: true,
            bySource: { skills: 0.07, trainingCaptains: 0.01, doctrine: 0.035 },
          },
        })}
      />,
    );
    const meter = screen.getByRole('meter', { name: 'Fuel burn reduction against its ceiling' });
    expect(meter.getAttribute('aria-valuenow')).toBe('8');
    expect(meter.getAttribute('aria-valuemax')).toBe('8');
    expect(screen.getByText(/another boost here buys nothing/)).toBeTruthy();
  });
});
