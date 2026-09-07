import { lazy, Suspense, useEffect, useState } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router';

import { RequireSession } from './auth/RequireSession';
import { SessionProvider } from './auth/SessionProvider';
import { CurrencyProvider } from './currency/CurrencyProvider';
import { fetchFoundingOptions } from './founding/api';
import { AppShell } from './shell/AppShell';
import { ThemeProvider } from './theme/ThemeProvider';
import { StateBlock } from './ui/StateBlock';

import type { ReactNode } from 'react';

/**
 * Every destination is loaded on demand (PERF-01).
 *
 * Before this, `App.tsx` imported all twenty-four pages statically, so the
 * single `index.js` chunk carried the admin console, the livery builder, the
 * cabin configurator, the world renderer and all seven dashboards — **1.94 MB
 * raw, 551 kB gzipped, downloaded and parsed by every visitor including one
 * still looking at the sign-in button.** `three` and `world-atlas` were already
 * dynamic; the pages around them were not, which is why the main chunk was
 * bigger than either of them.
 *
 * ## Why per route rather than hand-tuned groups
 *
 * A manual `manualChunks` map is a second place the route table lives, and it
 * goes stale the first time somebody adds a page. One `lazy()` per route lets
 * the bundler hoist what the routes genuinely share — `dashboard.css` and its
 * panels across the four dashboards, `ui/` everywhere — and the grouping stays
 * correct by construction.
 *
 * ## What stays eager, and why
 *
 * The login surface and the shell. `RequireSession` decides what a visitor may
 * see at all and `AppShell` is the frame around every signed-in route, so
 * splitting either would put a network round trip in front of the first pixel
 * rather than behind it. Everything else is at least one round trip away
 * already — the redirect at `/` waits on `/api/founding-options`, and a rail
 * click is a user action — so a chunk fetch costs nothing a player can feel.
 *
 * `Suspense` sits **inside** the shell (see `AppShell`'s `Stage`) for routes
 * that have one, so the rail, the context panel and the status strip stay on
 * screen while a page arrives. A full-screen route gets the page-level fallback
 * below, because there is no chrome to keep.
 */

const AdminLayout = lazy(async () => ({
  default: (await import('./admin/AdminLayout')).AdminLayout,
}));
const AdminAirlinePage = lazy(async () => ({
  default: (await import('./admin/AirlinePage')).AdminAirlinePage,
}));
const AuditPage = lazy(async () => ({ default: (await import('./admin/AuditPage')).AuditPage }));
const CarriersPage = lazy(async () => ({
  default: (await import('./admin/CarriersPage')).CarriersPage,
}));
const EconomyPage = lazy(async () => ({
  default: (await import('./admin/EconomyPage')).EconomyPage,
}));
const OverviewPage = lazy(async () => ({
  default: (await import('./admin/OverviewPage')).OverviewPage,
}));
const PlayersPage = lazy(async () => ({
  default: (await import('./admin/PlayersPage')).PlayersPage,
}));
const SystemHealthPage = lazy(async () => ({
  default: (await import('./admin/SystemHealthPage')).SystemHealthPage,
}));
const WorldsPage = lazy(async () => ({ default: (await import('./admin/WorldsPage')).WorldsPage }));
const AirlinePage = lazy(async () => ({
  default: (await import('./airline/AirlinePage')).AirlinePage,
}));
const LogoStudioPage = lazy(async () => ({
  default: (await import('./airline/LogoStudioPage')).LogoStudioPage,
}));
const AlertsPage = lazy(async () => ({
  default: (await import('./alerts/AlertsPage')).AlertsPage,
}));
const CrewPage = lazy(async () => ({ default: (await import('./crew/CrewPage')).CrewPage }));
const ExecutivePage = lazy(async () => ({
  default: (await import('./dashboard/ExecutivePage')).ExecutivePage,
}));
const FinancePage = lazy(async () => ({
  default: (await import('./finance/FinancePage')).FinancePage,
}));
const CabinConfiguratorPage = lazy(async () => ({
  default: (await import('./fleet/cabin/CabinConfiguratorPage')).CabinConfiguratorPage,
}));
const FleetPage = lazy(async () => ({ default: (await import('./fleet/FleetPage')).FleetPage }));
const FoundingPage = lazy(async () => ({
  default: (await import('./founding/FoundingPage')).FoundingPage,
}));
const ExecutiveSuitePage = lazy(async () => ({
  default: (await import('./hq/ExecutiveSuitePage')).ExecutiveSuitePage,
}));
const HeadquartersPage = lazy(async () => ({
  default: (await import('./hq/HeadquartersPage')).HeadquartersPage,
}));
const LiveryBuilderPage = lazy(async () => ({
  default: (await import('./livery/LiveryBuilder')).LiveryBuilderPage,
}));
const NetworkPage = lazy(async () => ({
  default: (await import('./network/NetworkPage')).NetworkPage,
}));
const OperationsPage = lazy(async () => ({
  default: (await import('./operations/OperationsPage')).OperationsPage,
}));
const BoardPage = lazy(async () => ({ default: (await import('./routes/Placeholder')).BoardPage }));
const ServicePage = lazy(async () => ({
  default: (await import('./service/ServicePage')).ServicePage,
}));
const SettingsPage = lazy(async () => ({
  default: (await import('./settings/SettingsPage')).SettingsPage,
}));
const WorldPage = lazy(async () => ({ default: (await import('./world/WorldPage')).WorldPage }));

/**
 * The fallback for a full-screen route, which has no chrome to keep.
 *
 * `StateBlock kind="loading"` rather than a bespoke spinner, because a stray
 * loading state is exactly what `ui/StateBlock` exists to own — and because a
 * chunk that arrives in 40ms should look like every other brief wait in the
 * product rather than like a different kind of event.
 */
function RouteFallback(): ReactNode {
  return (
    <section className="page">
      <StateBlock kind="loading">Opening…</StateBlock>
    </section>
  );
}

/** A full-screen route: its own Suspense boundary, because the shell is not there to hold one. */
function FullScreen({ children }: { children: ReactNode }): ReactNode {
  return <Suspense fallback={<RouteFallback />}>{children}</Suspense>;
}

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
        <StateBlock kind="broken">
          Tailfin could not read your airline context. Reload to try again.
        </StateBlock>
      </section>
    );
  }
  if (destination === null) {
    return (
      <section className="page">
        <h1 className="page__title">Opening your desk</h1>
        <StateBlock kind="loading">Checking your airline…</StateBlock>
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
          {/*
            Display currency (M8-02) is available everywhere behind the login
            wall — it loads the rates once and points the money formatters at the
            player's choice. Inside RequireSession because /api/currencies needs a
            session; above the routes so every page renders in the chosen currency.
          */}
          <CurrencyProvider>
            <Routes>
              {/* AIR-07's cold open has no game menu behind it. It is a complete
                player surface, not a modal laid over destinations that do not
                make sense until an airline exists. */}
              <Route index element={<IndexRedirect />} />
              <Route
                path="/found"
                element={
                  <FullScreen>
                    <FoundingPage />
                  </FullScreen>
                }
              />
              {/*
              The logo studio is a full-screen takeover, like the founding desk —
              it fetches its own airline and saves the logo as its own rebrand, so
              it sits outside the AppShell chrome rather than inside the `/airline`
              page it is reached from.
            */}
              <Route
                path="/airline/logo"
                element={
                  <FullScreen>
                    <LogoStudioPage />
                  </FullScreen>
                }
              />
              {/*
                The cabin configurator (M6-08, §6) is a full-screen builder like
                the logo studio: it owns its own model and chrome, so it sits
                outside the AppShell rather than inside the `/fleet` page it is
                reached from. `?type=` selects which airframe's cabin is open.
              */}
              <Route
                path="/fleet/cabin"
                element={
                  <FullScreen>
                    <CabinConfiguratorPage />
                  </FullScreen>
                }
              />
              <Route element={<AppShell />}>
                <Route path="dashboard" element={<ExecutivePage />} />
                <Route path="operations" element={<OperationsPage />} />
                {/* §14.5’s alerts and §3.2’s offline digest (M8-13). */}
                <Route path="alerts" element={<AlertsPage />} />
                <Route path="world" element={<WorldPage />} />
                <Route path="settings" element={<SettingsPage />} />
                <Route path="airline" element={<AirlinePage />} />
                <Route path="fleet" element={<FleetPage />} />
                <Route path="network" element={<NetworkPage />} />
                <Route path="finance" element={<FinancePage />} />
                <Route path="crew" element={<CrewPage />} />
                <Route path="service" element={<ServicePage />} />
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
                  {/* Which numbers a world is running, and what moves if that
                      changes (M11-37). */}
                  <Route path="economy" element={<EconomyPage />} />
                  {/* The machines, rather than the worlds (OPS-15). */}
                  <Route path="system" element={<SystemHealthPage />} />
                </Route>
                <Route
                  path="*"
                  element={
                    <section className="page">
                      <h1 className="page__title">Not found</h1>
                      <StateBlock kind="empty">No such view.</StateBlock>
                    </section>
                  }
                />
              </Route>
            </Routes>
          </CurrencyProvider>
        </RequireSession>
      </SessionProvider>
    </ThemeProvider>
  );
}
