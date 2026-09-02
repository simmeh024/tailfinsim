import { useState } from 'react';

import type { CurrencyRateView, DisplayCurrency } from '@tailfin/shared';

import { useSession } from '../auth/SessionProvider';
import { useCurrency } from '../currency/CurrencyProvider';
import { formatInCurrency } from '../currency/display';

import { reloadPage } from './reload';

import './settings.css';

import type { ReactNode } from 'react';

/** One example amount, so the player can see what their choice does. */
const PREVIEW_USD_MINOR = 1_000_000; // $10,000.00

function CurrencyOption({
  currency,
  active,
  disabled,
  onPick,
}: {
  currency: CurrencyRateView;
  active: boolean;
  disabled: boolean;
  onPick: (code: DisplayCurrency) => void;
}): ReactNode {
  return (
    <button
      type="button"
      className={`currency-option${active ? ' currency-option--active' : ''}`}
      aria-pressed={active}
      disabled={disabled}
      onClick={() => onPick(currency.code)}
    >
      <span className="currency-option__symbol" aria-hidden="true">
        {currency.symbol}
      </span>
      <span className="currency-option__code">{currency.code}</span>
      <span className="currency-option__name">{currency.name}</span>
      {active && (
        <span className="currency-option__check" aria-hidden="true">
          ✓
        </span>
      )}
    </button>
  );
}

/**
 * The player's account settings (M8-02).
 *
 * Reached from the account name in the shell. Today it holds one thing — the
 * display currency — with the top five pinned above the rest. Money everywhere
 * in the app is still USD minor units; this only changes how it is rendered.
 */
export function SettingsPage(): ReactNode {
  const { player } = useSession();
  const { currencies, current, loading, saving, setCurrency } = useCurrency();

  // The pending pick, kept until the player presses Save. Null means "no change
  // from the saved currency" — so `selected` below is what the UI reflects.
  const [pending, setPending] = useState<DisplayCurrency | null>(null);
  const selected: DisplayCurrency = pending ?? current;

  const pinned = currencies.filter((c) => c.top);
  const rest = currencies.filter((c) => !c.top);
  const selectedView = currencies.find((c) => c.code === selected);
  const dirty = selected !== current;

  const onSave = async (): Promise<void> => {
    if (!dirty || saving) return;
    await setCurrency(selected);
    // A full refresh is the simplest way to re-render every already-mounted view
    // (the status strip, any open page) in the new currency at once.
    reloadPage();
  };

  return (
    <div className="settings">
      <header className="settings__head">
        <h1>Settings</h1>
        {player && <p>Signed in as {player.displayName}</p>}
      </header>

      <section className="settings__section" aria-labelledby="currency-heading">
        <h2 id="currency-heading">Display currency</h2>
        <p className="settings__hint">
          Choose the currency the game shows your money in, then Save. Amounts are converted at live
          exchange rates; the underlying accounting is always in US dollars, so this changes only
          what you see. The default is the US Dollar.
        </p>

        {loading ? (
          <p className="settings__hint">Loading currencies…</p>
        ) : (
          <>
            <p className="settings__group-label">Top currencies</p>
            <div className="currency-grid">
              {pinned.map((c) => (
                <CurrencyOption
                  key={c.code}
                  currency={c}
                  active={c.code === selected}
                  disabled={saving}
                  onPick={setPending}
                />
              ))}
            </div>

            <p className="settings__group-label">All currencies</p>
            <div className="currency-grid">
              {rest.map((c) => (
                <CurrencyOption
                  key={c.code}
                  currency={c}
                  active={c.code === selected}
                  disabled={saving}
                  onPick={setPending}
                />
              ))}
            </div>

            {selectedView && (
              <p className="settings__preview">
                Preview: $10,000.00 shows as{' '}
                <strong>{formatInCurrency(PREVIEW_USD_MINOR, selectedView)}</strong>
                {selected !== 'USD' && ' at today’s rate'}.
              </p>
            )}

            <div className="settings__actions">
              <button
                type="button"
                className="settings__save"
                disabled={!dirty || saving}
                onClick={() => void onSave()}
              >
                {saving ? 'Saving…' : 'Save'}
              </button>
              {dirty && !saving && (
                <span className="settings__actions-note">Save to apply {selected}.</span>
              )}
            </div>
          </>
        )}
      </section>
    </div>
  );
}
