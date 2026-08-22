import { useCallback, useEffect, useState } from 'react';
import { NavLink, Outlet } from 'react-router';

import type { OwnAirlineResponse } from '@tailfin/shared';

import { fetchOwnAirline, formatMinorUnits } from '../airline/api';
import { AccountBadge } from '../auth/AccountBadge';
import { useTheme } from '../theme/ThemeProvider';
import { BuildBadge } from '../version/BuildBadge';
import { WorldRenderer } from '../world/WorldRenderer';

import type { ReactNode } from 'react';

/**
 * The app shell from App. H.4.
 *
 * Layout is a CSS grid of four named areas: rail, world, panel, strip. The world
 * is a real grid area rather than a fixed-position backdrop, so the panel takes
 * space from it instead of covering it — H.4 requires a context panel "that
 * never covers the world".
 *
 * Route content renders *inside* the world area via `<Outlet />`, which is why
 * the world is always visible behind the UI.
 */

interface NavItem {
  to: string;
  label: string;
  /** A character rather than an icon font — no external requests, and it scales with text. */
  glyph: string;
}

/** The seven destinations named in App. H.4, in the doc's order. */
export const NAV_ITEMS: readonly NavItem[] = [
  { to: '/world', label: 'World', glyph: '◎' },
  { to: '/fleet', label: 'Fleet', glyph: '✈' },
  { to: '/network', label: 'Network', glyph: '⤳' },
  { to: '/finance', label: 'Finance', glyph: '§' },
  { to: '/crew', label: 'Crew', glyph: '☰' },
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

function WorldBackdrop({ children }: { children: ReactNode }): ReactNode {
  return (
    <main className="world" aria-label="World">
      <WorldRenderer />
      {children}
    </main>
  );
}

function ContextPanel({ open, onToggle }: { open: boolean; onToggle: () => void }): ReactNode {
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
        <h2 className="panel__title">Context</h2>
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
        <p>
          Selection detail appears here — a flight, an airframe, a route. Empty until there is
          something to select.
        </p>
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

  useEffect(() => {
    void loadOwnAirline();
  }, [loadOwnAirline]);

  const outletContext: OwnAirlineShellContext = {
    ownAirline,
    ownAirlineLoading,
    ownAirlineError,
    replaceOwnAirline: setOwnAirline,
    reloadOwnAirline: loadOwnAirline,
  };

  return (
    <div className="shell">
      <LeftRail ownAirline={ownAirline} />
      <WorldBackdrop>
        <Outlet context={outletContext} />
      </WorldBackdrop>
      <ContextPanel open={panelOpen} onToggle={() => setPanelOpen((open) => !open)} />
      <StatusStrip ownAirline={ownAirline} />
    </div>
  );
}

/** Shared request state for pages rendered inside the player shell. */
export interface OwnAirlineShellContext {
  ownAirline: OwnAirlineResponse | null;
  ownAirlineLoading: boolean;
  ownAirlineError: boolean;
  replaceOwnAirline: (value: OwnAirlineResponse) => void;
  reloadOwnAirline: () => Promise<void>;
}
