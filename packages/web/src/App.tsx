import { Navigate, Route, Routes, useLocation } from 'react-router';

import { RequireSession } from './auth/RequireSession';
import { SessionProvider } from './auth/SessionProvider';
import {
  BoardPage,
  CrewPage,
  DesignPage,
  FinancePage,
  FleetPage,
  NetworkPage,
  WorldPage,
} from './routes/Placeholder';
import { AppShell } from './shell/AppShell';
import { ThemeProvider } from './theme/ThemeProvider';

import type { ReactNode } from 'react';

/**
 * Route table — the seven destinations from App. H.4.
 *
 * `/` redirects to `/world` rather than being its own route: the world is the
 * default view, and having two paths render the same thing would make "which URL
 * am I on" ambiguous.
 *
 * The router itself is supplied by the caller (`main.tsx` uses BrowserRouter,
 * tests use MemoryRouter), so route behaviour is testable without a DOM history.
 */
/**
 * `/` → `/world`, **keeping the query string**.
 *
 * A bare `<Navigate to="/world">` builds a whole new location and drops the
 * search params, and the OAuth callback lands on `/?auth_error=…` — so the plain
 * redirect would silently swallow the reason a sign-in failed and leave the
 * player staring at an unchanged page. Carrying the search through is what lets
 * `AccountBadge` still find the code.
 */
function IndexRedirect(): ReactNode {
  const { search } = useLocation();
  return <Navigate to={{ pathname: '/world', search }} replace />;
}

export function App(): ReactNode {
  return (
    <ThemeProvider>
      <SessionProvider>
        {/*
          The login wall wraps the whole route table, not individual routes.
          Gating route by route means every new route is a chance to forget one,
          and the first forgotten one is the bug nobody notices.
        */}
        <RequireSession>
          <Routes>
            <Route path="/" element={<AppShell />}>
              <Route index element={<IndexRedirect />} />
              <Route path="world" element={<WorldPage />} />
              <Route path="fleet" element={<FleetPage />} />
              <Route path="network" element={<NetworkPage />} />
              <Route path="finance" element={<FinancePage />} />
              <Route path="crew" element={<CrewPage />} />
              <Route path="design" element={<DesignPage />} />
              <Route path="board" element={<BoardPage />} />
              <Route
                path="*"
                element={
                  <section className="page">
                    <h1 className="page__title">Not found</h1>
                    <p className="page__note">No such view.</p>
                  </section>
                }
              />
            </Route>
          </Routes>
        </RequireSession>
      </SessionProvider>
    </ThemeProvider>
  );
}
