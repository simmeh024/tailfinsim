import { describe, expect, it } from 'vitest';

import { moderateAirlineIdentity } from './moderation';

describe('airline identity moderation boundary', () => {
  it('is explicitly permissive until a policy is supplied', async () => {
    await expect(
      moderateAirlineIdentity({ name: '航空会社 Horizon', callsign: 'HORIZON' }),
    ).resolves.toEqual({ accepted: true });
  });

  it('preserves the policy field and human reason', async () => {
    await expect(
      moderateAirlineIdentity(
        { name: 'Structurally Valid Air', callsign: 'RESERVED' },
        {
          identityModerator: {
            review: () =>
              Promise.resolve({
                accepted: false,
                field: 'callsign',
                reason: 'That callsign is reserved by policy.',
              }),
          },
        },
      ),
    ).resolves.toEqual({
      accepted: false,
      field: 'callsign',
      reason: 'That callsign is reserved by policy.',
    });
  });
});
