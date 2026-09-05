import { describe, expect, it } from 'vitest';

import { formatMinorUnitsUsd, formatMinorUnitsUsdSigned } from '@tailfin/shared';

import {
  adminAt,
  adminAtSeconds,
  adminCompactMoney,
  adminDate,
  adminMoney,
  adminMovement,
} from './format';

/**
 * One way to render money and one way to render an instant (UX-01, UX-02).
 *
 * There were thirteen of these: four money formatters — three of which
 * disagreed, and one which printed `50000000` where it meant $500,000.00 — and
 * nine copies of `formatAt` at two precisions. The tests worth having are the
 * ones that fail if any of that comes back, so they assert the *shape* the
 * console shows rather than only that a function returns a string.
 */

describe('money', () => {
  it('shows the currency, because the console reads a USD ledger', () => {
    // The old formatters returned `500,000.00` with no symbol, on a page that
    // also renders server prose containing figures. A number with no unit
    // beside a number with one is how a reader ends up guessing.
    expect(adminMoney(50_000_000)).toBe('$500,000.00');
  });

  it('always shows two decimals, so a column lines up', () => {
    // `PlayersPage`'s old formatter used `maximumFractionDigits` alone, so a
    // round balance lost its decimals and the column went ragged.
    expect(adminMoney(100)).toBe('$1.00');
    expect(adminMoney(150)).toBe('$1.50');
    expect(adminMoney(0)).toBe('$0.00');
  });

  it('does not print raw minor units', () => {
    // `CarriersPage` did exactly this. An NPC holding half a million dollars
    // read as `50000000`.
    expect(adminMoney(50_000_000)).not.toBe('50000000');
  });

  it('signs a movement so a ledger reads as an account', () => {
    expect(adminMovement(12_345)).toBe('+$123.45');
    expect(adminMovement(-12_345)).toBe('-$123.45');
    // Zero is neither a credit nor a debit and takes no sign.
    expect(adminMovement(0)).toBe('$0.00');
  });

  it('compacts a headline figure without losing the currency', () => {
    expect(adminCompactMoney(120_000_000)).toBe('$1.2M');
  });

  it('is the same formatter the server writes prose with', () => {
    // The point of putting it in `@tailfin/shared`: the NPC decision log's
    // sentences are built server-side and rendered on the Carriers page beside
    // a cash column. Two formatters is how they came to disagree.
    expect(adminMoney(50_000_000)).toBe(formatMinorUnitsUsd(50_000_000));
    expect(adminMovement(-12_345)).toBe(formatMinorUnitsUsdSigned(-12_345));
  });
});

describe('instants', () => {
  const ISO = '2026-09-05T14:03:07.123Z';

  it('says UTC, on a console that can reset a world', () => {
    /*
     * The whole of UX-02. Every timestamp here is UTC and nothing said so, on a
     * surface that changes a world's speed and archives or resets one — and
     * ADR-0005 is explicit that a reset has no undo. `2026-09-05 14:03` beside a
     * "last backup" figure reads as local time to anybody who has not read the
     * API contract.
     */
    expect(adminAt(ISO)).toBe('2026-09-05 14:03 UTC');
  });

  it('keeps seconds where an order has to be visible', () => {
    // The audit log and the world health page list entries that can share a
    // minute. An order nobody can see is an order nobody can check.
    expect(adminAtSeconds(ISO)).toBe('2026-09-05 14:03:07 UTC');
  });

  it('leaves a plain date unlabelled', () => {
    // A date is not an instant, and labelling one invites the reader to wonder
    // which midnight.
    expect(adminDate(ISO)).toBe('2026-09-05');
    expect(adminDate(ISO)).not.toMatch(/UTC/);
  });

  it('reads the characters the API sent rather than parsing a Date', () => {
    // Which is what makes it UTC without a timezone library. A `new Date(...)`
    // here would render in the reader's zone and be wrong by hours.
    expect(adminAt('2026-01-01T00:30:00.000Z')).toBe('2026-01-01 00:30 UTC');
  });

  it('answers a dash for something absent or malformed', () => {
    // A console that renders `Invalid Date` for a null is one whose other
    // figures stop being trusted.
    expect(adminAt(null)).toBe('—');
    expect(adminAt(undefined)).toBe('—');
    expect(adminAt('')).toBe('—');
    expect(adminAt('2026-09-05')).toBe('—');
    expect(adminAtSeconds('2026-09-05T14:03')).toBe('—');
    expect(adminDate('nope')).toBe('—');
  });
});
