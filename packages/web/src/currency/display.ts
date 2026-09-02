import {
  convertUsdMinor,
  currencyMeta,
  DEFAULT_CURRENCY,
  RATE_SCALE,
  type CurrencyRateView,
} from '@tailfin/shared';

/**
 * Display-currency formatting (M8-02).
 *
 * Every money value in the app is USD integer minor units. The player may choose
 * a display currency; this module converts a USD minor amount to it and formats
 * it with the right symbol and decimals — and it is the **only** place that
 * conversion happens, so nothing stored or computed is ever in another currency.
 *
 * The current currency and the rates live in module state rather than React
 * context, so the three legacy formatters (`formatMinorUnits`, `formatMoney`,
 * `formatSalary`) stay plain functions their many call sites can keep calling —
 * they now convert and add a symbol without a single call site changing.
 * `CurrencyProvider` keeps this state in sync with `/api/currencies` and the
 * player's choice; a component re-mounts (on navigation) or re-renders (through
 * the provider's context) to pick up a change. The admin console uses its own
 * USD formatters and is deliberately untouched.
 */

interface DisplayState {
  code: string;
  /** `rateE6` per code; missing means fall back to parity. */
  rateByCode: Map<string, number>;
}

let state: DisplayState = { code: DEFAULT_CURRENCY, rateByCode: new Map() };

/** Point the formatters at a currency and rate set. Called by `CurrencyProvider`. */
export function setDisplayCurrency(
  code: string,
  currencies: readonly CurrencyRateView[] | null | undefined,
): void {
  const list = currencies ?? [];
  state = {
    code: currencyMeta(code) ? code : DEFAULT_CURRENCY,
    rateByCode: new Map(list.map((c) => [c.code, c.rateE6])),
  };
}

/** The currency the formatters are currently rendering in. */
export function activeCurrency(): string {
  return state.code;
}

/**
 * Format a USD minor amount in the active display currency, with its symbol and
 * native decimal count (¥ shows no decimals, $ shows two). `fractionDigits`
 * overrides the decimals — the salary display uses 0.
 */
export function formatUsdMinor(usdMinor: number, options?: { fractionDigits?: number }): string {
  const { code, rateByCode } = state;
  return formatConverted(
    usdMinor,
    code,
    rateByCode.get(code) ?? RATE_SCALE,
    currencyMeta(code)?.decimals ?? 2,
    options,
  );
}

/**
 * Format a USD minor amount in a **specific** currency and rate, independent of
 * the active choice — for the Settings preview, which shows what a currency the
 * player is about to pick would look like before they save it.
 */
export function formatInCurrency(
  usdMinor: number,
  currency: { code: string; rateE6: number; decimals: number },
  options?: { fractionDigits?: number },
): string {
  return formatConverted(usdMinor, currency.code, currency.rateE6, currency.decimals, options);
}

function formatConverted(
  usdMinor: number,
  code: string,
  rateE6: number,
  decimals: number,
  options?: { fractionDigits?: number },
): string {
  const major = convertUsdMinor(usdMinor, rateE6) / 100;
  const digits = options?.fractionDigits ?? decimals;

  try {
    // Locale pinned to en-US, as the previous formatters were, so grouping and
    // separators are deterministic across browsers and CI; only the symbol and
    // decimal count change with the currency.
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: code,
      currencyDisplay: 'narrowSymbol',
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    }).format(major);
  } catch {
    // A runtime without `narrowSymbol` support, or an unexpected code: fall back
    // to the symbol from our metadata plus a grouped number, never throwing in a
    // render path.
    const symbol = currencyMeta(code)?.symbol ?? '$';
    return `${symbol}${major.toLocaleString('en-US', {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    })}`;
  }
}

/** The active currency's symbol, for a compact figure that assembles its own text. */
export function activeSymbol(): string {
  return currencyMeta(state.code)?.symbol ?? '$';
}

/**
 * A compact money figure in the active display currency — `$1.2k`, `€3.4M`.
 * Used where a full formatted amount would crowd the layout (KPI chips, planner).
 */
export function compactUsdMinor(usdMinor: number): string {
  const { code, rateByCode } = state;
  const rateE6 = rateByCode.get(code) ?? RATE_SCALE;
  const value = convertUsdMinor(usdMinor, rateE6) / 100;
  const symbol = activeSymbol();
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `${symbol}${(value / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${symbol}${(value / 1_000).toFixed(1)}k`;
  return `${symbol}${value.toFixed(0)}`;
}
