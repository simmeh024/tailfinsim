import { useEffect, useRef, useState } from 'react';

import { nextIndex, SEARCH_MINIMUM, type PlaceRow } from './places';

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
  /** What a query matches, over every served airport rather than what is in view. */
  onSearch: (query: string) => PlaceRow[];
  /**
   * Why there are no aeroplanes, when there are none and there are routes.
   *
   * An empty sky over a drawn network reads as a broken map rather than as a
   * world where nothing happens to be flying — and on a node with no worker
   * that is the *permanent* state. `null` when there is nothing to explain.
   */
  airborneNote: string | null;
  onSelect: (row: PlaceRow) => void;
  onClose: () => void;
}

export function PlacesPanel({
  airports,
  flights,
  truncated,
  onSearch,
  airborneNote,
  onSelect,
  onClose,
}: PlacesPanelProps): ReactNode {
  const [query, setQuery] = useState('');
  const searching = query.trim().length >= SEARCH_MINIMUM;
  const results = searching ? onSearch(query) : [];

  /*
   * Searching replaces the list rather than filtering it.
   *
   * The list is bounded by the camera on purpose; search is the opposite, since
   * the whole point of typing "Heathrow" is that you are not looking at it. So
   * while there is a query, these rows are the whole world's answer — and the
   * flights section goes away, because a flight is not something you search for
   * by name.
   */
  const rows = searching ? results : [...airports, ...flights];
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

  /*
   * The field hands over to the list rather than trapping the arrows.
   *
   * `ArrowDown` from the box moves into the results and `Enter` takes the first
   * one, which is what every search field a player has ever used does — and
   * without it the only way from the query to a result is the mouse, which is
   * the thing this whole issue is about.
   */
  const onQueryKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key === 'ArrowDown' && rows.length > 0) {
      event.preventDefault();
      focusRow(0);
      return;
    }
    if (event.key === 'Enter' && rows[0] !== undefined) {
      event.preventDefault();
      onSelect(rows[0]);
    }
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

      <label className="world-places__search">
        <span className="visually-hidden">Search airports</span>
        <input
          type="search"
          value={query}
          placeholder="Find an airport"
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={onQueryKeyDown}
        />
      </label>

      {rows.length === 0 ? (
        <p className="world-renderer__route-muted">
          {searching
            ? `Nothing matches “${query.trim()}”.`
            : 'Nothing in view. Zoom out, or pan to somewhere served.'}
        </p>
      ) : (
        <div ref={listRef} onKeyDown={onKeyDown} className="world-places__list">
          <ul aria-label={searching ? 'Search results' : 'Airports in view'}>
            {(searching ? results : airports).map((row, position) => (
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

          {!searching && flights.length > 0 && (
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

      {/* Outside the list, because it explains an *absence* — and when there is
          nothing in view at all the list is not rendered to hold it. */}
      {!searching && flights.length === 0 && airborneNote !== null && (
        <p className="world-renderer__route-muted">{airborneNote}</p>
      )}

      {!searching && truncated && (
        <p className="world-renderer__legend-note">
          The busiest in view. Zoom in for the smaller fields.
        </p>
      )}
    </div>
  );
}
