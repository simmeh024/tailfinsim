/**
 * The airport most of an airline's routes touch (UX pass).
 *
 * The Gates and Slots views used to open on the alphabetically first airport the
 * airline flies to, so a player whose hub is EHAM landed on EDDF, an outstation
 * with one route, and had to find their own hub in a list. On any network grown
 * from a hub, the airport the most routes touch **is** the hub. The answer is
 * read off the routes the page already holds, so it costs no fetch. Ties go to
 * the alphabetically first, so the choice is the same on every render.
 */
export function busiestAirport(
  routes: readonly { originIcao: string; destinationIcao: string }[],
): string | null {
  const touches = new Map<string, number>();
  for (const route of routes) {
    for (const code of new Set([route.originIcao, route.destinationIcao])) {
      touches.set(code, (touches.get(code) ?? 0) + 1);
    }
  }
  let best: string | null = null;
  let most = 0;
  for (const [code, count] of [...touches].sort(([a], [b]) => a.localeCompare(b))) {
    if (count > most) {
      best = code;
      most = count;
    }
  }
  return best;
}
