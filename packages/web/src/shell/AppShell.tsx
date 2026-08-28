import { useCallback, useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router';

import type {
  ExecutiveFloorState,
  OfficeSeatId,
  OfficeStateResponse,
  OwnAirlineResponse,
} from '@tailfin/shared';

import { fetchOwnAirline, formatMinorUnits } from '../airline/api';
import { AccountBadge } from '../auth/AccountBadge';
import {
  expandOffice,
  fetchExecutiveFloor,
  fetchOffice,
  unlockExecutiveFloor,
  unlockExecutiveOffice,
} from '../hq/api';
import { HqLayoutPanel, type ExpandResult } from '../hq/HqLayoutPanel';
import { useTheme } from '../theme/ThemeProvider';
import { BuildBadge } from '../version/BuildBadge';

import { ContextSelectionProvider, useContextSelection } from './context-selection';

import type { ReactNode } from 'react';

/**
 * The app shell from App. H.4.
 *
 * Layout is a CSS grid of four named areas: rail, stage, panel, strip. The stage
 * is a real grid area rather than a fixed-position backdrop, so the panel takes
 * space from it instead of covering it — H.4 requires a context panel "that
 * never covers the world".
 *
 * ## The world is a page, not a backdrop
 *
 * H.4 describes the world as permanently visible behind every screen, and this
 * shell used to render the world renderer here with `<Outlet />` on top of it.
 * That read as the doc's intent and behaved nothing like it: a fleet table is
 * opaque, so the world underneath was invisible and unreachable — the page
 * content took every drag — while still costing a WebGL context and its frames
 * on screens that never showed it.
 *
 * So the renderer belongs to `WorldPage`, which is the world at full size with
 * nothing over it. Every other route gets the plain inset background. A shared
 * backdrop can come back if it is ever built as one — translucent page surfaces,
 * pointer events reaching through — but that is a design decision, not the
 * accident this was.
 */

interface NavItem {
  to: string;
  label: string;
  /** A character rather than an icon font — no external requests, and it scales with text. */
  glyph: string;
}

/**
 * The console's destinations, in the doc's order. App. H.4 named seven; M5-04's
 * Headquarters sits between Crew and Design as the eighth, the office-hires page.
 */
export const NAV_ITEMS: readonly NavItem[] = [
  { to: '/world', label: 'World', glyph: '◎' },
  { to: '/fleet', label: 'Fleet', glyph: '✈' },
  { to: '/network', label: 'Network', glyph: '⤳' },
  { to: '/finance', label: 'Finance', glyph: '§' },
  { to: '/crew', label: 'Crew', glyph: '☰' },
  { to: '/headquarters', label: 'Headquarters', glyph: '⌂' },
  { to: '/design', label: 'Design', glyph: '◆' },
  { to: '/board', label: 'Board', glyph: '▤' },
];

function LeftRail({ ownAirline }: { ownAirline: OwnAirlineResponse | null }): ReactNode {
  const { theme, toggleTheme } = useTheme();

  return (
    <nav className="rail" aria-label="Main">
      <div className="rail__brand">
        <span className="rail__mark" aria-hidden="true">
          ◤
        </span>
        <span>Tailfin</span>
      </div>

      {NAV_ITEMS.map((item) => (
        <NavLink key={item.to} to={item.to} className="rail__link">
          <span className="rail__glyph" aria-hidden="true">
            {item.glyph}
          </span>
          <span>{item.label}</span>
        </NavLink>
      ))}

      <div className="rail__spacer" />

      <AccountBadge airlineName={ownAirline?.airline?.name ?? null} />

      <button
        type="button"
        className="rail__theme"
        onClick={toggleTheme}
        // The control announces what it will do, not what the current state is.
        aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
      >
        <span aria-hidden="true">{theme === 'dark' ? '☾' : '☀'}</span>
        <span>{theme === 'dark' ? 'Dark' : 'Light'}</span>
      </button>
    </nav>
  );
}

/** The route's own area. Named `stage` because it is no longer only the world. */
function Stage({ children }: { children: ReactNode }): ReactNode {
  return <main className="stage">{children}</main>;
}

/**
 * The context panel (App. H.4), now with an occupant.
 *
 * ## The office layout is the panel's home, not an empty placeholder
 *
 * H.4's panel used to sit empty until a page selected something. It now shows
 * the {@link HqLayoutPanel} — a floor-plan of the office seats and the unlocks
 * the airline holds — as its **default** state, on every screen. A page that
 * selects something (a crew pool, an airframe) takes the panel over while that
 * selection stands, and clearing it returns to the office layout rather than to
 * a blank slate. So there is always something to look at, and it is the one thing
 * every page wants nearby.
 *
 * Two dismissals, and they are different. The × closes the *panel*, which is a
 * layout preference and survives navigation. "Clear" drops the *selection* and
 * leaves the panel open — the player wanted the panel, they just finished with
 * that row. Collapsing the panel because a selection ended would take away
 * something they did not ask to lose.
 */
function ContextPanel({
  open,
  onToggle,
  office,
  onExpand,
  selectedOffice,
  onSelectOffice,
  execFloor,
  onUnlockExecFloor,
  onOpenExecOffice,
  selectedExecOffice,
  onSelectExecOffice,
}: {
  open: boolean;
  onToggle: () => void;
  office: OfficeStateResponse | null;
  onExpand: () => Promise<ExpandResult>;
  /** The office the Headquarters page is managing, so its room stays highlighted. */
  selectedOffice: OfficeSeatId | null;
  /** Pick an office on the plan — the Headquarters page opens its drawer on it. */
  onSelectOffice: (seat: OfficeSeatId) => void;
  /** The executive floor's state — the same the C-Suite page reads. */
  execFloor: ExecutiveFloorState | null;
  onUnlockExecFloor: () => Promise<ExpandResult>;
  onOpenExecOffice: () => Promise<ExpandResult>;
  /** The executive office the C-Suite page is managing (its drawer). */
  selectedExecOffice: number | null;
  /** Pick an executive office on the plan — the C-Suite page opens its drawer on it. */
  onSelectExecOffice: (index: number | null) => void;
}): ReactNode {
  const { selection, clear, attachPanelBody } = useContextSelection();
  const pathname = useLocation().pathname;
  // The Head Office floor-plan is the panel's home on the two office screens —
  // Headquarters (defaulting to the ground floor) and the C-Suite (defaulting to
  // the executive floor). Both get the same panel and the same floor pager;
  // elsewhere the panel is the plain selection surface it started as.
  const onHeadquarters = pathname.startsWith('/headquarters');
  const onCSuite = pathname.startsWith('/c-suite');
  const onOfficeScreen = onHeadquarters || onCSuite;

  if (!open) {
    return (
      <button type="button" className="panel__reopen" onClick={onToggle}>
        Show panel
      </button>
    );
  }

  return (
    <aside className="panel" aria-label="Context">
      <div className="panel__header">
        <div className="panel__heading">
          <h2
            id="context-panel-title"
            className="panel__title"
            tabIndex={selection === null ? undefined : -1}
          >
            {selection?.title ?? (onOfficeScreen ? 'Head Office' : 'Context')}
          </h2>
          {selection?.subtitle !== undefined && (
            <p className="panel__subtitle">{selection.subtitle}</p>
          )}
        </div>
        {selection !== null && (
          <button
            type="button"
            className="panel__dismiss"
            onClick={() => {
              selection.onClear?.();
              clear();
            }}
            aria-label="Clear selection"
          >
            ⌫
          </button>
        )}
        <button
          type="button"
          className="panel__dismiss"
          onClick={onToggle}
          aria-label="Dismiss panel"
        >
          ×
        </button>
      </div>
      <div className="panel__body">
        {selection === null ? (
          onOfficeScreen ? (
            <HqLayoutPanel
              office={office}
              onExpand={onExpand}
              onSelectSeat={onSelectOffice}
              selectedSeat={selectedOffice}
              initialFloor={onCSuite ? 'executive' : 'ground'}
              execFloor={execFloor}
              onUnlockExecFloor={onUnlockExecFloor}
              onOpenExecOffice={onOpenExecOffice}
              selectedExecOffice={selectedExecOffice}
              onSelectExecOffice={onSelectExecOffice}
            />
          ) : (
            <p>
              Selection detail appears here — a flight, an airframe, a route. Empty until there is
              something to select.
            </p>
          )
        ) : selection.body === null ? (
          <div className="panel__portal" ref={attachPanelBody} />
        ) : (
          selection.body
        )}
      </div>
    </aside>
  );
}

/**
 * Bottom status strip: cash, cash runway, aircraft airborne, alerts (H.4).
 *
 * Values are placeholders. The markup is not: figures carry `.figure` for
 * tabular numerals so they will not jitter as they tick, and status uses the
 * `.status--*` classes, which pair colour with a glyph so meaning survives
 * without hue (H.4, H.7).
 */
function StatusStrip({ ownAirline }: { ownAirline: OwnAirlineResponse | null }): ReactNode {
  return (
    <div className="strip" aria-label="Status">
      <div className="strip__item">
        <span className="strip__label">Cash</span>
        <span className="strip__value figure">
          {ownAirline?.airline ? formatMinorUnits(ownAirline.airline.cash) : '—'}
        </span>
      </div>
      <div className="strip__item">
        <span className="strip__label">Runway</span>
        <span className="strip__value figure">— days</span>
      </div>
      <div className="strip__item">
        <span className="strip__label">Airborne</span>
        <span className="strip__value figure">0</span>
      </div>
      <div className="strip__item">
        <span className="strip__label">Alerts</span>
        <span className="strip__value status status--ontime">None</span>
      </div>

      {/* Pushed to the far right of the bottom strip — the corner of the page. */}
      <div className="strip__spacer" />
      <BuildBadge />
    </div>
  );
}

export function AppShell(): ReactNode {
  const [panelOpen, setPanelOpen] = useState(true);
  const [ownAirline, setOwnAirline] = useState<OwnAirlineResponse | null>(null);
  const [ownAirlineLoading, setOwnAirlineLoading] = useState(true);
  const [ownAirlineError, setOwnAirlineError] = useState(false);
  // The office state behind the always-on context panel. `fetchOffice` answers
  // null for a player with no airline yet, which the layout renders as six vacant
  // seats — so the panel is present from the first screen. The Headquarters page
  // pushes fresh state here through `replaceOffice` after every hire, so the panel
  // updates in lock-step with a change made while it is on screen.
  const [office, setOffice] = useState<OfficeStateResponse | null>(null);
  // Which office the player is managing from the plan. It lives here because the
  // interactive plan is the context panel, which the shell owns; the Headquarters
  // page reads it to open its drawer and clears it on a hire or on unmount.
  const [selectedOffice, setSelectedOffice] = useState<OfficeSeatId | null>(null);
  // The executive floor is the panel's second floor, owned here for the same
  // reason the ground floor is: the plan that manages it is the shell's context
  // panel, and the C-Suite page reads the same state so the roster and the plan
  // never disagree. `selectedExecOffice` is the office the C-Suite drawer is on.
  const [execFloor, setExecFloor] = useState<ExecutiveFloorState | null>(null);
  const [selectedExecOffice, setSelectedExecOffice] = useState<number | null>(null);

  const loadOwnAirline = useCallback(async () => {
    setOwnAirlineLoading(true);
    setOwnAirlineError(false);
    try {
      setOwnAirline(await fetchOwnAirline());
    } catch {
      setOwnAirlineError(true);
    } finally {
      setOwnAirlineLoading(false);
    }
  }, []);

  const loadOffice = useCallback(async () => {
    setOffice(await fetchOffice());
  }, []);

  const loadExecFloor = useCallback(async () => {
    setExecFloor(await fetchExecutiveFloor());
  }, []);

  // Buying an expansion moves real money, so it lives with the office state the
  // shell owns; the panel drives it and shows the result. Success replaces the
  // office in place, so the plan grows without a refetch.
  const onExpand = useCallback(async (): Promise<ExpandResult> => {
    const outcome = await expandOffice();
    if (outcome.ok) {
      setOffice(outcome.state);
      return { ok: true };
    }
    return { ok: false, message: outcome.failure.message };
  }, []);

  // Opening the executive floor and its offices both move money, so they live with
  // the exec state the shell owns, exactly like expansion — the plan drives them
  // and the C-Suite page sees the result through the shared state.
  const onUnlockExecFloor = useCallback(async (): Promise<ExpandResult> => {
    const outcome = await unlockExecutiveFloor();
    if (outcome.ok) {
      setExecFloor(outcome.state);
      return { ok: true };
    }
    return { ok: false, message: outcome.failure.message };
  }, []);

  const onOpenExecOffice = useCallback(async (): Promise<ExpandResult> => {
    const outcome = await unlockExecutiveOffice();
    if (outcome.ok) {
      setExecFloor(outcome.state);
      return { ok: true };
    }
    return { ok: false, message: outcome.failure.message };
  }, []);

  useEffect(() => {
    void loadOwnAirline();
    void loadOffice();
    void loadExecFloor();
  }, [loadOwnAirline, loadOffice, loadExecFloor]);

  const outletContext: OwnAirlineShellContext = {
    ownAirline,
    ownAirlineLoading,
    ownAirlineError,
    replaceOwnAirline: setOwnAirline,
    reloadOwnAirline: loadOwnAirline,
    office,
    replaceOffice: setOffice,
    reloadOffice: loadOffice,
    selectedOffice,
    selectOffice: setSelectedOffice,
    execFloor,
    replaceExecFloor: setExecFloor,
    reloadExecFloor: loadExecFloor,
    selectedExecOffice,
    selectExecOffice: setSelectedExecOffice,
  };

  return (
    <ContextSelectionProvider>
      <div className="shell">
        <LeftRail ownAirline={ownAirline} />
        <Stage>
          <Outlet context={outletContext} />
        </Stage>
        <ContextPanel
          open={panelOpen}
          onToggle={() => setPanelOpen((open) => !open)}
          office={office}
          onExpand={onExpand}
          selectedOffice={selectedOffice}
          onSelectOffice={setSelectedOffice}
          execFloor={execFloor}
          onUnlockExecFloor={onUnlockExecFloor}
          onOpenExecOffice={onOpenExecOffice}
          selectedExecOffice={selectedExecOffice}
          onSelectExecOffice={setSelectedExecOffice}
        />
        <StatusStrip ownAirline={ownAirline} />
      </div>
    </ContextSelectionProvider>
  );
}

/** Shared request state for pages rendered inside the player shell. */
export interface OwnAirlineShellContext {
  ownAirline: OwnAirlineResponse | null;
  ownAirlineLoading: boolean;
  ownAirlineError: boolean;
  replaceOwnAirline: (value: OwnAirlineResponse) => void;
  reloadOwnAirline: () => Promise<void>;
  /** The office behind the context panel; null until loaded or when unfounded. */
  office: OfficeStateResponse | null;
  /** Push a fresh office state (e.g. the response to a hire) into the panel. */
  replaceOffice: (value: OfficeStateResponse | null) => void;
  reloadOffice: () => Promise<void>;
  /**
   * The office selected on the panel's interactive plan, or null. The
   * Headquarters page reads it to open its staffing drawer on that room.
   */
  selectedOffice: OfficeSeatId | null;
  /** Select an office (or clear with null). The plan and the page share this. */
  selectOffice: (seat: OfficeSeatId | null) => void;
  /** The executive floor behind the panel; null until loaded or when unfounded. */
  execFloor: ExecutiveFloorState | null;
  /** Push a fresh executive-floor state (a hire, a fire, an unlock) into the panel. */
  replaceExecFloor: (value: ExecutiveFloorState | null) => void;
  reloadExecFloor: () => Promise<void>;
  /**
   * The executive office selected on the plan, or null. The C-Suite page reads it
   * to open its staffing drawer on that office.
   */
  selectedExecOffice: number | null;
  /** Select an executive office by index (or clear with null). Shared plan ↔ page. */
  selectExecOffice: (index: number | null) => void;
}
