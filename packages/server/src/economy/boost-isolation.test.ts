import { readdirSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * §10.4's second rule, as a property of the code (M9-06).
 *
 * > *"**Efficiency only.** No boost touches demand capture, price tolerance, or
 * > reputation directly. … A veteran airline is **leaner**, not **more
 * > attractive**."*
 *
 * The acceptance criterion is *"A test asserts no boost writes to any
 * demand-model input"*, and this is that test. It is a walk of the source rather
 * than a run of the model for the reason `engine/boundary.test.ts` gives: "give a
 * boosted airline and an unboosted one the same market and compare shares"
 * passes trivially today, because no boost reaches the logit — and keeps passing
 * on the day somebody adds a `reputation += doctrine` three files away, until a
 * test happens to exercise that path. Whether any module that **feeds the
 * demand model** can even *name* the boost machinery is decidable and total, and
 * fails the moment the wire is added.
 *
 * ## What counts as feeding the demand model
 *
 * Every module in `@tailfin/sim`'s `demand/` — gravity, segments, modulation,
 * schedule fit, the logit and its utility terms, class allocation, itineraries,
 * the booking curve — and every module anywhere in `sim` or `server` that
 * **imports one of its functions**. Discovered rather than listed, so a new
 * market-share readout or NPC review that starts calling `computeShares` is
 * covered the day it is written, without anybody remembering to add it here.
 *
 * The scan is textual, so it over-states: a comment naming `appliedBoosts`
 * inside a demand module would fail it. That direction is deliberate — a false
 * failure is a conversation about the rule, a false pass is a moat.
 */

const packagesDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const simSrc = resolve(packagesDir, 'sim/src');
const serverSrc = resolve(packagesDir, 'server/src');
const demandDir = resolve(simSrc, 'demand');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [full] : [];
  });
}

const relativeName = (file: string) => relative(packagesDir, file).replaceAll('\\', '/');

/** The demand model's own exported functions and input types, read from its modules. */
function demandExports(): { functions: string[]; types: string[] } {
  const functions = new Set<string>();
  const types = new Set<string>();
  for (const file of sourceFiles(demandDir)) {
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(/^export (?:async )?function ([A-Za-z0-9_]+)/gm)) {
      if (match[1] !== undefined) functions.add(match[1]);
    }
    for (const match of source.matchAll(/^export (?:interface|type) ([A-Za-z0-9_]+)/gm)) {
      if (match[1] !== undefined) types.add(match[1]);
    }
  }
  return { functions: [...functions], types: [...types] };
}

/**
 * Every name through which a boost travels. A module that feeds demand and
 * mentions none of these cannot pass a boost into it.
 */
const BOOST_MACHINERY = [
  'EfficiencyBoost',
  'stackEfficiencyBoosts',
  'resolveEfficiencyBoosts',
  'appliedBoosts',
  'ResolvedBoosts',
  'ResolvedEfficiency',
  'SourceBoosts',
  'BoostsByQuantity',
  'EFFICIENCY_CEILINGS',
  'doctrineStrength',
  'doctrineBoosts',
  'skillBoosts',
  'stackAirlineSkills',
  'airlineSkillBoosts',
  'trainingXpMultiplier',
  'resolveAirlineEfficiency',
];

const BOOST_PATTERN = new RegExp(`\\b(${BOOST_MACHINERY.join('|')})\\b`);

describe('§10.4: no boost reaches the demand model', () => {
  const { functions, types } = demandExports();

  it('finds the demand model to guard (the scan is not vacuous)', () => {
    // If the directory moved or the export style changed, every assertion below
    // would pass over an empty list. Name a few functions the model cannot lose.
    for (const name of ['computeShares', 'utilityTerms', 'allocateByClass', 'schedFit']) {
      expect(functions, `${name} is no longer exported from sim/src/demand`).toContain(name);
    }
  });

  it('keeps the boost machinery out of every demand module', () => {
    const offenders = sourceFiles(demandDir)
      .filter((file) => BOOST_PATTERN.test(readFileSync(file, 'utf8')))
      .map(relativeName);
    expect(offenders).toEqual([]);
  });

  it('keeps it out of every module that feeds the demand model, too', () => {
    // A feeder calls one of the model's functions, or builds one of its input
    // types — `npc/carrier.ts` never calls the logit, it assembles the
    // `ClassOperator` offers the logit is then run over, which is exactly the
    // kind of input this rule protects.
    const callsDemand = new RegExp(`\\b(${functions.join('|')})\\s*\\(`);
    const namesDemandType = new RegExp(`\\b(${types.join('|')})\\b`);
    const feeders = [...sourceFiles(simSrc), ...sourceFiles(serverSrc)].filter((file) => {
      if (file.startsWith(demandDir)) return false;
      const source = readFileSync(file, 'utf8');
      return callsDemand.test(source) || namesDemandType.test(source);
    });

    // The feeders this rule exists for, found rather than listed. If none is,
    // the discovery is broken rather than the codebase clean.
    expect(feeders.map(relativeName)).toEqual(
      expect.arrayContaining(['server/src/network/competition.ts', 'sim/src/npc/carrier.ts']),
    );

    const offenders = feeders
      .filter((file) => BOOST_PATTERN.test(readFileSync(file, 'utf8')))
      .map((file) => {
        const match = BOOST_PATTERN.exec(readFileSync(file, 'utf8'));
        return `${relativeName(file)} names ${match?.[1] ?? '?'}`;
      });
    expect(offenders).toEqual([]);
  });

  it('resolves only efficiency quantities — none of them a demand input', () => {
    // The resolver's whole output vocabulary. Every key is a cost or a duration;
    // a key named for anything a passenger chooses on would be the failure.
    const efficiency = readFileSync(resolve(packagesDir, 'shared/src/efficiency.ts'), 'utf8');
    const block = /export const EfficiencyQuantity = z\.enum\(\[([^\]]*)\]\)/s.exec(efficiency);
    const quantities = [...(block?.[1] ?? '').matchAll(/'([A-Za-z]+)'/g)].map((m) => m[1]);
    expect(quantities.sort()).toEqual(
      [
        'blockTime',
        'fuelBurn',
        'incidentRate',
        'maintenanceCost',
        'serviceCost',
        'turnaroundTime',
      ].sort(),
    );
    for (const forbidden of ['demand', 'reputation', 'price', 'fare', 'share', 'utility']) {
      for (const quantity of quantities) {
        expect(quantity?.toLowerCase()).not.toContain(forbidden);
      }
    }
  });
});
