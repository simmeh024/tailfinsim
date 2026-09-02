import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

import { DEFAULT_CURRENCY, type CurrencyRateView, type DisplayCurrency } from '@tailfin/shared';

import { useSession } from '../auth/SessionProvider';

import { fetchCurrencies, putCurrency } from './api';
import { setDisplayCurrency } from './display';

import type { ReactNode } from 'react';

/**
 * Display currency, for the whole player app (M8-02).
 *
 * Loads the supported currencies and their rates once, reads the player's choice
 * from the session, and keeps the formatter module (`display.ts`) pointed at both
 * — so every money value the app renders is converted at that one boundary while
 * the wire and the economy stay USD minor units. Also exposes the list and a
 * setter for the Settings page.
 *
 * The formatters are plain functions reading module state, so a currency change
 * shows immediately on any view that re-renders or is navigated to; the setter
 * refreshes the session so the choice persists across reloads.
 */
interface CurrencyContextValue {
  /** Every supported currency with its live rate, for the settings selector. */
  currencies: CurrencyRateView[];
  /** The codes pinned to the top of the list, in order. */
  top: DisplayCurrency[];
  /** The currency now in force (the player's choice, or USD by default). */
  current: DisplayCurrency;
  /** Whether the initial currency list is still loading. */
  loading: boolean;
  /** Whether a change is being saved. */
  saving: boolean;
  /** Record a new display currency for this player. */
  setCurrency: (currency: DisplayCurrency) => Promise<void>;
}

const CurrencyContext = createContext<CurrencyContextValue | null>(null);

export function CurrencyProvider({ children }: { children: ReactNode }): ReactNode {
  const { player, refresh } = useSession();
  const [currencies, setCurrencies] = useState<CurrencyRateView[]>([]);
  const [top, setTop] = useState<DisplayCurrency[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const current: DisplayCurrency = player?.displayCurrency ?? DEFAULT_CURRENCY;

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const response = await fetchCurrencies();
        if (!live) return;
        // Defensive: a malformed body must not crash the app — the formatters
        // just stay at their USD default.
        setCurrencies(Array.isArray(response.currencies) ? response.currencies : []);
        setTop(Array.isArray(response.top) ? response.top : []);
      } catch {
        // A currency list that fails to load leaves the formatters at their USD
        // default — money still renders, just not converted. Not worth a banner.
      } finally {
        if (live) setLoading(false);
      }
    })();
    return () => {
      live = false;
    };
  }, []);

  // Keep the formatter module pointed at the current choice and rates. Runs on
  // load and whenever either changes, so a fresh sign-in or a saved change is
  // reflected without a reload.
  useEffect(() => {
    setDisplayCurrency(current, currencies);
  }, [current, currencies]);

  const setCurrency = useCallback(
    async (currency: DisplayCurrency) => {
      setSaving(true);
      try {
        await putCurrency(currency);
        // Update the formatters at once, then refresh the session so the choice
        // survives a reload and every session consumer re-renders.
        setDisplayCurrency(currency, currencies);
        await refresh();
      } finally {
        setSaving(false);
      }
    },
    [currencies, refresh],
  );

  const value = useMemo(
    () => ({ currencies, top, current, loading, saving, setCurrency }),
    [currencies, top, current, loading, saving, setCurrency],
  );

  return <CurrencyContext.Provider value={value}>{children}</CurrencyContext.Provider>;
}

export function useCurrency(): CurrencyContextValue {
  const context = useContext(CurrencyContext);
  if (!context) {
    throw new Error('useCurrency must be used within a CurrencyProvider');
  }
  return context;
}
