import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  AIRPORT_CODE_NAMESPACES,
  createAirportIdentities,
  type AirportCodeNamespace,
} from './airport-codes';

/**
 * Test airport identities cannot collide (BUG-11).
 *
 * The property is *by construction* rather than *probably*, so these check the
 * construction: distinct namespaces, a serial inside each, and the shape the
 * `airport_icao_code_format` check constraint demands.
 *
 * The last one is a source scan, in the spirit of `sim`'s `balance-source.test.ts`:
 * the interesting claim is about **where a value came from**, and lint cannot see
 * that. Without it the two broken idioms come back the first time somebody copies
 * a suite that predates this.
 */

const SERVER_SRC = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('test airport identities', () => {
  const namespaces = Object.keys(AIRPORT_CODE_NAMESPACES) as AirportCodeNamespace[];

  it('gives every suite a namespace of its own', () => {
    const letters = Object.values(AIRPORT_CODE_NAMESPACES);
    expect(new Set(letters).size).toBe(letters.length);
    for (const letter of letters) expect(letter).toMatch(/^[A-Z]$/);
  });

  it('mints codes the database will accept', () => {
    // `airport_icao_code_format`: exactly four of [A-Z0-9].
    for (const namespace of namespaces) {
      const next = createAirportIdentities(namespace);
      for (let i = 0; i < 30; i += 1) {
        expect(next().icaoCode).toMatch(/^[A-Z0-9]{4}$/);
      }
    }
  });

  it('never repeats a code, an ident or a source id within a suite', () => {
    const next = createAirportIdentities('schedule/prepare-legs');
    const seen = { icao: new Set<string>(), ident: new Set<string>(), source: new Set<number>() };
    for (let i = 0; i < 676; i += 1) {
      const id = next();
      seen.icao.add(id.icaoCode);
      seen.ident.add(id.ident);
      seen.source.add(id.sourceId);
    }
    expect(seen.icao.size).toBe(676);
    expect(seen.ident.size).toBe(676);
    expect(seen.source.size).toBe(676);
  });

  it('never repeats across suites either, which is the concurrent case', () => {
    // vitest runs suites in parallel against one database, so two suites minting
    // their first airport at the same moment is the ordinary case, not the edge.
    const icao = new Set<string>();
    const source = new Set<number>();
    let minted = 0;
    for (const namespace of namespaces) {
      const next = createAirportIdentities(namespace);
      for (let i = 0; i < 50; i += 1) {
        const id = next();
        icao.add(id.icaoCode);
        source.add(id.sourceId);
        minted += 1;
      }
    }
    expect(icao.size).toBe(minted);
    expect(source.size).toBe(minted);
  });

  it('cannot collide with imported OurAirports data', () => {
    // No real ICAO location indicator begins with Q — the letter is reserved and
    // unassigned — so a test airport and a real one cannot meet. Three suites
    // used to prefix `Z`, which is China and Korea.
    const next = createAirportIdentities('npc/npc');
    expect(next().icaoCode.startsWith('Q')).toBe(true);
    // And a real source id is positive, so a test row is recognisable as one.
    expect(next().sourceId).toBeLessThan(0);
  });

  it('refuses to wrap rather than colliding quietly', () => {
    const next = createAirportIdentities('flight/settle');
    for (let i = 0; i < 676; i += 1) next();
    expect(() => next()).toThrow(/namespace holds/);
  });

  describe('the idioms this replaced', () => {
    function testFiles(directory: string, found: string[] = []): string[] {
      for (const entry of readdirSync(directory)) {
        const path = join(directory, entry);
        if (statSync(path).isDirectory()) testFiles(path, found);
        else if (entry.endsWith('.test.ts')) found.push(path);
      }
      return found;
    }

    /**
     * The two shapes that produced the collision, written so they match the code
     * that caused it and not merely any use of `Math.random`.
     */
    const FORBIDDEN = [
      {
        pattern: /sourceId:\s*Math\./,
        why: 'a random source_id — the column is unique; use createAirportIdentities',
      },
      {
        pattern: /Math\.random\(\)\.toString\(36\)\.slice\(2,\s*5\)/,
        why: 'three base-36 characters as an ICAO code, and sometimes fewer than three',
      },
    ];

    it('are gone, and cannot come back unnoticed', () => {
      const offences: string[] = [];
      for (const file of testFiles(SERVER_SRC)) {
        const source = readFileSync(file, 'utf8');
        for (const { pattern, why } of FORBIDDEN) {
          if (pattern.test(source)) {
            offences.push(`${relative(SERVER_SRC, file)}: ${why}`);
          }
        }
      }
      expect(offences).toEqual([]);
    });
  });
});
