import { describe, expect, it } from 'vitest';

import { busiestAirport } from './busiest-airport';

describe('busiestAirport', () => {
  it('is the hub of a hub-and-spoke network, not the alphabetically first airport', () => {
    expect(
      busiestAirport([
        { originIcao: 'EHAM', destinationIcao: 'EDDF' },
        { originIcao: 'EHAM', destinationIcao: 'EGLL' },
        { originIcao: 'LFPG', destinationIcao: 'EHAM' },
      ]),
    ).toBe('EHAM');
  });

  it('breaks a tie alphabetically, so the choice is stable', () => {
    expect(busiestAirport([{ originIcao: 'EHAM', destinationIcao: 'EDDF' }])).toBe('EDDF');
  });

  it('is null for an airline that flies nowhere', () => {
    expect(busiestAirport([])).toBeNull();
  });
});
