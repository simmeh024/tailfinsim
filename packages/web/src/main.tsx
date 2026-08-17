import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';

import { App } from './App';
import { readStoredTheme } from './theme/ThemeProvider';

import './theme/tokens.css';
import './shell/shell.css';

/**
 * Browser entry point.
 *
 * The theme attribute is set here, before React mounts, so the first paint is
 * already in the right theme. Doing it only inside ThemeProvider's effect would
 * flash dark then repaint light for anyone who chose light.
 */
document.documentElement.dataset.theme = readStoredTheme();

const container = document.getElementById('root');
if (!container) {
  throw new Error('#root is missing from index.html');
}

createRoot(container).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
);
