import { useState } from 'react';
import { NavLink, Outlet } from 'react-router';

import { useTheme } from '../theme/ThemeProvider';

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

function LeftRail(): ReactNode {
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

/**
 * Placeholder for the world renderer. M7-01 replaces this with deck.gl's
 * MapView/GlobeView; the grid lines exist only so the area reads as "the world
 * goes here" rather than as a broken layout.
 */
function WorldBackdrop({ children }: { children: ReactNode }): ReactNode {
  return (
    <main className="world" aria-label="World">
      <div className="world__grid" aria-hidden="true" />
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
function StatusStrip(): ReactNode {
  return (
    <div className="strip" aria-label="Status">
      <div className="strip__item">
        <span className="strip__label">Cash</span>
        <span className="strip__value figure">—</span>
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
    </div>
  );
}

export function AppShell(): ReactNode {
  const [panelOpen, setPanelOpen] = useState(true);

  return (
    <div className="shell">
      <LeftRail />
      <WorldBackdrop>
        <Outlet />
      </WorldBackdrop>
      <ContextPanel open={panelOpen} onToggle={() => setPanelOpen((open) => !open)} />
      <StatusStrip />
    </div>
  );
}
