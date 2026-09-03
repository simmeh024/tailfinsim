/**
 * Display formatting for the cabin configurator (M6-08).
 *
 * The configurator's numbers are decision-support figures, not the ledger — the
 * economy's money is USD minor units and formatted by `airline/api`. These are
 * plain presentation helpers for a builder that trades in seats, kilos and
 * nautical miles, kept in one place so the summary bar and the inspector round
 * and abbreviate a value the same way.
 */

/** `$18,600` — full dollars with thousands separators. */
export function formatUsd(value: number): string {
  return `$${Math.round(value).toLocaleString('en-US')}`;
}

/** `$4.20M`, `$226K`, `$980` — compact for headline totals. */
export function formatUsdCompact(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `$${(value / 1_000).toFixed(0)}K`;
  return `$${String(Math.round(value))}`;
}

/** `12.6 t` — cabin weight, tonnes to one decimal. */
export function formatTonnes(kg: number): string {
  return `${(kg / 1000).toFixed(1)} t`;
}

/** `142 kg` — a single row or monument. */
export function formatKg(kg: number): string {
  return `${Math.round(kg).toLocaleString('en-US')} kg`;
}

/** `3,150 nm`. */
export function formatNm(nm: number): string {
  return `${Math.round(nm).toLocaleString('en-US')} nm`;
}

/** A signed delta with its unit: `+3 min`, `−80 nm`, `0`. */
export function formatDelta(value: number, unit: string): string {
  if (value === 0) return `0 ${unit}`;
  const sign = value > 0 ? '+' : '−';
  return `${sign}${String(Math.abs(Math.round(value)))} ${unit}`;
}

/** Pitch/width in inches with the cm the mockup shows in parentheses. */
export function inchesWithCm(inches: number): string {
  return `${String(inches)} in (${String(Math.round(inches * 2.54))} cm)`;
}

/** Comfort as up-to-five stars, half-steps rounded. */
export function comfortStars(comfort: number): string {
  const rounded = Math.round(comfort * 2) / 2;
  const full = Math.floor(rounded);
  const half = rounded - full >= 0.5 ? 1 : 0;
  return '★'.repeat(full) + (half ? '⯪' : '') + '☆'.repeat(5 - full - half);
}
