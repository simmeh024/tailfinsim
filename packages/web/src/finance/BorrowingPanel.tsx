import { useEffect, useMemo, useState } from 'react';

import {
  CREDIT_INSTRUMENTS,
  type BorrowingConstraint,
  type CreditStandingResponse,
  type CreditTier,
  type FleetAirframeView,
  type LoanInstrument,
} from '@tailfin/shared';

import { activeCurrency, formatUsdMinor, inputToUsdMinor } from '../currency/display';
import { drawLoan } from '../dashboard/api';
import { fetchFleetAirframes } from '../fleet/api';
import { Button } from '../ui/Button';
import { StateBlock } from '../ui/StateBlock';

import type { ReactNode } from 'react';

/**
 * Borrowing: what the airline may borrow, why not more, and what it costs
 * (SURFACE-02, design doc §13).
 *
 * > **Loans support, they never carry.**
 *
 * §13 is a teaching system, and the risk this surface was filed against is
 * reducing it to an amount field and a submit button. So the order is the
 * lesson's: **standing** (the tier, what earned it, what the next rung asks),
 * **capacity** (§13.1's three limits with the binding one named), **the
 * instruments** (§13.3's table, all five), **drawing** one, and **what it is
 * costing** — §13.4's interest as a share of profit, the number that makes 6%
 * comfortable and 52% ruinous.
 *
 * ## The client decides nothing
 *
 * Every rate, cap, term, multiplier and share on this panel is the server's —
 * `GET /api/credit` carries them precisely so nothing here is computed from a
 * balance number the client happens to know (SEC-09). The draw sends an
 * instrument, an amount and, for aircraft finance, the airframe; a refusal is
 * the server's and is shown as it was given, with the standing left exactly as
 * it was. A draw is **never retried**: it has no idempotency key, and a retried
 * timeout could be two loans.
 *
 * ## What it links to rather than builds
 *
 * §13.5's default ladder is LEGACY-11 (#1036)'s surface. This panel says where
 * the airline stands on it — the stage, what is owed and the server's own words
 * for what clears it — and stops there.
 *
 * ## Debt
 *
 * Its tables are local markup standing in for UX-06 (#467)'s shared table, and
 * its figures for UX-03 (#464)'s metric component; neither has landed.
 */

const TIER_LABEL: Record<CreditTier, string> = {
  startup: 'Startup',
  D: 'D',
  C: 'C',
  B: 'B',
  A: 'A',
  AA: 'AA',
};

const INSTRUMENT_LABEL: Record<LoanInstrument, string> = {
  working_capital: 'Working capital line',
  aircraft_finance: 'Aircraft finance',
  facility: 'Facility loan',
};

function percent(bps: number): string {
  return `${(bps / 100).toFixed(1)}%`;
}

function share(fraction: number | null): string {
  return fraction === null ? 'no profit to be a share of' : `${(fraction * 100).toFixed(0)}%`;
}

/** §13.1's three limits, in its own words, with the server's multipliers. */
function constraintLabel(
  constraint: BorrowingConstraint,
  formula: CreditStandingResponse['formula'],
): string {
  switch (constraint) {
    case 'tier_cap':
      return 'Your credit tier’s cap';
    case 'profit_multiple':
      return `${formula.profitMultiple.toFixed(1)} × trailing operating profit`;
    case 'asset_advance':
      return `${formula.assetAdvanceRate.toFixed(2)} × tangible assets`;
  }
}

export interface BorrowingPanelProps {
  credit: CreditStandingResponse;
  /** The whole standing after a draw, which the server returns. */
  onChange: (credit: CreditStandingResponse) => void;
}

export function BorrowingPanel({ credit, onChange }: BorrowingPanelProps): ReactNode {
  return (
    <>
      <StandingSection credit={credit} />
      <CapacitySection credit={credit} />
      <InstrumentsSection credit={credit} />
      <DrawSection credit={credit} onChange={onChange} />
      <DebtSection credit={credit} />
    </>
  );
}

/** The tier, what earned it, and what the next rung asks for (§13.2). */
function StandingSection({ credit }: { credit: CreditStandingResponse }): ReactNode {
  const next = credit.nextTier;
  const t = credit.trailing;
  const rising = credit.earnedTier !== credit.tier;
  return (
    <section className="panel" aria-label="Credit standing">
      <h3 className="panel__title">Credit standing</h3>
      <dl className="figures">
        <div className="figures__row">
          <dt>Rating</dt>
          <dd className="figure">
            {TIER_LABEL[credit.tier]}
            {credit.tier === 'startup' && <span className="chip chip--calm">founder facility</span>}
          </dd>
        </div>
        <div className="figures__row">
          <dt>Price at this rating</dt>
          <dd className="figure">
            {percent(credit.annualRateBps)} over {String(credit.termMonths)} months
          </dd>
        </div>
        <div className="figures__row">
          <dt>What your trading earns</dt>
          <dd className="figure">{TIER_LABEL[credit.earnedTier]}</dd>
        </div>
      </dl>
      {/*
        §13.2: "Ratings fall faster than they rise." Said as a property of the
        rating, with the streak behind it, so a rise that has not arrived yet is
        not a surprise and a fall is not a bug.
      */}
      <p className="panel__note">
        Ratings fall faster than they rise: a bad review drops you to what your trading earns at
        once, and a rise waits for {String(credit.rating.reviewsToRise)} good reviews in a row
        {rising
          ? ` — ${String(credit.rating.goodReviews)} of ${String(credit.rating.reviewsToRise)} so far.`
          : '.'}{' '}
        A review happens at most once a game month.
      </p>
      {next === null ? (
        <p className="panel__note">AA is the top of the ladder.</p>
      ) : (
        <div className="table-scroll">
          <table className="data-table" aria-label={`What ${TIER_LABEL[next.tier]} asks for`}>
            <caption className="visually-hidden">
              What {TIER_LABEL[next.tier]} asks for, against what you have
            </caption>
            <thead>
              <tr>
                <th scope="col">{`To reach ${TIER_LABEL[next.tier]}`}</th>
                <th scope="col" className="data-table__num">
                  Needed
                </th>
                <th scope="col" className="data-table__num">
                  You have
                </th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <th scope="row">Profitable months, of the last twelve</th>
                <td className="data-table__num figure">{next.requires.profitableMonths}</td>
                <td className="data-table__num figure">{t.profitableMonths}</td>
              </tr>
              <tr>
                <th scope="row">Active routes</th>
                <td className="data-table__num figure">{next.requires.routes}</td>
                <td className="data-table__num figure">{t.routes}</td>
              </tr>
              <tr>
                <th scope="row">Hubs</th>
                <td className="data-table__num figure">{next.requires.hubs}</td>
                <td className="data-table__num figure">{t.hubs}</td>
              </tr>
              <tr>
                <th scope="row">Operating margin</th>
                <td className="data-table__num figure">
                  {`${(next.requires.operatingMargin * 100).toFixed(0)}%`}
                </td>
                <td className="data-table__num figure">
                  {t.operatingMargin === null ? '—' : `${(t.operatingMargin * 100).toFixed(1)}%`}
                </td>
              </tr>
            </tbody>
          </table>
          <p className="panel__note">
            {`${TIER_LABEL[next.tier]} lends up to ${formatUsdMinor(next.maxDebtMinor)} at ${percent(next.annualRateBps)}. Every requirement is needed, not most of them.`}
          </p>
        </div>
      )}
    </section>
  );
}

/**
 * §13.1's three limits, the binding one named — and, for an airline that is
 * losing money, why it cannot borrow, in the formula's own terms.
 */
function CapacitySection({ credit }: { credit: CreditStandingResponse }): ReactNode {
  const { limits, formula, trailing } = credit;
  const founder = credit.tier === 'startup';
  const rows: { constraint: BorrowingConstraint; detail: string; valueMinor: number }[] = [
    {
      constraint: 'tier_cap',
      detail: `${TIER_LABEL[credit.tier]} tier`,
      valueMinor: limits.tierCapMinor,
    },
    {
      constraint: 'profit_multiple',
      detail: `of ${formatUsdMinor(trailing.operatingProfitMinor)} over twelve game months`,
      valueMinor: limits.profitMultipleMinor,
    },
    {
      constraint: 'asset_advance',
      detail: `of ${formatUsdMinor(trailing.tangibleAssetValueMinor)} in owned aircraft`,
      valueMinor: limits.assetAdvanceMinor,
    },
  ];
  const losing = trailing.operatingProfitMinor <= 0;

  return (
    <section className="panel" aria-label="Borrowing capacity">
      <h3 className="panel__title">What you may borrow</h3>
      <p className="panel__note">
        The lowest of three limits (§13.1). Capacity follows demonstrated profit, not ambition.
      </p>
      <div className="table-scroll">
        <table className="data-table">
          <caption className="visually-hidden">§13.1’s three borrowing limits</caption>
          <thead>
            <tr>
              <th scope="col">Limit</th>
              <th scope="col" className="data-table__num">
                Allows
              </th>
              <th scope="col">Binding</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const binding = row.constraint === credit.bindingConstraint;
              const exempt = founder && row.constraint !== 'tier_cap';
              return (
                <tr key={row.constraint} data-binding={binding}>
                  <th scope="row">
                    {constraintLabel(row.constraint, formula)}{' '}
                    <span className="panel__note">{row.detail}</span>
                  </th>
                  <td className="data-table__num figure">
                    {exempt ? 'not applied' : formatUsdMinor(row.valueMinor)}
                  </td>
                  <td>
                    {binding ? (
                      <span className="chip chip--warn">binding</span>
                    ) : exempt ? (
                      <span className="panel__note">founder facility is exempt</span>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <dl className="figures">
        <div className="figures__row">
          <dt>Maximum debt</dt>
          <dd className="figure">{formatUsdMinor(credit.maxTotalDebtMinor)}</dd>
        </div>
        <div className="figures__row">
          <dt>Owed now</dt>
          <dd className="figure">{formatUsdMinor(credit.outstandingDebtMinor)}</dd>
        </div>
        <div className="figures__row">
          <dt>Left to draw</dt>
          <dd className="figure">{formatUsdMinor(credit.headroomMinor)}</dd>
        </div>
      </dl>

      {credit.canBorrow ? (
        <p className="panel__note">
          {`Binding: ${constraintLabel(credit.bindingConstraint, formula).toLowerCase()}. That is the limit to grow if you need more.`}
        </p>
      ) : credit.bindingConstraint === 'profit_multiple' && losing ? (
        /*
          §13.1's lesson, in its own terms rather than as a disabled button: "If
          you're losing money, 3.0 × operating profit is zero or negative. You
          cannot borrow at all. No special-case rule needed — the formula does it."
        */
        <StateBlock kind="refused">
          {`You are not making money: ${formula.profitMultiple.toFixed(1)} × your trailing operating profit of ${formatUsdMinor(trailing.operatingProfitMinor)} is ${formatUsdMinor(limits.profitMultipleMinor)}, so you cannot borrow at all. Loans support, they never carry — no rule refuses you, the formula does.`}
        </StateBlock>
      ) : (
        <StateBlock kind="refused">{credit.refusal ?? 'You cannot borrow right now.'}</StateBlock>
      )}
    </section>
  );
}

/** §13.3's table, all five, with each drawable one priced by the server. */
function InstrumentsSection({ credit }: { credit: CreditStandingResponse }): ReactNode {
  const quotes = new Map(credit.instruments.map((quote) => [quote.instrument, quote] as const));
  return (
    <section className="panel" aria-label="Instruments">
      <h3 className="panel__title">Instruments</h3>
      <div className="table-scroll">
        <table className="data-table">
          <caption className="visually-hidden">§13.3’s five instruments</caption>
          <thead>
            <tr>
              <th scope="col">Instrument</th>
              <th scope="col">Secured on</th>
              <th scope="col" className="data-table__num">
                Rate
              </th>
              <th scope="col">For</th>
            </tr>
          </thead>
          <tbody>
            {CREDIT_INSTRUMENTS.map((instrument) => {
              const quote =
                instrument.availability === 'loan'
                  ? quotes.get(instrument.id as LoanInstrument)
                  : undefined;
              // The instrument's spread over the tier, from two server figures.
              const spread =
                quote === undefined ? 0 : (quote.annualRateBps - credit.annualRateBps) / 100;
              return (
                <tr key={instrument.id}>
                  <th scope="row">{instrument.name}</th>
                  <td>{instrument.securedOn}</td>
                  <td className="data-table__num figure">
                    {quote === undefined ? (
                      instrument.rateRule
                    ) : (
                      <>
                        {percent(quote.annualRateBps)}{' '}
                        <span className="panel__note">
                          {spread === 0
                            ? '(the tier rate)'
                            : `(tier ${spread > 0 ? '+' : '−'}${Math.abs(spread).toFixed(1)} pts)`}
                        </span>
                      </>
                    )}
                  </td>
                  <td>
                    {instrument.purpose}
                    {instrument.availability === 'not_built' && (
                      <span className="chip chip--calm">not built yet</span>
                    )}
                    {instrument.availability === 'post_mvp' && (
                      <span className="chip chip--calm">post-MVP</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="panel__note">
        Sale-leaseback is not a loan and is not built: it needs the fleet to hold a lease obligation
        on an airframe, which it cannot yet. Bond issues are AA-only and post-MVP.
      </p>
    </section>
  );
}

type DrawState =
  | { step: 'editing' }
  | { step: 'confirming'; principalMinor: number }
  | { step: 'drawing'; principalMinor: number }
  | { step: 'refused'; message: string }
  | { step: 'drawn'; principalMinor: number };

/** Drawing one, through the existing endpoint and its server-decided terms. */
function DrawSection({
  credit,
  onChange,
}: {
  credit: CreditStandingResponse;
  onChange: (credit: CreditStandingResponse) => void;
}): ReactNode {
  const [instrument, setInstrument] = useState<LoanInstrument>('working_capital');
  const [amount, setAmount] = useState('');
  const [airframeId, setAirframeId] = useState('');
  const [state, setState] = useState<DrawState>({ step: 'editing' });
  const [fleet, setFleet] = useState<FleetAirframeView[] | 'loading' | 'broken'>('loading');

  const quote = credit.instruments.find((entry) => entry.instrument === instrument);
  const secured = quote?.security === 'airframe';

  // The airframes a lender could take — only needed for aircraft finance.
  useEffect(() => {
    if (!secured) return;
    let live = true;
    void fetchFleetAirframes()
      .then((body) => {
        if (live) setFleet(body.airframes);
      })
      .catch(() => {
        if (live) setFleet('broken');
      });
    return () => {
      live = false;
    };
  }, [secured]);

  const principalMinor = useMemo(() => inputToUsdMinor(amount), [amount]);

  if (!credit.canBorrow) {
    // The reason is stated above in §13.1's terms; a dead form here would only
    // repeat it with a greyed button.
    return null;
  }

  const ready =
    principalMinor !== undefined && principalMinor > 0 && (!secured || airframeId !== '');

  const submit = async (amountMinor: number): Promise<void> => {
    setState({ step: 'drawing', principalMinor: amountMinor });
    const outcome = await drawLoan({
      instrument,
      principalMinor: amountMinor,
      ...(secured ? { securedAirframeId: airframeId } : {}),
    });
    if (outcome.ok) {
      onChange(outcome.credit);
      setAmount('');
      setState({ step: 'drawn', principalMinor: amountMinor });
    } else {
      // The standing on screen is left exactly as it was: a refusal changed nothing.
      setState({ step: 'refused', message: outcome.message });
    }
  };

  return (
    <section className="panel" aria-label="Draw a loan">
      <h3 className="panel__title">Draw a loan</h3>
      <form
        className="draw-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (ready && principalMinor !== undefined) {
            setState({ step: 'confirming', principalMinor });
          }
        }}
      >
        <label className="draw-form__field">
          <span>Instrument</span>
          <select
            value={instrument}
            onChange={(event) => {
              setInstrument(event.target.value as LoanInstrument);
              setState({ step: 'editing' });
            }}
          >
            {credit.instruments.map((entry) => (
              <option key={entry.instrument} value={entry.instrument}>
                {`${INSTRUMENT_LABEL[entry.instrument]} — ${percent(entry.annualRateBps)}`}
              </option>
            ))}
          </select>
        </label>
        <label className="draw-form__field">
          <span>{`Amount (${activeCurrency()})`}</span>
          <input
            inputMode="decimal"
            value={amount}
            onChange={(event) => {
              setAmount(event.target.value);
              setState({ step: 'editing' });
            }}
          />
        </label>
        {secured && (
          <label className="draw-form__field">
            <span>Secured on</span>
            {fleet === 'loading' ? (
              <StateBlock kind="loading">Reading your fleet.</StateBlock>
            ) : fleet === 'broken' ? (
              <StateBlock kind="broken">Your fleet could not be read.</StateBlock>
            ) : fleet.length === 0 ? (
              <StateBlock kind="empty">
                Aircraft finance is secured on an airframe, and you have none to pledge.
              </StateBlock>
            ) : (
              <select
                value={airframeId}
                onChange={(event) => {
                  setAirframeId(event.target.value);
                  setState({ step: 'editing' });
                }}
              >
                <option value="">Choose an airframe</option>
                {fleet.map((airframe) => (
                  <option key={airframe.airframeId} value={airframe.airframeId}>
                    {`${airframe.registration} · ${airframe.typeDesignation}`}
                  </option>
                ))}
              </select>
            )}
          </label>
        )}
        <p className="panel__note">
          {`Up to ${formatUsdMinor(credit.headroomMinor)} is left to draw. The rate and term are the bank’s: ${quote ? `${percent(quote.annualRateBps)} over ${String(quote.termMonths)} months` : 'set when you draw'}.`}
        </p>

        {state.step === 'confirming' || state.step === 'drawing' ? (
          <div className="draw-form__confirm">
            <p className="panel__note">
              {`Borrow ${formatUsdMinor(state.principalMinor)} as a ${INSTRUMENT_LABEL[instrument].toLowerCase()} at ${quote ? percent(quote.annualRateBps) : 'the bank’s rate'}. Interest is charged every game day and shows in the P&L as its own line.`}
            </p>
            <Button
              variant="primary"
              size="sm"
              disabled={state.step === 'drawing'}
              onClick={() => {
                void submit(state.principalMinor);
              }}
            >
              {state.step === 'drawing'
                ? 'Drawing…'
                : `Confirm — borrow ${formatUsdMinor(state.principalMinor)}`}
            </Button>
            <Button
              variant="tertiary"
              size="sm"
              disabled={state.step === 'drawing'}
              onClick={() => {
                setState({ step: 'editing' });
              }}
            >
              Keep
            </Button>
          </div>
        ) : (
          <Button type="submit" size="sm" disabled={!ready}>
            Review the loan
          </Button>
        )}
      </form>

      {state.step === 'refused' && <StateBlock kind="refused">{state.message}</StateBlock>}
      {state.step === 'drawn' && (
        <p className="panel__note" role="status">
          {`Borrowed ${formatUsdMinor(state.principalMinor)}. It is in your cash now, and its interest starts tomorrow.`}
        </p>
      )}
    </section>
  );
}

/**
 * What is owed and what it costs — §13.4's worked example as a table: interest
 * per month, and that interest as a share of the profit it comes out of.
 */
function DebtSection({ credit }: { credit: CreditStandingResponse }): ReactNode {
  const standing = credit.standing;
  return (
    <section className="panel" aria-label="Debt and interest">
      <h3 className="panel__title">What it is costing</h3>
      <dl className="figures">
        <div className="figures__row">
          <dt>DSCR</dt>
          <dd className="figure">
            {credit.dscr === null ? 'no debt' : credit.dscr.toFixed(2)}
            {credit.dscr !== null && credit.dscr < credit.minimumDscr && (
              <span className="chip chip--warn">below {credit.minimumDscr.toFixed(2)} floor</span>
            )}
          </dd>
        </div>
        <div className="figures__row">
          {/* §13.4's drain, per in-game day, which is how it is actually charged. */}
          <dt>Interest drain</dt>
          <dd className="figure">{formatUsdMinor(standing.dailyInterestMinor)} / game day</dd>
        </div>
        <div className="figures__row">
          <dt>Interest a month</dt>
          <dd className="figure">{formatUsdMinor(credit.interest.monthlyMinor)}</dd>
        </div>
        <div className="figures__row">
          <dt>Share of operating profit</dt>
          <dd className="figure">{share(credit.interest.shareOfOperatingProfit)}</dd>
        </div>
      </dl>

      {/*
        §13.5's ladder: where the airline stands on it, in the server's words,
        and no further. The surface that explains the ladder and what clears it
        is LEGACY-11 (#1036)'s.
      */}
      {standing.stage !== 'none' && (
        <StateBlock kind="refused">
          {`${standing.stage.replace('_', ' ')}: ${standing.message ?? 'payments are in arrears.'} ${formatUsdMinor(standing.arrearsMinor)} is owed.${standing.cureByAt === null ? '' : ` Cure by ${standing.cureByAt.slice(0, 10)}.`}`}
        </StateBlock>
      )}

      {credit.loans.length === 0 ? (
        <StateBlock kind="empty">Nothing borrowed.</StateBlock>
      ) : (
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">Instrument</th>
                <th scope="col" className="data-table__num">
                  Outstanding
                </th>
                <th scope="col" className="data-table__num">
                  Rate
                </th>
                <th scope="col" className="data-table__num">
                  Per day
                </th>
                <th scope="col" className="data-table__num">
                  Per month
                </th>
                <th scope="col" className="data-table__num">
                  Of your profit
                </th>
              </tr>
            </thead>
            <tbody>
              {credit.loans.map((loan) => (
                <tr key={loan.id}>
                  <th scope="row">{loan.instrument.replace('_', ' ')}</th>
                  <td className="data-table__num figure">
                    {formatUsdMinor(loan.outstandingMinor)}
                  </td>
                  <td className="data-table__num figure">{percent(loan.annualRateBps)}</td>
                  <td className="data-table__num figure">
                    {formatUsdMinor(loan.dailyInterestMinor)}
                  </td>
                  <td className="data-table__num figure">
                    {formatUsdMinor(loan.monthlyInterestMinor)}
                  </td>
                  <td className="data-table__num figure">{share(loan.shareOfOperatingProfit)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="panel__note">
        §13.4: a loan costing 6% of your profit is genuinely useful; one costing half of it means
        you work for the bank. A list, not an amortisation schedule: nothing repays principal yet,
        so a payment timetable would promise something the game does not do.
      </p>
    </section>
  );
}
