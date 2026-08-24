import { createContext, useCallback, useContext, useMemo, useState } from 'react';

import type { ReactNode } from 'react';

/**
 * What the context panel is currently showing (App. H.4).
 *
 * ## Why this exists now
 *
 * H.4 asks for *"a context panel that never covers the world"*, and the shell has
 * had one since the beginning — as a hardcoded paragraph saying selection detail
 * *would* appear there. Nothing ever selected into it. `FleetPage` grew its own
 * inline detail panel underneath its table instead, which is a perfectly good
 * pattern and is not this one.
 *
 * So this is the first real occupant, built for the Crew page and deliberately
 * not shaped around it.
 *
 * ## A rendered node, not a discriminated union of every entity
 *
 * The obvious design is `{ kind: 'airframe', id }` and a switch in the panel that
 * knows how to render each kind. That was rejected: it would put fleet, network,
 * finance and crew rendering into one shell component, so every page's detail
 * view would import into the shell's bundle and every new selectable thing would
 * be a change to a file five other pages depend on.
 *
 * Instead a page supplies **its own rendered detail**, and the shell supplies the
 * frame, the heading and the dismissal. The `kind` is carried anyway — not for
 * rendering, but so that a page can tell *"my row is selected"* from *"somebody
 * else's is"* without comparing opaque ids, and so a future analytics or
 * deep-link layer has something stable to name.
 *
 * ## Clearing is the page's job as much as the shell's
 *
 * A selection outlives the route that made it unless somebody clears it, and a
 * crew pool shown while the player is looking at the fleet is worse than an empty
 * panel. Pages that select must clear on unmount; {@link useContextSelection}
 * returns `clear` for exactly that, and the Crew page's effect is the reference.
 */

export interface ContextSelection {
  /**
   * What sort of thing is selected.
   *
   * Not used to render — see above. Used so a page can recognise its own
   * selection, and so the shell can key its render off something meaningful.
   */
  kind: string;
  /** Stable within `kind`. A pool id, a base id, a training id. */
  id: string;
  /** Shown in the panel header, replacing the generic "Context". */
  title: string;
  /** Optional second line under the title — a base code, an airline, a date. */
  subtitle?: string;
  /** The detail itself, rendered by whichever page owns the thing. */
  body: ReactNode;
}

interface ContextSelectionStore {
  selection: ContextSelection | null;
  select: (selection: ContextSelection) => void;
  clear: () => void;
}

const ContextSelectionContext = createContext<ContextSelectionStore | null>(null);

export function ContextSelectionProvider({ children }: { children: ReactNode }): ReactNode {
  const [selection, setSelection] = useState<ContextSelection | null>(null);

  const clear = useCallback(() => {
    setSelection(null);
  }, []);
  const select = useCallback((next: ContextSelection) => {
    setSelection(next);
  }, []);

  const value = useMemo<ContextSelectionStore>(
    () => ({ selection, select, clear }),
    [selection, select, clear],
  );

  return (
    <ContextSelectionContext.Provider value={value}>{children}</ContextSelectionContext.Provider>
  );
}

/**
 * Read and write the context panel's selection.
 *
 * Safe outside the provider: a page rendered on its own in a test gets a store
 * that accepts selections and drops them. That is deliberate — a component test
 * for a table should not have to mount the whole shell to click a row, and a
 * missing provider is a layout fact rather than a bug in the page.
 */
export function useContextSelection(): ContextSelectionStore {
  const store = useContext(ContextSelectionContext);
  return store ?? FALLBACK;
}

const FALLBACK: ContextSelectionStore = {
  selection: null,
  select: () => undefined,
  clear: () => undefined,
};
