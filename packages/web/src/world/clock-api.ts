import type { WorldClock } from '@tailfin/shared';

function isWorldClock(value: unknown): value is WorldClock {
  if (typeof value !== 'object' || value === null) return false;
  const body = value as Record<string, unknown>;
  return (
    typeof body.worldId === 'string' &&
    typeof body.serverTime === 'string' &&
    typeof body.inGameTime === 'string' &&
    typeof body.speedMultiplier === 'number'
  );
}

/**
 * Read the active world's clock.
 *
 * A player with no airline yet has no world, so the endpoint answers 409 through
 * the airline boundary. That is an ordinary state on the World page — the globe
 * renders before anybody founds anything — so it resolves to `null` rather than
 * throwing. Anything else is a real failure and is thrown.
 */
export async function fetchWorldClock(): Promise<WorldClock | null> {
  const response = await fetch('/api/world/clock', {
    headers: { accept: 'application/json' },
    credentials: 'same-origin',
  });
  if (response.status === 401 || response.status === 409) return null;
  if (!response.ok) {
    throw new Error(`GET /api/world/clock failed with ${String(response.status)}`);
  }
  const body: unknown = await response.json();
  if (!isWorldClock(body)) throw new Error('GET /api/world/clock returned an unexpected body');
  return body;
}
