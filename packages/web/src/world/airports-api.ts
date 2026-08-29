import type { WorldAirport } from './layers';

/**
 * Every served airport/city, for the world map's airport layer.
 *
 * Reference data behind a session, not world state, so it needs no airline and is
 * the same for everyone. It is a nice-to-have layer on a map that already renders
 * without it, so a failure — no session yet, a transport error — resolves to an
 * empty list rather than throwing: the globe stays up, just without dots.
 */
export async function fetchWorldAirports(): Promise<WorldAirport[]> {
  let response: Response;
  try {
    response = await fetch('/api/world/airports', {
      headers: { accept: 'application/json' },
      credentials: 'same-origin',
    });
  } catch {
    return [];
  }
  if (!response.ok) return [];
  const body: unknown = await response.json().catch(() => null);
  const airports = (body as { airports?: unknown } | null)?.airports;
  return Array.isArray(airports) ? (airports as WorldAirport[]) : [];
}
