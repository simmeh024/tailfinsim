import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  OwnAirlineResponse,
  defaultAirlineLogo,
  ownAirlineResponseJsonSchema,
} from '@tailfin/shared';

import { wireAirline } from './wire';

import type { AirlineRow } from '../db/schema';

// Synthetic future-version data, never an export of a player's artwork.
const unsupported = { v: 99, shape: 'roundel', layers: [], palette: ['#123456'] };

function rowWithLogo(logo: unknown): AirlineRow {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    worldId: '00000000-0000-4000-8000-000000000002',
    playerId: '00000000-0000-4000-8000-000000000003',
    kind: 'player',
    archetype: null,
    name: 'Example Air',
    iataCode: 'EA',
    icaoCode: 'EXA',
    callsign: 'EXAMPLE',
    baseCountry: 'NL',
    // Emulate PostgreSQL jsonb, whose static annotation does not validate reads.
    logo: logo as AirlineRow['logo'],
    cashMinor: 50_000_000,
    reputation: '0.35',
    status: 'active',
    statusChangedAt: new Date('2026-08-28T00:00:00Z'),
    ceasedAt: null,
    createdAt: new Date('2026-08-28T00:00:00Z'),
  };
}

describe('airline logo read compatibility', () => {
  const app = Fastify();
  let currentRow = rowWithLogo(null);
  beforeAll(async () => {
    app.get('/projection', { schema: { response: { 200: ownAirlineResponseJsonSchema } } }, () => ({
      airline: wireAirline(currentRow),
      rebrand: null,
    }));
    // Compile the real serializer once; cold Windows startup can exceed 5s.
    await app.ready();
  }, 30_000);
  afterAll(async () => {
    await app.close();
  });
  it.each([unsupported, { shape: 'roundel' }, '<svg onload="alert(1)">', 17, null])(
    'serializes an unsupported or absent logo as fallback without changing the source: %j',
    async (logo) => {
      const row = rowWithLogo(logo);
      const before = structuredClone(row);
      currentRow = row;
      const response = await app.inject('/projection');
      expect(response.statusCode).toBe(200);
      expect(OwnAirlineResponse.safeParse(response.json()).success).toBe(true);
      expect(response.json()).toMatchObject({ airline: { id: row.id, logo: null } });
      expect(row).toEqual(before);
    },
  );
  it('preserves every supported logo field and returns a detached parsed value', () => {
    const logo = defaultAirlineLogo('EA');
    const row = rowWithLogo(logo);
    expect(wireAirline(row).logo).toEqual(logo);
    expect(wireAirline(row).logo).not.toBe(logo);
  });
});
