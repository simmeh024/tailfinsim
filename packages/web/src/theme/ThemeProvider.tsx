import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

import type { ReactNode } from 'react';

/**
 * Theme state.
 *
 * Dark is the default, not "whatever the OS says" — H.4 is explicit that dark is
 * the default because this is a screen people leave open for hours. The OS
 * preference is deliberately not consulted; a player who wants light picks it,
 * and the choice sticks.
 */

export type Theme = 'dark' | 'light';

const STORAGE_KEY = 'tailfin.theme';
export const DEFAULT_THEME: Theme = 'dark';

interface ThemeContextValue {
  theme: Theme;
  setTheme: (theme: Theme) => void;
  toggleTheme: () => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

function isTheme(value: unknown): value is Theme {
  return value === 'dark' || value === 'light';
}

/**
 * Reads the stored preference, falling back to dark.
 *
 * `localStorage` throws in private-mode Safari and when storage is disabled, so
 * the read is guarded — a browser that refuses to persist should still render
 * the app rather than a blank page.
 */
export function readStoredTheme(): Theme {
  try {
    const stored = globalThis.localStorage?.getItem(STORAGE_KEY);
    return isTheme(stored) ? stored : DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME;
  }
}

export function ThemeProvider({ children }: { children: ReactNode }): ReactNode {
  const [theme, setThemeState] = useState<Theme>(readStoredTheme);

  // The attribute drives the token overrides in tokens.css. Set on <html> so
  // it also covers anything portalled outside the React root.
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  const setTheme = useCallback((next: Theme) => {
    setThemeState(next);
    try {
      globalThis.localStorage?.setItem(STORAGE_KEY, next);
    } catch {
      // Non-fatal: the theme still applies for this session.
    }
  }, []);

  const toggleTheme = useCallback(() => {
    setThemeState((current) => {
      const next: Theme = current === 'dark' ? 'light' : 'dark';
      try {
        globalThis.localStorage?.setItem(STORAGE_KEY, next);
      } catch {
        // Non-fatal.
      }
      return next;
    });
  }, []);

  const value = useMemo(() => ({ theme, setTheme, toggleTheme }), [theme, setTheme, toggleTheme]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error('useTheme must be used inside a ThemeProvider');
  }
  return context;
}
