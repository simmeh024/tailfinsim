import type { CurrencyRateView, DisplayCurrency } from '@tailfin/shared';

import { useSession } from '../auth/SessionProvider';
import { useCurrency } from '../currency/CurrencyProvider';
import { formatUsdMinor } from '../currency/display';

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

  const pinned = currencies.filter((c) => c.top);
  const rest = currencies.filter((c) => !c.top);

  const pick = (code: DisplayCurrency): void => {
    if (code === current || saving) return;
    void setCurrency(code);
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
          Choose the currency the game shows your money in. Amounts are converted at live exchange
          rates; the underlying accounting is always in US dollars, so this changes only what you
          see. The default is the US Dollar.
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
                  active={c.code === current}
                  disabled={saving}
                  onPick={pick}
                />
              ))}
            </div>

            <p className="settings__group-label">All currencies</p>
            <div className="currency-grid">
              {rest.map((c) => (
                <CurrencyOption
                  key={c.code}
                  currency={c}
                  active={c.code === current}
                  disabled={saving}
                  onPick={pick}
                />
              ))}
            </div>

            <p className="settings__preview">
              Preview: $10,000.00 shows as <strong>{formatUsdMinor(PREVIEW_USD_MINOR)}</strong>
              {current !== 'USD' && ' at today’s rate'}.
            </p>
          </>
        )}
      </section>
    </div>
  );
}
