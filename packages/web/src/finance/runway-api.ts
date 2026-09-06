import { CashRunwayResponse } from '@tailfin/shared';

/**
 * The cash runway the status strip reads (§13.6, M8-08).
 *
 * **Never rejects, and never throws.** The strip is on every page and on a
 * timer, so anything that escapes here takes the whole app down rather than one
 * panel — and an unhandled rejection from a polling timer is the worst-behaved
 * version of that, because it fires again a minute later. A refusal, an
 * unreachable server and a body that does not parse all mean the same thing to a
 * strip: the runway is unknown, and it renders as one.
 *
 * The body is parsed rather than cast, for the reason the `/service`
 * configurator learned in M8-05: a 200 whose shape has moved is not a success.
 */
export async function fetchCashRunway(): Promise<CashRunwayResponse | null> {
  try {
    const response = await fetch('/api/finance/runway', {
      headers: { accept: 'application/json' },
      credentials: 'same-origin',
    });
    if (!response.ok) return null;
    const parsed = CashRunwayResponse.safeParse(await response.json());
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
