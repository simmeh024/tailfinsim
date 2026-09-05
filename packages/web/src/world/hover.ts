import type { HoverPoint, WorldAirport } from './layers';
import type { WorldMapTrafficRoute } from './map-api';

/**
 * What the pointer is over, and where to draw the label saying so (WORLD-03).
 *
 * ## Why the map needed this at all
 *
 * The world draws roughly four thousand airports — every airport with a
 * classified tier, which is the set that has a demand pool and can be a route
 * endpoint. Until now hovering any of them did nothing: there was no
 * `getTooltip`, no `onHover` and no cursor feedback anywhere in this folder, so
 * the only way to learn that a dot was Heathrow was to click it and open a
 * panel over the corner of the map.
 *
 * ## Why it is our own label rather than deck.gl's `getTooltip`
 *
 * deck.gl will render a tooltip for us, and it would have been three lines. But
 * it is styled through an inline `style` object, which puts colours in a `.ts`
 * file — and this repository fails the build for a colour literal outside
 * `tokens.css`, deliberately. A themed label is a DOM element with a class, so
 * that is what this is. It also means the label can be tested by looking at the
 * page rather than by trusting a library's own rendering.
 */

export interface HoverLabel {
  /** The thing itself: an airport's name, or a carrier's. */
  title: string;
  /** One line under it: codes and tier, or the leg being flown. */
  detail: string;
}

/** `EGLL · LHR`, or just the ICAO for a field with no IATA code. */
export function airportCodes(airport: Pick<WorldAirport, 'icao' | 'iata'>): string {
  return airport.iata ? `${airport.icao} · ${airport.iata}` : airport.icao;
}

/** Tier as a reader would say it: "Flagship hub", "Regional field". */
function tierLabel(tier: string): string {
  switch (tier) {
    case 'flagship':
      return 'Flagship hub';
    case 'large':
      return 'Large airport';
    case 'medium':
      return 'Medium airport';
    case 'small':
      return 'Small airport';
    default:
      return 'Regional field';
  }
}

export function airportLabel(airport: WorldAirport): HoverLabel {
  return { title: airport.name, detail: `${airportCodes(airport)} · ${tierLabel(airport.tier)}` };
}

/**
 * A flight's label.
 *
 * The carrier leads, because "whose aeroplane is that?" is the question a plane
 * on a map provokes; the leg is the answer to the second one. The player's own
 * traffic says so rather than repeating their own airline name back at them.
 */
export function flightLabel(route: WorldMapTrafficRoute): HoverLabel {
  return {
    title: route.own ? 'Your flight' : route.airlineName,
    detail: `${route.originIcao} → ${route.destinationIcao}`,
  };
}

/**
 * Where to put the label, in canvas pixels.
 *
 * A label pinned to the pointer runs off the right edge of the map for anything
 * in the eastern half of it, and off the bottom for anything low — and the map
 * fills the stage, so there is no page scroll to rescue it. So it is anchored to
 * whichever edge it is nearer: the label grows *away* from the pointer, into the
 * space that exists.
 */
export interface TipPlacement {
  left?: number;
  right?: number;
  top?: number;
  bottom?: number;
}

/** Clear of the cursor, and clear of the dot under it. */
const GAP = 14;

export function tipPlacement({ x, y, width, height }: HoverPoint): TipPlacement {
  const placement: TipPlacement = {};
  if (width > 0 && x > width / 2) placement.right = Math.max(0, width - x) + GAP;
  else placement.left = Math.max(0, x) + GAP;
  if (height > 0 && y > height / 2) placement.bottom = Math.max(0, height - y) + GAP;
  else placement.top = Math.max(0, y) + GAP;
  return placement;
}
