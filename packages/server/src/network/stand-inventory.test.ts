import { describe, expect, it } from 'vitest';

import { AirportTier } from '@tailfin/shared';

import { standInventory } from './gates';

/**
 * Every stand at every airport has a label of its own (M7-06, fixed in M7-07).
 *
 * A stand is addressed by its label alone — a lease names a position, the kind
 * is the first inventory entry that matches, and the airport map keys stands by
 * it. Until M7-07 a flagship's cargo stands were `C1`–`C8` while its 48 contact
 * gates ran piers A–D, so pier C's gates and the cargo stands shared labels and
 * a flagship cargo stand could never be leased. No database: this runs on every
 * pull request.
 */
describe('stand labels', () => {
  const tiers = [...AirportTier.options, null] as const;

  it.each(tiers)('are unique at a %s airport', (tier) => {
    const positions = standInventory(tier).map((stand) => stand.position);
    expect(new Set(positions).size).toBe(positions.length);
  });

  it.each(tiers)('never give a pier the letter of a non-gate stand at a %s airport', (tier) => {
    const inventory = standInventory(tier);
    const piers = new Set(
      inventory.filter((stand) => stand.kind === 'contact_gate').map((stand) => stand.position[0]),
    );
    const prefixes = new Set(
      inventory.filter((stand) => stand.kind !== 'contact_gate').map((stand) => stand.position[0]),
    );
    for (const pier of piers) expect(prefixes.has(pier), `pier ${String(pier)}`).toBe(false);
  });

  it('labels a flagship’s cargo stands apart from pier C', () => {
    const flagship = standInventory('flagship');
    const kindsOf = (position: string) =>
      flagship.filter((stand) => stand.position === position).map((stand) => stand.kind);
    // Pier C is a pier, and only a pier.
    expect(kindsOf('C1')).toEqual(['contact_gate']);
    // Freight has its own letter.
    expect(kindsOf('F1')).toEqual(['cargo_stand']);
    expect(flagship.filter((stand) => stand.kind === 'cargo_stand').map((s) => s.position)).toEqual(
      ['F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8'],
    );
  });
});
