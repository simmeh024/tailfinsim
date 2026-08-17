import { Navigate, Route, Routes } from 'react-router';

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
export function App(): ReactNode {
  return (
    <ThemeProvider>
      <Routes>
        <Route path="/" element={<AppShell />}>
          <Route index element={<Navigate to="/world" replace />} />
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
    </ThemeProvider>
  );
}
