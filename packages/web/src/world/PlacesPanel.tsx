import { useEffect, useRef, useState } from 'react';

import { nextIndex, type PlaceRow } from './places';

import type { KeyboardEvent, ReactNode } from 'react';

/**
 * The map, as a list you can operate (WORLD-08).
 *
 * ## Roving tabindex rather than sixty tab stops
 *
 * One row is tabbable at a time and the arrow keys move between them, which is
 * the standard listbox behaviour and the only one that keeps the rest of the
 * page reachable: sixty focusable buttons would put sixty presses between the
 * list and whatever follows it.
 *
 * `Home` and `End` jump, because a list bounded at sixty rows is still long
 * enough to be tedious an arrow at a time.
 *
 * ## Escape returns focus rather than dropping it
 *
 * Closing a panel while focus is inside it leaves focus on nothing, and the next
 * `Tab` starts again from the top of the document. Focus goes back to the
 * control that opened it.
 */

export interface PlacesPanelProps {
  airports: readonly PlaceRow[];
  flights: readonly PlaceRow[];
  /** Whether the airport list was cut short, so the panel can say so. */
  truncated: boolean;
  onSelect: (row: PlaceRow) => void;
  onClose: () => void;
}

export function PlacesPanel({
  airports,
  flights,
  truncated,
  onSelect,
  onClose,
}: PlacesPanelProps): ReactNode {
  const rows = [...airports, ...flights];
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement | null>(null);

  // Focus the list on open, so a keyboard reaches it without hunting for it.
  useEffect(() => {
    listRef.current?.querySelector<HTMLButtonElement>('button[tabindex="0"]')?.focus();
    // Only on mount: moving focus whenever the rows change would steal it back
    // from wherever the reader had gone while the map refreshed underneath.
  }, []);

  const index = Math.min(active, Math.max(0, rows.length - 1));

  const focusRow = (next: number): void => {
    setActive(next);
    const id = rows[next]?.id;
    if (id === undefined) return;
    listRef.current?.querySelector<HTMLButtonElement>(`[data-row="${CSS.escape(id)}"]`)?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
      return;
    }
    const step =
      event.key === 'ArrowDown'
        ? 1
        : event.key === 'ArrowUp'
          ? -1
          : event.key === 'Home'
            ? -rows.length
            : event.key === 'End'
              ? rows.length
              : 0;
    if (step === 0) return;
    event.preventDefault();
    focusRow(nextIndex(index, step, rows.length));
  };

  return (
    <div className="world-places" role="group" aria-label="Places on the map">
      <div className="world-places__head">
        <p className="world-renderer__route-eyebrow">Places</p>
        <button
          type="button"
          className="world-renderer__route-close"
          aria-label="Close places"
          onClick={onClose}
        >
          ×
        </button>
      </div>

      {rows.length === 0 ? (
        <p className="world-renderer__route-muted">
          Nothing in view. Zoom out, or pan to somewhere served.
        </p>
      ) : (
        <div ref={listRef} onKeyDown={onKeyDown} className="world-places__list">
          <ul aria-label="Airports in view">
            {airports.map((row, position) => (
              <li key={row.id}>
                <button
                  type="button"
                  data-row={row.id}
                  tabIndex={rows[index]?.id === row.id ? 0 : -1}
                  onFocus={() => setActive(position)}
                  onClick={() => onSelect(row)}
                >
                  <span className="world-places__label">{row.label}</span>
                  <span className="world-renderer__route-code">{row.detail}</span>
                </button>
              </li>
            ))}
          </ul>

          {flights.length > 0 && (
            <ul aria-label="Flights in view">
              {flights.map((row, position) => (
                <li key={row.id}>
                  <button
                    type="button"
                    data-row={row.id}
                    tabIndex={rows[index]?.id === row.id ? 0 : -1}
                    onFocus={() => setActive(airports.length + position)}
                    onClick={() => onSelect(row)}
                  >
                    <span className="world-places__label">{row.label}</span>
                    <span className="world-renderer__route-code">{row.detail}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {truncated && (
        <p className="world-renderer__legend-note">
          The busiest in view. Zoom in for the smaller fields.
        </p>
      )}
    </div>
  );
}
