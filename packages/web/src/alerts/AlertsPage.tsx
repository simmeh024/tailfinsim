import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router';

import type { Alert, DigestResponse } from '@tailfin/shared';

import { formatUsdMinor } from '../currency/display';
import { Button } from '../ui/Button';
import { StateBlock } from '../ui/StateBlock';

import { fetchDigest, markDigestRead } from './alerts-api';
import { alertHref, severityGlyph, severityLabel } from './link';

import type { ReactNode } from 'react';

import '../dashboard/dashboard.css';

/**
 * §14.5's alerts and §3.2's offline digest, on one screen (M8-13).
 *
 * The digest and the alert list are the same information cut two ways — *what
 * changed while you were away* and *what still needs doing* — so they share a
 * page rather than being two destinations a player has to know to visit in
 * order. `GET /api/digest` carries both, which is also why this page makes one
 * request rather than two: a feed and a list that disagreed about which alerts
 * were open would be worse than either alone.
 *
 * ## The chart language is M8-10's
 *
 * Every class on this page comes from `dashboard/dashboard.css`, `shell.css` or
 * `ui.css`, plus the `alert-*` block this milestone adds *to* that stylesheet
 * rather than to a file of its own. `alerts-ui.test.tsx` asserts it, the way
 * M8-12's guard does for the Operations page: a page with its own idea of a row
 * looks fine in jsdom and is a second visual vocabulary in the product.
 */

function num(value: number): string {
  // `en-US` explicitly, matching `currency/display.ts` — see `OperationsPage`.
  return value.toLocaleString('en-US', { maximumFractionDigits: 0 });
}

function pct(value: number | null): string {
  return value === null ? '—' : `${(value * 100).toFixed(1)}%`;
}

/**
 * One alert, as a row that links to the screen that can act on it (AC3).
 *
 * The whole row is the link rather than a trailing "open" affordance: the
 * player's decision is *deal with this*, and making them find a small target to
 * express it is the sort of thing that turns an alert list into wallpaper.
 */
export function AlertRow({ alert }: { alert: Alert }): ReactNode {
  return (
    <li className="alert-row" data-severity={alert.severity} data-kind={alert.kind}>
      <Link className="alert-row__link" to={alertHref(alert)}>
        <span className="alert-row__mark" aria-hidden="true">
          {severityGlyph(alert.severity)}
        </span>
        <span className="alert-row__text">
          <span className="alert-row__title">{alert.title}</span>
          <span className="alert-row__detail">{alert.detail}</span>
        </span>
        <span className="alert-row__meta">
          {/*
            The severity in words as well as in the glyph and the ground, so
            meaning survives without hue (§14.6, H.7) — and the subject, so a
            player scanning the list can tell two route alerts apart.
          */}
          <span className="alert-row__severity">{severityLabel(alert.severity)}</span>
          <span className="alert-row__subject">{alert.subjectLabel}</span>
        </span>
      </Link>
    </li>
  );
}

function AlertList({
  alerts,
  emptyNote,
}: {
  alerts: readonly Alert[];
  emptyNote: string;
}): ReactNode {
  if (alerts.length === 0) return <StateBlock kind="empty">{emptyNote}</StateBlock>;
  return (
    <ul className="alert-list">
      {alerts.map((alert) => (
        <AlertRow key={alert.id} alert={alert} />
      ))}
    </ul>
  );
}

/**
 * How long the player was away, in the world's own days.
 *
 * Game days, not real ones: §3.2's feed describes what happened *in the world*,
 * and a player who left a 4× world overnight missed four days of trading rather
 * than one night. The two numbers are different and only one of them is the one
 * the flights in this digest were dated on.
 */
function windowSentence(digest: DigestResponse): string {
  const days = digest.window.days;
  if (digest.window.first) {
    return `Your first digest, covering the last ${num(days)} game days.`;
  }
  if (days < 1) return 'Nothing has happened since you last looked.';

  const span = days < 2 ? '1 game day' : `${num(days)} game days`;
  return digest.window.truncated
    ? `The last ${span} — you were away longer than a digest covers, so this is the most recent part.`
    : `The ${span} since you last looked.`;
}

function DigestActivityPanel({ digest }: { digest: DigestResponse }): ReactNode {
  const activity = digest.activity;
  return (
    <section className="panel" aria-label="While you were away">
      <h2 className="panel__title">While you were away</h2>
      <dl className="figures">
        <div className="figures__row">
          <dt>Flights flown</dt>
          <dd className="figure">{num(activity.flightsFlown)}</dd>
        </div>
        <div className="figures__row">
          <dt>Cancelled</dt>
          <dd className="figure">{num(activity.flightsCancelled)}</dd>
        </div>
        <div className="figures__row">
          <dt>Passengers</dt>
          <dd className="figure">{num(activity.passengers)}</dd>
        </div>
        <div className="figures__row">
          <dt>On time (D15)</dt>
          <dd className="figure">{pct(activity.onTimeRate)}</dd>
        </div>
        <div className="figures__row">
          <dt>Revenue</dt>
          <dd className="figure">{formatUsdMinor(activity.revenueMinor)}</dd>
        </div>
        <div className="figures__row">
          <dt>Cost</dt>
          <dd className="figure">{formatUsdMinor(activity.costMinor)}</dd>
        </div>
        <div className="figures__row">
          <dt>Cash movement</dt>
          <dd className="figure">{formatUsdMinor(activity.cashChangeMinor)}</dd>
        </div>
      </dl>
      {activity.flightsFlown === 0 && (
        <p className="page__note">
          Nothing settled in this period. Only the worker settles a flight, so on a node without one
          every figure here stays at zero however much is scheduled — which reads as a quiet week
          rather than as a missing process.
        </p>
      )}
    </section>
  );
}

export function AlertsPage(): ReactNode {
  const [digest, setDigest] = useState<DigestResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [acknowledged, setAcknowledged] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setDigest(await fetchDigest());
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const onAcknowledge = useCallback(async () => {
    if (digest === null) return;
    const result = await markDigestRead(digest.window.toAt);
    // A failure leaves the digest on screen. Losing a week of news to a dropped
    // request is a far larger wrong than showing it twice.
    if (result !== null) setAcknowledged(true);
  }, [digest]);

  if (loading) {
    return (
      <section className="page">
        <h1 className="page__title">Alerts</h1>
        <StateBlock kind="loading">Reading what changed.</StateBlock>
      </section>
    );
  }

  if (digest === null) {
    return (
      <section className="page">
        <h1 className="page__title">Alerts</h1>
        <StateBlock kind="broken">
          The alerts could not be read. Nothing is wrong with your airline — this page is.
        </StateBlock>
      </section>
    );
  }

  const news = digest.raised.length + digest.resolved.length;

  return (
    <section className="page">
      <h1 className="page__title">Alerts</h1>
      <p className="page__note">{windowSentence(digest)}</p>

      <section className="panel" aria-label="Open alerts">
        <h2 className="panel__title">Open</h2>
        <AlertList
          alerts={digest.open}
          emptyNote="Nothing needs a decision. The rules run on the world's clock, so this list is empty either because nothing is wrong or because no worker has evaluated it."
        />
      </section>

      <div className="panel-pair">
        <section className="panel" aria-label="Raised while you were away">
          <h2 className="panel__title">New since you looked</h2>
          <AlertList alerts={digest.raised} emptyNote="Nothing new was raised in this period." />
        </section>
        <section className="panel" aria-label="Cleared while you were away">
          <h2 className="panel__title">Cleared</h2>
          {/*
            Good news is in the feed on purpose. A digest that only ever reported
            problems would show a player who fixed three routes exactly what it
            shows one who fixed none.
          */}
          <AlertList alerts={digest.resolved} emptyNote="Nothing cleared in this period." />
        </section>
      </div>

      <DigestActivityPanel digest={digest} />

      {news > 0 && !acknowledged && (
        <div className="alert-actions">
          <Button onClick={() => void onAcknowledge()}>Mark this digest as read</Button>
          <p className="page__note">
            Reading this page changes nothing on the server; marking it read is what moves the
            window forward, so a refresh cannot lose a period you have not seen.
          </p>
        </div>
      )}
      {acknowledged && (
        <StateBlock kind="empty">
          Marked as read. The next digest starts from {new Date(digest.window.toAt).toISOString()}.
        </StateBlock>
      )}

      <p className="page__note">
        §14.5 lists nine alerts and this page carries seven of them, plus §9.3&rsquo;s own
        contract-lapse warning. Two are named rather than invented: nothing in the game{' '}
        <strong>leases a gate</strong> — a slot holding is a per-band operating right with no term —
        and there is no <strong>world event announcement</strong> model for a network to be affected
        by. Both are gaps in the game rather than in this screen.
      </p>
    </section>
  );
}
