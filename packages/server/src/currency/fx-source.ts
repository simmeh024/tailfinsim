/**
 * Where live FX rates come from (M8-02).
 *
 * A `FxRateSource` answers "what is each currency worth per 1 USD right now?".
 * It is an injected dependency everywhere it is used, so tests pass a
 * deterministic stub and never touch the network, and the worker passes the HTTP
 * implementation below. The refresh job (`engine/currency-refresh.ts`) treats a
 * throw as "no update this cycle" — a source outage leaves the last rates in
 * place and is counted, never fatal.
 *
 * ## Two providers, chosen by whether a key is configured
 *
 * With no `FX_API_KEY`, it reads the **keyless** `open.er-api.com` endpoint —
 * fine for local development and the default. With `FX_API_KEY` set (in the
 * worker's env file, never in source), it reads the **authenticated**
 * ExchangeRate-API v6 endpoint, which is more reliable and higher-limit. Both are
 * USD-based and Cloudflare-fronted; the difference on the wire is only the key in
 * the path and the field the rates live under (`conversion_rates` vs `rates`).
 * Both are in ADR-0012.
 */

/** Rates keyed by ISO-4217 code, each the value of one USD in that currency. */
export type FxRateSource = () => Promise<Record<string, number>>;

/** The keyless host — the default, and the threat-model reference. No secret. */
export const FX_SOURCE_HOST = 'open.er-api.com';

/** The authenticated host, used when `FX_API_KEY` is set. */
export const FX_SOURCE_HOST_KEYED = 'v6.exchangerate-api.com';

/** The FX provider's API key, or undefined. Read from the environment, never source. */
function fxApiKey(): string | undefined {
  const key = process.env.FX_API_KEY;
  return key && key.trim() !== '' ? key.trim() : undefined;
}

/** Which host the live refresh is reading right now — for the `source` column. */
export function activeFxHost(): string {
  return fxApiKey() ? FX_SOURCE_HOST_KEYED : FX_SOURCE_HOST;
}

interface FxResponse {
  result?: string;
  /** open.er-api.com (keyless). */
  rates?: Record<string, unknown>;
  /** exchangerate-api.com v6 (authenticated). */
  conversion_rates?: Record<string, unknown>;
}

/**
 * Fetch USD-based rates from the configured provider.
 *
 * Validates the shape and keeps only finite positive numbers, so a malformed
 * payload cannot write a garbage rate. Throws on a network error, a non-success
 * body or an empty rate set; the caller decides what a throw means. The URL —
 * which for the authenticated provider contains the key — is never logged.
 */
export const httpFxSource: FxRateSource = async () => {
  const key = fxApiKey();
  const url = key
    ? `https://${FX_SOURCE_HOST_KEYED}/v6/${key}/latest/USD`
    : `https://${FX_SOURCE_HOST}/v6/latest/USD`;

  const response = await fetch(url, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    // Deliberately does not include the URL — it may carry the key.
    throw new Error(`FX source responded ${String(response.status)}`);
  }
  const body = (await response.json()) as FxResponse;
  const table = body.conversion_rates ?? body.rates;
  if (body.result !== 'success' || typeof table !== 'object' || table === null) {
    throw new Error('FX source returned an unexpected body');
  }
  const rates: Record<string, number> = {};
  for (const [code, value] of Object.entries(table)) {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
      rates[code] = value;
    }
  }
  if (Object.keys(rates).length === 0) {
    throw new Error('FX source returned no usable rates');
  }
  return rates;
};
