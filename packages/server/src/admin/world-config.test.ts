import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ERA_PRESETS, WorldConfig } from '@tailfin/shared';

import { createDatabase, type DatabaseHandle } from '../db/client';
import { world } from '../db/schema';

import { BOOTSTRAP_ACTOR } from './grants';
import { exportWorldConfig } from './world-config';
import { createWorldAsAdmin } from './worlds';

/**
 * A world exports to the JSON that recreates it (M11-02, §22.2).
 *
 * §22.2's first acceptance criterion. The export deliberately produces the same
 * shape the create endpoint accepts, so the strongest version of this test is a
 * genuine round trip: create from a preset, export, create again from the export,
 * and show the second world's config is the first's. Requires `DATABASE_URL`.
 */
const url = process.env.DATABASE_URL;
if (!url) console.warn('\n  [admin/world-config.test] DATABASE_URL not set — skipping.\n');
const describeDb = url ? describe : describe.skip;

describeDb('exportWorldConfig', () => {
  let db: DatabaseHandle;
  const madeWorlds: string[] = [];

  beforeAll(() => {
    db = createDatabase();
  });

  afterAll(async () => {
    const ids = madeWorlds.splice(0);
    if (ids.length > 0) await db.db.delete(world).where(inArray(world.id, ids));
    await db.close();
  });

  function unique(name: string): string {
    return `${name} ${Math.random().toString(36).slice(2, 8)}`;
  }

  it('returns null for a world that does not exist', async () => {
    expect(await exportWorldConfig(db.db, '00000000-0000-4000-8000-0000000000ee')).toBeNull();
  });

  it('exports a config that parses as the schema the create endpoint guards with', async () => {
    const preset = ERA_PRESETS[0]!;
    const config = { ...preset.config, name: unique(preset.config.name) };
    const created = await createWorldAsAdmin(db.db, config, BOOTSTRAP_ACTOR);
    madeWorlds.push(created.world.id);

    const exported = await exportWorldConfig(db.db, created.world.id);
    expect(exported).not.toBeNull();
    expect(WorldConfig.safeParse(exported).success).toBe(true);
    // Every field survives the round trip, including the numeric speed that the
    // driver hands back as a string.
    expect(exported).toEqual(config);
    expect(typeof exported?.speedMultiplier).toBe('number');
  });

  it('recreates an identical world from its own export', async () => {
    const preset = ERA_PRESETS.find((p) => p.id === 'sandbox')!;
    const first = { ...preset.config, name: unique(preset.config.name) };
    const one = await createWorldAsAdmin(db.db, first, BOOTSTRAP_ACTOR);
    madeWorlds.push(one.world.id);

    const exported = await exportWorldConfig(db.db, one.world.id);
    expect(exported).not.toBeNull();

    // Recreated under a different name, because the name is the one field a
    // second world cannot share; everything that defines the *rules* is identical.
    const second = { ...exported!, name: unique('Recreated') };
    const two = await createWorldAsAdmin(db.db, second, BOOTSTRAP_ACTOR);
    madeWorlds.push(two.world.id);

    const reexported = await exportWorldConfig(db.db, two.world.id);
    expect({ ...reexported, name: '' }).toEqual({ ...exported, name: '' });

    // The identity and clock are *not* exported, so the two worlds are genuinely
    // separate: same rules, own seed and own launch date (ADR-0005).
    const [a] = await db.db
      .select({ seed: world.seed, launchDate: world.launchDate })
      .from(world)
      .where(eq(world.id, one.world.id));
    const [b] = await db.db
      .select({ seed: world.seed, launchDate: world.launchDate })
      .from(world)
      .where(eq(world.id, two.world.id));
    expect(a?.seed).not.toBe(b?.seed);
  });

  it('exports each era preset unchanged, so the catalogue era survives a recreate', async () => {
    for (const preset of ERA_PRESETS) {
      const config = { ...preset.config, name: unique(preset.config.name) };
      const created = await createWorldAsAdmin(db.db, config, BOOTSTRAP_ACTOR);
      madeWorlds.push(created.world.id);
      const exported = await exportWorldConfig(db.db, created.world.id);
      // The epoch is what makes an era an era (M4-02 gates the catalogue on it).
      expect(exported?.epoch, preset.id).toBe(config.epoch);
      expect(exported, preset.id).toEqual(config);
    }
  });
});
