import { useCallback, useEffect, useState } from 'react';

import type { ApronResponse } from '@tailfin/shared';

import { Button } from '../ui/Button';
import { StateBlock } from '../ui/StateBlock';
import { useWorldClock } from '../world/useWorldClock';

import { fetchApron } from './api';
import { ApronSchematic } from './ApronSchematic';

import type { ReactNode } from 'react';

import './airport.css';

/**
 * The airport map (M7-07, App. B.7).
 *
 * > *"Zoom from the world map into any airport you operate at. A clean 2D
 * > schematic — accurate in topology, stylised in geometry, in the house design
 * > language."*
 *
 * The last of §H.2's four zoom bands — *"world → region → terminal area →
 * airport map"* — and the only one that is not the world renderer. The world
 * map opens it through these two props and nothing else: the schematic
 * fetches its own picture, keeps its own camera, and hands the player back
 * through `onExit` when they zoom out past its widest view or press the back
 * control.
 *
 * ## The clock is the world's
 *
 * Turnaround rings and runway movements are measured against the game clock
 * `useWorldClock` runs in the browser between syncs — the hook the world map
 * itself uses — so a ring fills at the world's speed, not the wall clock's.
 * Until the first sync it falls back to the `gameNow` the apron was read at,
 * which is a still picture rather than a wrong one.
 *
 * ## It is re-read, slowly
 *
 * Aircraft arrive and leave while the map is open, so the apron is re-read on a
 * slow timer. A failed re-read keeps the last good picture: an airport map that
 * blanked whenever a request dropped would punish the player for leaving it
 * open.
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

/** How often the apron is re-read while open, in real milliseconds. */
export const APRON_REFRESH_MS = 60_000;

type Load =
  | { state: 'loading' }
  | { state: 'ready'; apron: ApronResponse }
  | { state: 'missing' }
  | { state: 'failed' };

export function AirportMapView({ icao, onExit }: AirportMapViewProps): ReactNode {
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const [heat, setHeat] = useState(false);
  const { inGameTime } = useWorldClock();

  const read = useCallback(
    (quietly: boolean) => {
      if (!quietly) setLoad({ state: 'loading' });
      void fetchApron(icao)
        .then((apron) => {
          setLoad(apron === null ? { state: 'missing' } : { state: 'ready', apron });
        })
        .catch(() => {
          // A quiet re-read that fails leaves the picture the player already has.
          if (!quietly) setLoad({ state: 'failed' });
        });
    },
    [icao],
  );

  useEffect(() => {
    read(false);
    const timer = globalThis.setInterval(() => {
      read(true);
    }, APRON_REFRESH_MS);
    return () => {
      globalThis.clearInterval(timer);
    };
  }, [read]);

  const apron = load.state === 'ready' ? load.apron : null;
  const now = inGameTime ?? (apron === null ? null : new Date(apron.gameNow));

  return (
    <section className="airport-map" aria-label={`Airport map: ${icao}`}>
      <header className="airport-map__bar">
        <div className="airport-map__title">
          <h2>{icao}</h2>
          {apron !== null && <p className="airport-map__name">{apron.name}</p>}
        </div>
        <div className="airport-map__controls">
          {apron !== null && (
            <Button
              size="sm"
              aria-pressed={heat}
              onClick={() => {
                setHeat((on) => !on);
              }}
            >
              Utilisation heat
            </Button>
          )}
          <Button size="sm" onClick={onExit}>
            ← Back to world map
          </Button>
        </div>
      </header>

      {load.state === 'loading' && <StateBlock kind="loading">Reading the apron…</StateBlock>}
      {load.state === 'missing' && (
        <StateBlock kind="empty">There is no airport with the code {icao}.</StateBlock>
      )}
      {load.state === 'failed' && (
        <StateBlock
          kind="broken"
          action={
            <Button
              size="sm"
              onClick={() => {
                read(false);
              }}
            >
              Try again
            </Button>
          }
        >
          Could not read this airport’s apron. Who holds which stand is unknown until it loads.
        </StateBlock>
      )}
      {apron !== null && now !== null && (
        <ApronSchematic
          apron={apron}
          now={now}
          heat={heat}
          onExit={onExit}
          onGates={(gates) => {
            // Folded into whatever the latest read is, so a re-read that landed
            // while the lease was in flight is not rolled back by it.
            setLoad((current) =>
              current.state === 'ready'
                ? { state: 'ready', apron: { ...current.apron, gates } }
                : current,
            );
          }}
        />
      )}
    </section>
  );
}
