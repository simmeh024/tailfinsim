import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Constraint tests, run against a real Postgres.
 *
 * These exist because the substance of M0-06 *is* the constraints. A schema
 * file that compiles proves nothing; the only way to know `reputation` is
 * bounded at the database level is to try to store 1.5 and be refused.
 *
 * Requires `DATABASE_URL` and an already-migrated database. CI provides both
 * (a Postgres service plus `pnpm db:migrate`). Locally, run
 * `docker compose up -d && pnpm db:migrate` first; without a database the suite
 * skips loudly rather than passing vacuously.
 */

const url = process.env.DATABASE_URL;

if (!url) {
  console.warn(
    '\n  [schema.test] DATABASE_URL not set — skipping constraint tests.\n' +
      '  Run: docker compose up -d && pnpm db:migrate\n',
  );
}

const describeDb = url ? describe : describe.skip;

describeDb('database constraints', () => {
  let client: pg.Client;

  beforeAll(async () => {
    client = new pg.Client({ connectionString: url });
    await client.connect();
  });

  afterAll(async () => {
    await client.end();
  });

  /**
   * Every case runs inside a transaction that is always rolled back, so tests
   * neither see each other's rows nor need cleanup.
   */
  async function inTx(body: () => Promise<void>): Promise<void> {
    await client.query('BEGIN');
    try {
      await body();
    } finally {
      await client.query('ROLLBACK');
    }
  }

  async function makeWorld(name = `w-${Math.random().toString(36).slice(2, 10)}`): Promise<string> {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO world (name, epoch, launch_date, speed_multiplier,
                          aircraft_catalogue_version, economy_config_version)
       VALUES ($1, '2024-10-20T00:00:00Z', now(), 2, 'v1', 'v1') RETURNING id`,
      [name],
    );
    return rows[0]!.id;
  }

  async function makePlayer(): Promise<string> {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO player (display_name) VALUES ('Test Player') RETURNING id`,
    );
    return rows[0]!.id;
  }

  async function insertAirline(
    worldId: string,
    playerId: string,
    overrides: Partial<{
      name: string;
      iata: string;
      icao: string;
      callsign: string;
      country: string;
      reputation: string;
    }> = {},
  ) {
    const {
      name = 'Test Air',
      iata = 'TF',
      icao = 'TFN',
      callsign = 'TESTAIR',
      country = 'NL',
      reputation = '0.35',
    } = overrides;
    return client.query(
      `INSERT INTO airline (world_id, player_id, name, iata_code, icao_code, callsign,
                            base_country, reputation)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [worldId, playerId, name, iata, icao, callsign, country, reputation],
    );
  }

  describe('reputation is bounded 0..1 at the database level', () => {
    it('accepts values inside the range', async () => {
      await inTx(async () => {
        const w = await makeWorld();
        const values = ['0.00', '0.35', '0.50', '1.00'];
        for (const [i, r] of values.entries()) {
          const p = await makePlayer();
          // Codes must satisfy their own format checks, so derive letters
          // rather than digits — an earlier version of this test built ICAO
          // codes out of the reputation digits and was correctly refused.
          const letter = String.fromCharCode(65 + i);
          await expect(
            insertAirline(w, p, { reputation: r, iata: `A${letter}`, icao: `AA${letter}` }),
          ).resolves.toBeDefined();
        }
      });
    });

    it('refuses above 1', async () => {
      await inTx(async () => {
        const w = await makeWorld();
        const p = await makePlayer();
        await expect(insertAirline(w, p, { reputation: '1.01' })).rejects.toThrow(
          /airline_reputation_range/,
        );
      });
    });

    it('refuses below 0', async () => {
      await inTx(async () => {
        const w = await makeWorld();
        const p = await makePlayer();
        await expect(insertAirline(w, p, { reputation: '-0.01' })).rejects.toThrow(
          /airline_reputation_range/,
        );
      });
    });

    it('defaults to the 0.35 the design doc specifies', async () => {
      await inTx(async () => {
        const w = await makeWorld();
        const p = await makePlayer();
        await client.query(
          `INSERT INTO airline (world_id, player_id, name, iata_code, icao_code, callsign, base_country)
           VALUES ($1, $2, 'Test Air', 'TF', 'TFN', 'TESTAIR', 'NL')`,
          [w, p],
        );
        const { rows } = await client.query<{ reputation: string }>(
          `SELECT reputation FROM airline WHERE world_id = $1`,
          [w],
        );
        expect(rows[0]!.reputation).toBe('0.35');
      });
    });
  });

  describe('code scarcity is enforced per world, not globally', () => {
    it('refuses a duplicate IATA code within one world', async () => {
      await inTx(async () => {
        const w = await makeWorld();
        await insertAirline(w, await makePlayer(), { iata: 'TF', icao: 'AAA' });
        await expect(
          insertAirline(w, await makePlayer(), { iata: 'TF', icao: 'BBB' }),
        ).rejects.toThrow(/airline_world_id_iata_code_key/);
      });
    });

    it('allows the same IATA code in a different world', async () => {
      await inTx(async () => {
        const a = await makeWorld();
        const b = await makeWorld();
        await insertAirline(a, await makePlayer(), { iata: 'TF', icao: 'AAA' });
        await expect(
          insertAirline(b, await makePlayer(), { iata: 'TF', icao: 'AAA' }),
        ).resolves.toBeDefined();
      });
    });

    it('refuses a duplicate ICAO code within one world', async () => {
      await inTx(async () => {
        const w = await makeWorld();
        await insertAirline(w, await makePlayer(), { iata: 'AA', icao: 'TFN' });
        await expect(
          insertAirline(w, await makePlayer(), { iata: 'BB', icao: 'TFN' }),
        ).rejects.toThrow(/airline_world_id_icao_code_key/);
      });
    });
  });

  describe('one airline per player per world', () => {
    it('refuses a second airline for the same player in the same world', async () => {
      await inTx(async () => {
        const w = await makeWorld();
        const p = await makePlayer();
        await insertAirline(w, p, { iata: 'AA', icao: 'AAA' });
        await expect(insertAirline(w, p, { iata: 'BB', icao: 'BBB' })).rejects.toThrow(
          /airline_world_id_player_id_key/,
        );
      });
    });

    it('allows the same player an airline in each of two worlds', async () => {
      await inTx(async () => {
        const p = await makePlayer();
        await insertAirline(await makeWorld(), p);
        await expect(insertAirline(await makeWorld(), p)).resolves.toBeDefined();
      });
    });
  });

  describe('code and country formats', () => {
    it.each([
      ['lowercase IATA', { iata: 'tf' }, /airline_iata_code_format/],
      ['one-character IATA', { iata: 'T' }, /airline_iata_code_format/],
      ['numeric ICAO', { icao: 'TF1' }, /airline_icao_code_format/],
      ['two-character ICAO', { icao: 'TF' }, /airline_icao_code_format/],
      ['three-letter country', { country: 'NLD' }, /airline_base_country_format/],
    ])('refuses %s', async (_label, overrides, pattern) => {
      await inTx(async () => {
        const w = await makeWorld();
        const p = await makePlayer();
        await expect(insertAirline(w, p, overrides)).rejects.toThrow(pattern);
      });
    });
  });

  describe('public identity guardrails', () => {
    it('accepts a Unicode display name with an operational ASCII callsign', async () => {
      await inTx(async () => {
        await expect(
          insertAirline(await makeWorld(), await makePlayer(), {
            name: '航空会社 Horizon',
            callsign: 'HORIZON 1',
          }),
        ).resolves.toBeDefined();
      });
    });

    it.each([
      ['an empty name', { name: '' }, /airline_name_length/],
      ['a leading name space', { name: ' Tailfin' }, /airline_name_structure/],
      ['a doubled name space', { name: 'Tailfin  Air' }, /airline_name_structure/],
      ['a newline in the name', { name: 'Tailfin\nAir' }, /airline_name_structure/],
      ['a lowercase callsign', { callsign: 'Tailfin' }, /airline_callsign_format/],
      ['a doubled callsign space', { callsign: 'TAILFIN  AIR' }, /airline_callsign_format/],
      ['a numeric-only callsign', { callsign: '1234' }, /airline_callsign_format/],
    ])('refuses %s', async (_label, overrides, pattern) => {
      await inTx(async () => {
        await expect(
          insertAirline(await makeWorld(), await makePlayer(), overrides),
        ).rejects.toThrow(pattern);
      });
    });
  });

  describe('referential behaviour matches the GDPR requirement', () => {
    it('refuses to delete a player who still holds an airline', async () => {
      // §22.10: deletion must anonymise the player and keep the airline's
      // operational record. Restricting the delete forces that path.
      await inTx(async () => {
        const w = await makeWorld();
        const p = await makePlayer();
        await insertAirline(w, p);
        await expect(client.query(`DELETE FROM player WHERE id = $1`, [p])).rejects.toThrow(
          /airline_player_id_player_id_fk/,
        );
      });
    });

    it('takes airlines with the world when a world is deleted', async () => {
      await inTx(async () => {
        const w = await makeWorld();
        await insertAirline(w, await makePlayer());
        await client.query(`DELETE FROM world WHERE id = $1`, [w]);
        const { rows } = await client.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM airline WHERE world_id = $1`,
          [w],
        );
        expect(rows[0]!.n).toBe('0');
      });
    });
  });

  describe('world configuration', () => {
    it('refuses a non-positive speed multiplier', async () => {
      await inTx(async () => {
        await expect(
          client.query(
            `INSERT INTO world (name, epoch, launch_date, speed_multiplier,
                                aircraft_catalogue_version, economy_config_version)
             VALUES ('zero-speed', '2024-10-20T00:00:00Z', now(), 0, 'v1', 'v1')`,
          ),
        ).rejects.toThrow(/world_speed_multiplier_positive/);
      });
    });

    it('treats a null player cap as uncapped but refuses zero', async () => {
      await inTx(async () => {
        await expect(
          client.query(
            `INSERT INTO world (name, epoch, launch_date, speed_multiplier,
                                aircraft_catalogue_version, economy_config_version, player_cap)
             VALUES ('uncapped', '2024-10-20T00:00:00Z', now(), 2, 'v1', 'v1', NULL)`,
          ),
        ).resolves.toBeDefined();
        await expect(
          client.query(
            `INSERT INTO world (name, epoch, launch_date, speed_multiplier,
                                aircraft_catalogue_version, economy_config_version, player_cap)
             VALUES ('zero-cap', '2024-10-20T00:00:00Z', now(), 2, 'v1', 'v1', 0)`,
          ),
        ).rejects.toThrow(/world_player_cap_positive/);
      });
    });
  });

  describe('identities are keyed on provider subject', () => {
    it('refuses the same provider subject twice', async () => {
      await inTx(async () => {
        const a = await makePlayer();
        const b = await makePlayer();
        await client.query(
          `INSERT INTO player_identity (player_id, provider, subject) VALUES ($1, 'google', 'sub-123')`,
          [a],
        );
        await expect(
          client.query(
            `INSERT INTO player_identity (player_id, provider, subject) VALUES ($1, 'google', 'sub-123')`,
            [b],
          ),
        ).rejects.toThrow(/player_identity_provider_subject_key/);
      });
    });

    it('allows one player several identities', async () => {
      await inTx(async () => {
        const p = await makePlayer();
        await client.query(
          `INSERT INTO player_identity (player_id, provider, subject) VALUES ($1, 'google', 'sub-a')`,
          [p],
        );
        await expect(
          client.query(
            `INSERT INTO player_identity (player_id, provider, subject) VALUES ($1, 'google', 'sub-b')`,
            [p],
          ),
        ).resolves.toBeDefined();
      });
    });
  });

  describe('indexes required by M0-06', () => {
    it('indexes world_id on every child table', async () => {
      const { rows } = await client.query<{ tablename: string; indexdef: string }>(
        `SELECT tablename, indexdef FROM pg_indexes
         WHERE schemaname = 'public' AND indexdef LIKE '%world_id%'`,
      );
      expect(rows.some((r) => r.tablename === 'airline')).toBe(true);
    });
  });
});
