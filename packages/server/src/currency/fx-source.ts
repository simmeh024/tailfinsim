/**
 * Where live FX rates come from (M8-02).
 *
 * A `FxRateSource` answers "what is each currency worth per 1 USD right now?".
 * It is an injected dependency everywhere it is used, so tests pass a
 * deterministic stub and never touch the network, and the worker passes the HTTP
 * implementation below. The refresh job (`engine/currency-refresh.ts`) treats a
 * throw as "no update this cycle" — a source outage leaves the last rates in
 * place and is counted, never fatal.
 */

/** Rates keyed by ISO-4217 code, each the value of one USD in that currency. */
export type FxRateSource = () => Promise<Record<string, number>>;

/** The public endpoint we read. USD-based, free, no API key. */
export const FX_SOURCE_URL = 'https://open.er-api.com/v6/latest/USD';

/** The host, for the `source` column and the threat model — no secret involved. */
export const FX_SOURCE_HOST = 'open.er-api.com';

interface ErApiResponse {
  result?: string;
  rates?: Record<string, unknown>;
}

/**
 * Fetch USD-based rates from {@link FX_SOURCE_URL}.
 *
 * Validates the shape and keeps only finite positive numbers, so a malformed
 * payload cannot write a garbage rate. Throws on a network error, a non-success
 * body or an empty rate set; the caller decides what a throw means.
 */
export const httpFxSource: FxRateSource = async () => {
  const response = await fetch(FX_SOURCE_URL, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    throw new Error(`FX source responded ${String(response.status)}`);
  }
  const body = (await response.json()) as ErApiResponse;
  if (body.result !== 'success' || typeof body.rates !== 'object' || body.rates === null) {
    throw new Error('FX source returned an unexpected body');
  }
  const rates: Record<string, number> = {};
  for (const [code, value] of Object.entries(body.rates)) {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
      rates[code] = value;
    }
  }
  if (Object.keys(rates).length === 0) {
    throw new Error('FX source returned no usable rates');
  }
  return rates;
};
