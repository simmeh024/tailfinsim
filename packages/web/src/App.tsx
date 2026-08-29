import { useEffect, useState } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router';

import { AdminLayout } from './admin/AdminLayout';
import { AdminAirlinePage } from './admin/AirlinePage';
import { AuditPage } from './admin/AuditPage';
import { CarriersPage } from './admin/CarriersPage';
import { OverviewPage } from './admin/OverviewPage';
import { PlayersPage } from './admin/PlayersPage';
import { SystemHealthPage } from './admin/SystemHealthPage';
import { WorldsPage } from './admin/WorldsPage';
import { AirlinePage } from './airline/AirlinePage';
import { LogoStudioPage } from './airline/LogoStudioPage';
import { RequireSession } from './auth/RequireSession';
import { SessionProvider } from './auth/SessionProvider';
import { CrewPage } from './crew/CrewPage';
import { FleetPage } from './fleet/FleetPage';
import { fetchFoundingOptions } from './founding/api';
import { FoundingPage } from './founding/FoundingPage';
import { ExecutiveSuitePage } from './hq/ExecutiveSuitePage';
import { HeadquartersPage } from './hq/HeadquartersPage';
import { LiveryBuilderPage } from './livery/LiveryBuilder';
import { NetworkPage } from './network/NetworkPage';
import { BoardPage, FinancePage } from './routes/Placeholder';
import { AppShell } from './shell/AppShell';
import { ThemeProvider } from './theme/ThemeProvider';
import { WorldPage } from './world/WorldPage';

import type { ReactNode } from 'react';

/**
 * Route table — the seven destinations from App. H.4.
 *
 * `/` resolves the authenticated player's airline state. An established player
 * lands on the world; a player with no airline lands at the founding desk.
 *
 * The router itself is supplied by the caller (`main.tsx` uses BrowserRouter,
 * tests use MemoryRouter), so route behaviour is testable without a DOM history.
 */
/**
 * `/` → the founding desk or world, **keeping the query string**.
 *
 * A bare `<Navigate>` builds a whole new location and drops the
 * search params, and the OAuth callback lands on `/?auth_error=…` — so the plain
 * redirect would silently swallow the reason a sign-in failed and leave the
 * player staring at an unchanged page. Carrying the search through is what lets
 * `AccountBadge` still find the code.
 */
function IndexRedirect(): ReactNode {
  const { search } = useLocation();
  const [destination, setDestination] = useState<'/found' | '/world' | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    void fetchFoundingOptions()
      .then((options) => {
        setDestination(options.memberships.length === 0 ? '/found' : '/world');
      })
      .catch(() => {
        setFailed(true);
      });
  }, []);

  if (failed) {
    return (
      <section className="page">
        <h1 className="page__title">Cannot choose a landing page</h1>
        <p className="page__note" role="alert">
          Tailfin could not read your airline context. Reload to try again.
        </p>
      </section>
    );
  }
  if (destination === null) {
    return (
      <section className="page">
        <h1 className="page__title">Opening your desk</h1>
        <p className="page__note" aria-live="polite">
          Checking your airline…
        </p>
      </section>
    );
  }
  return <Navigate to={{ pathname: destination, search }} replace />;
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
            {/* AIR-07's cold open has no game menu behind it. It is a complete
                player surface, not a modal laid over destinations that do not
                make sense until an airline exists. */}
            <Route index element={<IndexRedirect />} />
            <Route path="/found" element={<FoundingPage />} />
            {/*
              The logo studio is a full-screen takeover, like the founding desk —
              it fetches its own airline and saves the logo as its own rebrand, so
              it sits outside the AppShell chrome rather than inside the `/airline`
              page it is reached from.
            */}
            <Route path="/airline/logo" element={<LogoStudioPage />} />
            <Route element={<AppShell />}>
              <Route path="world" element={<WorldPage />} />
              <Route path="airline" element={<AirlinePage />} />
              <Route path="fleet" element={<FleetPage />} />
              <Route path="network" element={<NetworkPage />} />
              <Route path="finance" element={<FinancePage />} />
              <Route path="crew" element={<CrewPage />} />
              <Route path="headquarters" element={<HeadquartersPage />} />
              <Route path="c-suite" element={<ExecutiveSuitePage />} />
              <Route path="design" element={<LiveryBuilderPage />} />
              <Route path="board" element={<BoardPage />} />
              {/*
                The console is a layout with its own navigation, not a single
                page. The admin gate lives in that layout rather than on each
                route — gating route by route means every route added later is a
                chance to forget one, and it is still a convenience rather than a
                boundary: `requireAdmin` on the server is what protects the data.
              */}
              <Route path="admin" element={<AdminLayout />}>
                <Route index element={<OverviewPage />} />
                <Route path="worlds" element={<WorldsPage />} />
                {/*
                  One page, two shapes. A player's detail has its own URL so a
                  support conversation can link to it, and the list is the same
                  route without an id rather than a separate component that has
                  to be kept in step.
                */}
                <Route path="players" element={<PlayersPage />} />
                <Route path="players/:playerId" element={<PlayersPage />} />
                <Route path="airlines/:airlineId" element={<AdminAirlinePage />} />
                <Route path="audit" element={<AuditPage />} />
                {/* The competition, and why it did what it did (M3-12). */}
                <Route path="carriers" element={<CarriersPage />} />
                {/* The machines, rather than the worlds (OPS-15). */}
                <Route path="system" element={<SystemHealthPage />} />
              </Route>
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
