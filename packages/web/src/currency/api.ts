import type { CurrenciesResponse, DisplayCurrency } from '@tailfin/shared';

/**
 * Display-currency API client (M8-02).
 *
 * Thin wrappers over the two endpoints. Same-origin, cookie-authenticated like
 * the rest of the client (ADR-0003); a non-ok status is a real error, since both
 * routes require a session.
 */

export async function fetchCurrencies(): Promise<CurrenciesResponse> {
  const response = await fetch('/api/currencies', {
    headers: { accept: 'application/json' },
    credentials: 'same-origin',
  });
  if (!response.ok) {
    throw new Error(`GET /api/currencies failed with ${String(response.status)}`);
  }
  return (await response.json()) as CurrenciesResponse;
}

/** Record the signed-in player's display currency. Returns the code now in force. */
export async function putCurrency(currency: DisplayCurrency): Promise<DisplayCurrency> {
  const response = await fetch('/api/me/currency', {
    method: 'PUT',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify({ currency }),
  });
  if (!response.ok) {
    throw new Error(`PUT /api/me/currency failed with ${String(response.status)}`);
  }
  return ((await response.json()) as { currency: DisplayCurrency }).currency;
}
