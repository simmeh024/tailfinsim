/**
 * The rotating C-Suite market (§9.1 follow-up, Phase 3).
 *
 * The executive market does not show the whole roster at once: it shows a
 * **rotating ten**, reshuffled every 24 hours, so the page has the feel of a
 * headhunter's shortlist that turns over daily rather than a static catalogue.
 *
 * The rotation is a pure function of a **day index** — real-time days since the
 * epoch — so every viewer sees the same ten within the same 24-hour window, the
 * selection is stable across a reload, and a test can pin it by pinning the
 * clock. There is no server round-trip: the roster is shared, deterministic
 * client data, and the countdown is the same arithmetic run against `Date.now()`.
 */

/** How long a shortlist stands before it turns over — 24 hours. */
export const ROSTER_REFRESH_MS = 24 * 60 * 60 * 1000;

/** How many of the roster the market shows at once. */
export const ROSTER_SIZE = 10;

/** The 24-hour window `now` falls in, counted from the Unix epoch. */
export function rosterDayIndex(now: number = Date.now()): number {
  return Math.floor(now / ROSTER_REFRESH_MS);
}

/** The wall-clock instant (ms) the current shortlist turns over. */
export function nextRefreshAt(now: number = Date.now()): number {
  return (rosterDayIndex(now) + 1) * ROSTER_REFRESH_MS;
}

/** Milliseconds until the next turnover — never negative. */
export function msUntilRefresh(now: number = Date.now()): number {
  return Math.max(0, nextRefreshAt(now) - now);
}

/** A whole-seconds HH:MM:SS countdown from a millisecond span — the refresh clock. */
export function formatCountdown(ms: number): string {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number): string => n.toString().padStart(2, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

/** A small, fast, seedable PRNG — enough to shuffle a two-dozen-item list. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The `count` candidates on offer in a given 24-hour window.
 *
 * A deterministic Fisher–Yates shuffle seeded by the day index, so the order is
 * genuinely mixed (not just the first ten of the catalogue) yet identical for
 * everyone in the same window. The input is never mutated.
 */
export function rotatingRoster<T extends { id: string }>(
  candidates: readonly T[],
  dayIndex: number,
  count: number,
): T[] {
  const pool = [...candidates];
  // Seed off the pool length too, so two different pools (say two seats) do not
  // shuffle in lockstep on the same day.
  const rand = mulberry32(dayIndex * 2654435761 + pool.length + 1);
  for (let i = pool.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    const a = pool[i]!;
    const b = pool[j]!;
    pool[i] = b;
    pool[j] = a;
  }
  return pool.slice(0, Math.min(count, pool.length));
}

/** The C-Suite's rotating shortlist — {@link rotatingRoster} at the C-Suite size. */
export function rotatingExecutiveRoster<T extends { id: string }>(
  candidates: readonly T[],
  dayIndex: number,
  count: number = ROSTER_SIZE,
): T[] {
  return rotatingRoster(candidates, dayIndex, count);
}
