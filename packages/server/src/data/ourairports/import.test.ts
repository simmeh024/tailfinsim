import { eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase, type DatabaseHandle } from '../../db/client';
import { airport, datasetVersion, runway } from '../../db/schema';

import { checksumOf, type FetchedDataset } from './fetch';
import { importOurAirports, SanityCheckFailure } from './import';
import { type SanityBounds } from './sanity';

/**
 * The import, against a real Postgres.
 *
 * Everything here is a behaviour that cannot be checked by reading the code:
 * that a re-run is a no-op, that a failed sanity check leaves the database
 * untouched, that ids survive an update, and that the batching survives crossing
 * its own batch boundary.
 *
 * Requires `DATABASE_URL` against a migrated database; CI provides both.
 */

const url = process.env.DATABASE_URL;

if (!url) {
  console.warn('\n  [import.test] DATABASE_URL not set — skipping OurAirports import tests.\n');
}

const describeDb = url ? describe : describe.skip;

/** A fixture is a different dataset from the real one, and says so. */
const FIXTURE_BOUNDS: SanityBounds = {
  airportsTotal: [1, 10_000],
  airportsOpen: [1, 10_000],
  scheduledService: [0, 10_000],
  largeAirports: [0, 10_000],
  mediumAirports: [0, 10_000],
  countries: [1, 300],
  withIata: [0, 10_000],
  runways: [0, 50_000],
};

const AIRPORT_HEADER = [
  'id',
  'ident',
  'type',
  'name',
  'latitude_deg',
  'longitude_deg',
  'elevation_ft',
  'continent',
  'iso_country',
  'iso_region',
  'municipality',
  'scheduled_service',
  'icao_code',
  'iata_code',
].join(',');

const RUNWAY_HEADER = [
  'id',
  'airport_ref',
  'airport_ident',
  'length_ft',
  'width_ft',
  'surface',
  'lighted',
  'closed',
  'le_ident',
  'he_ident',
].join(',');

interface FixtureAirport {
  id: number;
  ident: string;
  type?: string;
  name?: string;
  lat?: number;
  lon?: number;
  country?: string;
  scheduled?: boolean;
  iata?: string;
}

interface FixtureRunway {
  id: number;
  ident: string;
  lengthFt?: number | '';
  surface?: string;
}

function buildDataset(airports: FixtureAirport[], runways: FixtureRunway[]): FetchedDataset {
  const airportLines = airports.map((a) =>
    [
      a.id,
      a.ident,
      a.type ?? 'medium_airport',
      `"${a.name ?? `Airport ${a.ident}`}"`,
      a.lat ?? 52.3,
      a.lon ?? 4.76,
      '13',
      'EU',
      a.country ?? 'NL',
      'NL-NH',
      'Testville',
      (a.scheduled ?? false) ? 'yes' : 'no',
      '',
      a.iata ?? '',
    ].join(','),
  );

  const runwayLines = runways.map((r) =>
    [r.id, '0', r.ident, r.lengthFt ?? 8000, '150', r.surface ?? 'ASP', '1', '0', '09', '27'].join(
      ',',
    ),
  );

  const files = {
    airports: `${AIRPORT_HEADER}\n${airportLines.join('\n')}\n`,
    runways: `${RUNWAY_HEADER}\n${runwayLines.join('\n')}\n`,
    countries: 'id,code,name,continent\n1,NL,Netherlands,EU\n',
  };

  return { files, checksum: checksumOf(files), version: 'fixture' };
}

/** Idents are namespaced so the fixture cannot collide with a real import. */
const P = 'ZZT';

describeDb('OurAirports import', () => {
  let db: DatabaseHandle;

  beforeAll(() => {
    db = createDatabase();
  });

  afterAll(async () => {
    await db.close();
  });

  afterEach(async () => {
    // Runways cascade with their airport.
    await db.db.delete(airport).where(sql`${airport.ident} LIKE ${`${P}%`}`);
    await db.db.delete(datasetVersion).where(eq(datasetVersion.version, 'fixture'));
  });

  const silent = { sanityBounds: FIXTURE_BOUNDS, log: () => undefined };

  async function countAirports(): Promise<number> {
    const rows = await db.db
      .select({ n: sql<number>`count(*)::int` })
      .from(airport)
      .where(sql`${airport.ident} LIKE ${`${P}%`}`);
    return rows[0]?.n ?? 0;
  }

  it('imports airports and runways', async () => {
    const dataset = buildDataset(
      [
        { id: 900001, ident: `${P}AA`, scheduled: true, iata: 'ZQA' },
        { id: 900002, ident: `${P}BB` },
      ],
      [
        { id: 910001, ident: `${P}AA`, lengthFt: 12467, surface: 'ASP' },
        { id: 910002, ident: `${P}AA`, lengthFt: 11329, surface: 'CONC' },
      ],
    );

    const result = await importOurAirports(db.db, dataset, silent);

    expect(result.skipped).toBe(false);
    expect(result.airportsImported).toBe(2);
    expect(result.runwaysImported).toBe(2);

    const stored = await db.db
      .select()
      .from(airport)
      .where(eq(airport.ident, `${P}AA`));
    expect(stored[0]).toMatchObject({
      ident: `${P}AA`,
      iataCode: 'ZQA',
      isoCountry: 'NL',
      scheduledService: true,
      hasRunwayData: true,
    });

    const storedRunways = await db.db
      .select()
      .from(runway)
      .where(eq(runway.airportId, stored[0]!.id));
    expect(storedRunways).toHaveLength(2);
    expect(storedRunways.map((r) => r.surface).sort()).toEqual(['asphalt', 'concrete']);
  });

  it('flags an airport the source gave no runways for', async () => {
    // The acceptance criterion: every airport has runways, or an explicit flag
    // saying we were never told about them. 308 real airports are in this case.
    const dataset = buildDataset(
      [
        { id: 900010, ident: `${P}CC`, scheduled: true },
        { id: 900011, ident: `${P}DD` },
      ],
      [{ id: 910010, ident: `${P}CC` }],
    );

    const result = await importOurAirports(db.db, dataset, silent);
    expect(result.airportsWithoutRunwayData).toBe(1);
    expect(result.scheduledServiceWithoutRunwayData).toBe(0);

    const rows = await db.db
      .select()
      .from(airport)
      .where(eq(airport.ident, `${P}DD`));
    expect(rows[0]?.hasRunwayData).toBe(false);
  });

  it('counts scheduled-service airports missing runway data separately', async () => {
    const dataset = buildDataset([{ id: 900012, ident: `${P}EE`, scheduled: true }], []);
    const result = await importOurAirports(db.db, dataset, silent);
    expect(result.scheduledServiceWithoutRunwayData).toBe(1);
  });

  describe('idempotency', () => {
    it('skips a re-run of the identical dataset', async () => {
      const dataset = buildDataset([{ id: 900020, ident: `${P}FF` }], []);

      const first = await importOurAirports(db.db, dataset, silent);
      expect(first.skipped).toBe(false);

      const second = await importOurAirports(db.db, dataset, silent);
      expect(second.skipped).toBe(true);
      expect(second.airportsImported).toBe(0);
      expect(await countAirports()).toBe(1);
    });

    it('re-imports the identical dataset when forced, without duplicating', async () => {
      const dataset = buildDataset(
        [{ id: 900021, ident: `${P}GG` }],
        [{ id: 910021, ident: `${P}GG` }],
      );

      await importOurAirports(db.db, dataset, silent);
      const before = await db.db
        .select()
        .from(airport)
        .where(eq(airport.ident, `${P}GG`));

      const again = await importOurAirports(db.db, dataset, { ...silent, force: true });
      expect(again.skipped).toBe(false);

      const after = await db.db
        .select()
        .from(airport)
        .where(eq(airport.ident, `${P}GG`));
      expect(after).toHaveLength(1);
      // The id survives, which is what makes it safe for anything to reference
      // an airport later.
      expect(after[0]?.id).toBe(before[0]?.id);
    });

    it('records the dataset version exactly once', async () => {
      const dataset = buildDataset([{ id: 900022, ident: `${P}HH` }], []);
      await importOurAirports(db.db, dataset, silent);
      await importOurAirports(db.db, dataset, silent);
      await importOurAirports(db.db, dataset, { ...silent, force: true });

      const versions = await db.db
        .select()
        .from(datasetVersion)
        .where(eq(datasetVersion.checksum, dataset.checksum));
      expect(versions).toHaveLength(1);
      expect(versions[0]?.dataset).toBe('ourairports');
    });
  });

  describe('updates', () => {
    it('updates a changed airport in place rather than inserting a second row', async () => {
      const first = buildDataset([{ id: 900030, ident: `${P}II`, name: 'Old Name' }], []);
      await importOurAirports(db.db, first, silent);
      const before = await db.db
        .select()
        .from(airport)
        .where(eq(airport.ident, `${P}II`));

      const second = buildDataset([{ id: 900030, ident: `${P}II`, name: 'New Name' }], []);
      await importOurAirports(db.db, second, silent);

      const after = await db.db
        .select()
        .from(airport)
        .where(eq(airport.ident, `${P}II`));
      expect(after).toHaveLength(1);
      expect(after[0]?.id).toBe(before[0]?.id);
      expect(after[0]?.name).toBe('New Name');
    });

    it('follows an ident correction upstream, matching on the source row id', async () => {
      // Upstream corrects identifiers. Keying on ident would leave the old row
      // behind as a phantom airport.
      const first = buildDataset([{ id: 900031, ident: `${P}JJ` }], []);
      await importOurAirports(db.db, first, silent);
      const before = await db.db
        .select()
        .from(airport)
        .where(eq(airport.ident, `${P}JJ`));

      const second = buildDataset([{ id: 900031, ident: `${P}KK` }], []);
      await importOurAirports(db.db, second, silent);

      expect(
        await db.db
          .select()
          .from(airport)
          .where(eq(airport.ident, `${P}JJ`)),
      ).toHaveLength(0);
      const renamed = await db.db
        .select()
        .from(airport)
        .where(eq(airport.ident, `${P}KK`));
      expect(renamed[0]?.id).toBe(before[0]?.id);
    });

    it('removes a runway that has gone from the source', async () => {
      const first = buildDataset(
        [{ id: 900032, ident: `${P}LL` }],
        [
          { id: 910032, ident: `${P}LL` },
          { id: 910033, ident: `${P}LL` },
        ],
      );
      await importOurAirports(db.db, first, silent);

      const second = buildDataset(
        [{ id: 900032, ident: `${P}LL` }],
        [{ id: 910032, ident: `${P}LL` }],
      );
      const result = await importOurAirports(db.db, second, silent);

      expect(result.removedRunways).toBeGreaterThanOrEqual(1);
      const stored = await db.db
        .select()
        .from(airport)
        .where(eq(airport.ident, `${P}LL`));
      const remaining = await db.db
        .select()
        .from(runway)
        .where(eq(runway.airportId, stored[0]!.id));
      expect(remaining).toHaveLength(1);
    });
  });

  describe('airports that disappear upstream', () => {
    it('reports them but does not delete by default', async () => {
      // Airports are identity — hubs, routes and flight history will point at
      // them. A mirror glitch must not silently delete a player's hub.
      const first = buildDataset(
        [
          { id: 900040, ident: `${P}MM` },
          { id: 900041, ident: `${P}NN` },
        ],
        [],
      );
      await importOurAirports(db.db, first, silent);

      const second = buildDataset([{ id: 900040, ident: `${P}MM` }], []);
      const result = await importOurAirports(db.db, second, silent);

      expect(result.disappearedAirports).toBeGreaterThanOrEqual(1);
      expect(result.prunedAirports).toBe(0);
      expect(
        await db.db
          .select()
          .from(airport)
          .where(eq(airport.ident, `${P}NN`)),
      ).toHaveLength(1);
    });

    it('deletes them when pruning is asked for', async () => {
      const first = buildDataset(
        [
          { id: 900042, ident: `${P}OO` },
          { id: 900043, ident: `${P}PP` },
        ],
        [],
      );
      await importOurAirports(db.db, first, silent);

      const second = buildDataset([{ id: 900042, ident: `${P}OO` }], []);
      const result = await importOurAirports(db.db, second, { ...silent, prune: true });

      expect(result.prunedAirports).toBeGreaterThanOrEqual(1);
      expect(
        await db.db
          .select()
          .from(airport)
          .where(eq(airport.ident, `${P}PP`)),
      ).toHaveLength(0);
    });
  });

  describe('sanity checks', () => {
    it('refuses the import and writes nothing when the dataset looks wrong', async () => {
      // A mirror serving an error page, or a truncated download. The whole point
      // of the transaction: a half-imported world map is worse than none.
      const dataset = buildDataset([{ id: 900050, ident: `${P}QQ` }], []);

      await expect(
        importOurAirports(db.db, dataset, {
          ...silent,
          sanityBounds: { ...FIXTURE_BOUNDS, airportsTotal: [50_000, 200_000] },
        }),
      ).rejects.toBeInstanceOf(SanityCheckFailure);

      expect(await countAirports()).toBe(0);
      const versions = await db.db
        .select()
        .from(datasetVersion)
        .where(eq(datasetVersion.checksum, dataset.checksum));
      expect(versions).toHaveLength(0);
    });

    it('names which check failed', async () => {
      const dataset = buildDataset([{ id: 900051, ident: `${P}RR` }], []);
      await expect(
        importOurAirports(db.db, dataset, {
          ...silent,
          sanityBounds: { ...FIXTURE_BOUNDS, scheduledService: [3_000, 6_000] },
        }),
      ).rejects.toThrow(/scheduled service/);
    });
  });

  describe('batching', () => {
    it('imports more rows than fit in one statement', async () => {
      // BATCH_SIZE is 500. Postgres caps a statement at 65,535 bound parameters,
      // and 1,200 airports crosses the boundary twice — the failure mode this
      // guards against only appears above the limit.
      const airports = Array.from({ length: 1_200 }, (_, i) => ({
        id: 901_000 + i,
        ident: `${P}${i.toString(36).toUpperCase().padStart(4, '0')}`,
      }));
      const runways = airports.slice(0, 600).map((a, i) => ({ id: 911_000 + i, ident: a.ident }));

      const result = await importOurAirports(db.db, buildDataset(airports, runways), silent);

      expect(result.airportsImported).toBe(1_200);
      expect(result.runwaysImported).toBe(600);
      expect(await countAirports()).toBe(1_200);
    });
  });
});
