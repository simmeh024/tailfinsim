import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type {
  BookCheckResponse,
  CheckTier,
  MaintenanceAirframeView,
  MaintenanceResponse,
} from '@tailfin/shared';

import { formatUsdMinor } from '../currency/display';
import { Button } from '../ui/Button';
import { StateBlock } from '../ui/StateBlock';
import { useWorldClock } from '../world/useWorldClock';

import { bookMaintenanceCheck, fetchMaintenance } from './api';
import {
  comingDue,
  deferralInWords,
  downtimeInWords,
  dueInWords,
  formatWorldDate,
  historyInWords,
  nextTier,
  statusPresentation,
  TIER_LABEL,
} from './maintenance-presentation';

import type { ReactNode } from 'react';

import './maintenance.css';

/**
 * Maintenance planning — what is due across the fleet, and booking the work
 * (SURFACE-04, M4-06, §7.3).
 *
 * ## Why it is a section of the Fleet page
 *
 * M4-07's fleet list already quotes each aeroplane's next check and the
 * aircraft detail shows all three tiers; SURFACE-04 is explicit that this
 * extends them rather than forking a second fleet view. So the planner sits on
 * the Fleet page under the list, at `#maintenance`, and an alert about an
 * unbooked check links to it with the airframe preselected.
 *
 * ## What the page decides, and what it does not
 *
 * Nothing about money or time. Each tier's cost — after §10.4's maintenance
 * doctrine, M9-06 — and downtime are the server's quote, shown before the
 * button; the return date is the server's answer after it. The client sends a
 * tier and an airframe and nothing else (SEC-09). A refused booking leaves the
 * page exactly as it was and says why.
 *
 * ## The two readings a careless page gets wrong
 *
 *   - **A null history.** The server reads it as *last completed at the hours
 *     this airframe has now*, and the page says so in words (`historyInWords`)
 *     rather than leaving a player to wonder — and renders only the server's
 *     remaining figures, so it cannot render the null as zero.
 *   - **A check nothing will finish.** Checks complete on the worker's tick; a
 *     world with no worker leaves an aeroplane in its check for ever. The page
 *     compares the completion with the world's clock and says so once it has
 *     passed (`isCheckStalled`), rather than going on saying "in check".
 */

type Booking =
  | { kind: 'idle' }
  | { kind: 'booking'; tier: CheckTier }
  | { kind: 'booked'; result: BookCheckResponse; registration: string }
  | { kind: 'refused'; message: string };

function money(minor: number): string {
  return formatUsdMinor(minor, { fractionDigits: 0 });
}

function percent(fraction: number): string {
  return `${(fraction * 100).toFixed(1)}%`;
}

function StatusCell({
  view,
  gameNow,
}: {
  view: MaintenanceAirframeView;
  gameNow: Date | null;
}): ReactNode {
  const status = statusPresentation(view, gameNow);
  return (
    <span className="maint__status">
      <span className={`status status--${status.tone}`}>{status.label}</span>
      {status.detail !== null && <span className="maint__status-detail">{status.detail}</span>}
    </span>
  );
}

/** The booking panel for one airframe: three tiers, their quotes, and the choice. */
function BookingPanel({
  view,
  booking,
  onBook,
  onClose,
}: {
  view: MaintenanceAirframeView;
  booking: Booking;
  onBook: (tier: CheckTier) => void;
  onClose: () => void;
}): ReactNode {
  const firstDue = view.dueTiers[0] ?? nextTier(view)?.tier ?? 'a';
  const [tier, setTier] = useState<CheckTier>(firstDue);
  const chosen = view.tiers.find((row) => row.tier === tier) ?? null;
  const inCheck = view.status === 'in_check';
  const busy = booking.kind === 'booking';

  return (
    <section className="maint__book" aria-labelledby="maint-book-title">
      <div className="maint__book-head">
        <h3 id="maint-book-title" className="maint__book-title">
          Book a check — {view.registration}
        </h3>
        <Button variant="tertiary" onClick={onClose}>
          Close
        </Button>
      </div>
      <p className="maint__book-sub">
        {view.typeDesignation}, {view.maintenanceProfile} programme. Whichever limit arrives first
        decides.
      </p>

      <fieldset className="maint__tiers" disabled={busy || inCheck}>
        <legend className="maint__legend">Which check</legend>
        {view.tiers.map((row) => (
          <label key={row.tier} className="maint__tier" data-due={row.due ? 'yes' : 'no'}>
            <input
              type="radio"
              name="maint-tier"
              value={row.tier}
              checked={tier === row.tier}
              onChange={() => {
                setTier(row.tier);
              }}
            />
            <span className="maint__tier-name">{TIER_LABEL[row.tier]}</span>
            <span className="maint__tier-due">{dueInWords(row)}</span>
            <span className="maint__tier-cost figure">{money(row.costMinor)}</span>
            <span className="maint__tier-down">{downtimeInWords(row.downtimeDays)} out</span>
          </label>
        ))}
      </fieldset>

      {chosen !== null && (
        <p className="maint__consequence" data-due={chosen.due ? 'yes' : 'no'}>
          {deferralInWords(view, chosen)}
        </p>
      )}

      {inCheck ? (
        <StateBlock kind="refused">
          This aircraft is already in a check. A second one can be booked once it is back in
          service.
        </StateBlock>
      ) : (
        chosen !== null && (
          <Button
            variant="primary"
            disabled={busy}
            onClick={() => {
              onBook(chosen.tier);
            }}
          >
            {busy
              ? 'Booking…'
              : `Book ${TIER_LABEL[chosen.tier]} — ${money(chosen.costMinor)}, ${downtimeInWords(chosen.downtimeDays)} out of service`}
          </Button>
        )
      )}

      {booking.kind === 'refused' && <StateBlock kind="refused">{booking.message}</StateBlock>}
    </section>
  );
}

/**
 * The planner. `preselect` is an airframe id to open the booking panel on — the
 * destination of an alert about an unbooked check.
 */
export function MaintenancePlanner({ preselect = null }: { preselect?: string | null }): ReactNode {
  const [data, setData] = useState<MaintenanceResponse | 'loading' | 'error'>('loading');
  const [selectedId, setSelectedId] = useState<string | null>(preselect);
  const [booking, setBooking] = useState<Booking>({ kind: 'idle' });
  const { inGameTime } = useWorldClock();
  const sectionRef = useRef<HTMLElement | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await fetchMaintenance());
    } catch {
      setData('error');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Arriving from an alert: bring the planner into view once.
  useEffect(() => {
    if (preselect !== null) sectionRef.current?.scrollIntoView?.({ block: 'start' });
  }, [preselect]);

  const onBook = useCallback(
    async (airframe: MaintenanceAirframeView, tier: CheckTier) => {
      setBooking({ kind: 'booking', tier });
      try {
        const outcome = await bookMaintenanceCheck({ airframeId: airframe.airframeId, tier });
        if (!outcome.ok) {
          // Refused: nothing on the page changes but the reason. The server is
          // the one that knows whether the aircraft is free and the cash is there.
          setBooking({ kind: 'refused', message: outcome.refusal.message });
          return;
        }
        setBooking({ kind: 'booked', result: outcome.value, registration: airframe.registration });
        setSelectedId(null);
        await load();
      } catch {
        setBooking({
          kind: 'refused',
          message:
            'The booking could not be confirmed. Reload before trying again — it may have gone through.',
        });
      }
    },
    [load],
  );

  const due = useMemo(() => (typeof data === 'object' ? comingDue(data) : []), [data]);
  const selected =
    typeof data === 'object' && selectedId !== null
      ? (data.airframes.find((view) => view.airframeId === selectedId) ?? null)
      : null;

  return (
    <section id="maintenance" className="maint" ref={sectionRef} aria-labelledby="maint-title">
      <h2 id="maint-title" className="fleet__section-heading">
        Maintenance
      </h2>

      {data === 'loading' ? (
        <StateBlock kind="loading">Reading the fleet’s maintenance…</StateBlock>
      ) : data === 'error' ? (
        <StateBlock kind="broken">Could not load the fleet’s maintenance.</StateBlock>
      ) : data.airframes.length === 0 ? (
        <StateBlock kind="empty">
          No aircraft to maintain yet. Checks fall due as an aircraft flies.
        </StateBlock>
      ) : (
        <>
          {booking.kind === 'booked' && (
            <p className="maint__booked" role="status">
              {TIER_LABEL[booking.result.tier]} booked for {booking.registration}:{' '}
              {money(booking.result.costMinor)}, back in service{' '}
              {formatWorldDate(booking.result.completesAt)}.
            </p>
          )}

          <h3 className="maint__subheading">Coming due</h3>
          <p className="maint__note">
            The fleet’s next checks, the most used interval first — booking a heavier check covers
            the lighter ones.
          </p>
          {/* Wide tables scroll in their own labelled, focusable box on a phone,
              as the fleet table above does (UX-09). */}
          <div
            className="maint__table-scroll"
            role="region"
            aria-label="Checks coming due"
            tabIndex={0}
          >
            <table className="maint__table">
              <thead>
                <tr>
                  <th scope="col">Aircraft</th>
                  <th scope="col">Check</th>
                  <th scope="col">When</th>
                  <th scope="col">Cost</th>
                  <th scope="col">Out of service</th>
                  <th scope="col">
                    <span className="visually-hidden">Plan</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {due.map(({ view, tier }) => (
                  <tr key={`${view.airframeId}-${tier.tier}`} data-due={tier.due ? 'yes' : 'no'}>
                    <th scope="row">
                      {view.registration}{' '}
                      <span className="maint__type">{view.typeDesignation}</span>
                    </th>
                    <td>{TIER_LABEL[tier.tier]}</td>
                    <td className="figure">{dueInWords(tier)}</td>
                    <td className="figure">{money(tier.costMinor)}</td>
                    <td>{downtimeInWords(tier.downtimeDays)}</td>
                    <td>
                      <Button
                        variant="secondary"
                        onClick={() => {
                          setBooking({ kind: 'idle' });
                          setSelectedId(view.airframeId);
                        }}
                      >
                        Plan
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <h3 className="maint__subheading">Every aircraft</h3>
          <div
            className="maint__table-scroll"
            role="region"
            aria-label="Every aircraft’s checks"
            tabIndex={0}
          >
            <table className="maint__table">
              <thead>
                <tr>
                  <th scope="col">Aircraft</th>
                  <th scope="col">Status</th>
                  <th scope="col">Next check</th>
                  <th scope="col">Fault risk</th>
                  <th scope="col">
                    <span className="visually-hidden">Book</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.airframes.map((view) => {
                  const next = nextTier(view);
                  const history = historyInWords(view);
                  return (
                    <tr key={view.airframeId} data-status={view.status}>
                      <th scope="row">
                        {view.registration}{' '}
                        <span className="maint__type">{view.typeDesignation}</span>
                        {history !== null && <span className="maint__history">{history}</span>}
                      </th>
                      <td>
                        <StatusCell view={view} gameNow={inGameTime} />
                      </td>
                      <td className="figure">
                        {next === null ? '—' : `${TIER_LABEL[next.tier]} ${dueInWords(next)}`}
                      </td>
                      <td className="figure">{percent(view.technicalRisk)}</td>
                      <td>
                        <Button
                          variant="secondary"
                          onClick={() => {
                            setBooking({ kind: 'idle' });
                            setSelectedId(view.airframeId);
                          }}
                        >
                          Book a check
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {selected !== null && (
            <BookingPanel
              key={selected.airframeId}
              view={selected}
              booking={booking}
              onBook={(tier) => void onBook(selected, tier)}
              onClose={() => {
                setSelectedId(null);
                setBooking({ kind: 'idle' });
              }}
            />
          )}
        </>
      )}
    </section>
  );
}
