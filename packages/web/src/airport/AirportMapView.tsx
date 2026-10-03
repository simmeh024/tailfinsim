import type { ReactNode } from 'react';

/**
 * The airport map (M7-07, App. B.7) — **placeholder with the final props**.
 *
 * This file fixes the boundary between the two halves of M7-07 so they can be
 * built in parallel: the schematic itself replaces the body of this component,
 * and the world map's zoom hand-off renders it through exactly these props.
 */
export interface AirportMapViewProps {
  /** The airport, by `icao_code`. */
  icao: string;
  /**
   * Leave the airport map, back to the world map centred on this airport.
   *
   * Called when the player zooms out past the schematic's widest view — the
   * continuous half of §H.2's *"world → region → terminal area → airport map"* —
   * or uses the explicit back control.
   */
  onExit: () => void;
}

export function AirportMapView({ icao }: AirportMapViewProps): ReactNode {
  return (
    <section className="airport-map" aria-label={`Airport map: ${icao}`}>
      <h2>{icao}</h2>
    </section>
  );
}
