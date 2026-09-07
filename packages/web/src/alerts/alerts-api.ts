import { AlertsResponse, DigestResponse, MarkDigestReadResponse } from '@tailfin/shared';

/**
 * §14.5's alerts and §3.2's digest, from the client's side (M8-13).
 *
 * **Nothing here rejects or throws.** The alert count is in the status strip, on
 * every page and on a timer, so anything that escapes takes the whole app down
 * rather than one figure — and an unhandled rejection from a polling timer is
 * the worst-behaved version of that, because it fires again a minute later.
 * M8-08's runway client learned this the same way; it is the same rule and the
 * same shape.
 *
 * Every body is **parsed rather than cast**: a 200 whose shape has moved is not
 * a success, and an alert list is the last place to render `undefined` as though
 * it were news.
 */

async function read<T>(
  path: string,
  schema: { safeParse: (input: unknown) => { success: true; data: T } | { success: false } },
): Promise<T | null> {
  try {
    const response = await fetch(path, {
      headers: { accept: 'application/json' },
      credentials: 'same-origin',
    });
    if (!response.ok) return null;
    const parsed = schema.safeParse(await response.json());
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export async function fetchAlerts(): Promise<AlertsResponse | null> {
  return read('/api/alerts', AlertsResponse);
}

export async function fetchDigest(): Promise<DigestResponse | null> {
  return read('/api/digest', DigestResponse);
}

/**
 * Acknowledge a digest, echoing the window's own upper bound.
 *
 * The `throughAt` is the `window.toAt` the player was actually shown, so the
 * acknowledgement can never reach past an event nobody saw — the server clamps
 * it to its own game time and only moves the watermark forward. Answers null on
 * any failure, which the banner treats as *stay open*: leaving a digest visible
 * is a much smaller wrong than silently discarding a week of news.
 */
export async function markDigestRead(throughAt: string): Promise<MarkDigestReadResponse | null> {
  try {
    const response = await fetch('/api/digest/read', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ throughAt }),
    });
    if (!response.ok) return null;
    const parsed = MarkDigestReadResponse.safeParse(await response.json());
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
