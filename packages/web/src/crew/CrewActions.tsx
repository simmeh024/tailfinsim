import { useState } from 'react';

import type { CrewRank, CrewResponse } from '@tailfin/shared';

import { RANK_ORDER } from './crew-presentation';
import { CREW_RANK_LABEL } from './CrewRoleBanner';

import type { ReactNode } from 'react';

/**
 * The four things a player can do about their crew.
 *
 * ## Cards that open a form, not four permanent forms
 *
 * The previous page kept every form expanded, which cost most of a screen to
 * show three sets of controls nobody was using yet. These are cards until
 * clicked; one form opens below them at a time.
 *
 * Not a modal. The project has no dialog pattern, and `FleetPage`'s precedent —
 * detail rendered inline with a close button — is a perfectly good one that
 * needs no new machinery. A modal would also hide the coverage table, which is
 * the thing the player is deciding *against*.
 *
 * ## Every consequence shown is the server's
 *
 * Costs, the weekly hiring cap, the conversion duration: all from
 * `CrewResponse.costs`. The forms restate them so a decision can be made without
 * guessing, and enforce nothing — a hire larger than the cap is refused by
 * `hireCrew` with `hiring_capacity`, and the page shows what it says. Validating
 * client-side would be a second copy of a rule, and the copy nobody audits.
 *
 * The one exception is `max` on the heads input, which is a hint to the widget
 * and not a gate: the server still refuses, and the refusal still renders.
 */

export type CrewActionKind = 'hire' | 'convert' | 'base' | 'reserve';

export interface CrewActionsProps {
  crew: CrewResponse;
  busy: boolean;
  onHire: (input: { crewBaseId: string; family: string; rank: CrewRank; heads: number }) => void;
  onConvert: (input: {
    crewBaseId: string;
    fromFamily: string;
    toFamily: string;
    rank: CrewRank;
    heads: number;
  }) => void;
  onOpenBase: (input: { airportIcao: string }) => void;
  onSetReserve: (input: {
    crewBaseId: string;
    family: string;
    rank: CrewRank;
    reserve: number;
  }) => void;
  /** Set by the context panel's actions, so a row can open the right form. */
  open: CrewActionKind | null;
  onOpenChange: (kind: CrewActionKind | null) => void;
  /** Prefilled from the selected row, when there is one. */
  prefill?: { crewBaseId?: string; family?: string; rank?: CrewRank };
}

const CARDS: { kind: CrewActionKind; title: string; blurb: string; cta: string }[] = [
  {
    kind: 'hire',
    title: 'Hire crew',
    blurb: 'Grow a pool at a base you already hold.',
    cta: 'Hire',
  },
  {
    kind: 'convert',
    title: 'Convert rating',
    blurb: 'Qualify crew you have for another aircraft family.',
    cta: 'Convert',
  },
  {
    kind: 'reserve',
    title: 'Hold on standby',
    blurb: 'Keep heads off the roster to cover a crew that runs out of hours.',
    cta: 'Set standby',
  },
  {
    kind: 'base',
    title: 'Open crew base',
    blurb: 'Establish crew at another airport.',
    cta: 'Open base',
  },
];

export function CrewActions({
  crew,
  busy,
  onHire,
  onConvert,
  onOpenBase,
  onSetReserve,
  open,
  onOpenChange,
  prefill,
}: CrewActionsProps): ReactNode {
  const openBases = crew.bases.filter((base) => base.status === 'open');
  const families = [
    ...new Set([...crew.families, ...crew.bases.flatMap((b) => b.pools.map((p) => p.family))]),
  ].sort((a, b) => a.localeCompare(b));

  const [baseId, setBaseId] = useState('');
  const [family, setFamily] = useState('');
  const [toFamily, setToFamily] = useState('');
  const [rank, setRank] = useState<CrewRank>('captain');
  const [heads, setHeads] = useState(1);
  const [reserve, setReserve] = useState(0);
  const [icao, setIcao] = useState('');

  /*
   * Prefill wins over local state while it is present. A player who clicked the
   * short ATR captains row and then "Hire" means *those* captains; making them
   * re-pick the base and family they just selected is the kind of small
   * indignity that stops people using the context panel at all.
   */
  const currentBase = prefill?.crewBaseId ?? (baseId === '' ? openBases[0]?.id : baseId);
  const currentFamily = prefill?.family ?? (family === '' ? (families[0] ?? '') : family);
  const currentRank = prefill?.rank ?? rank;
  const currentTo = toFamily === '' ? (families.find((f) => f !== currentFamily) ?? '') : toFamily;

  const noBase = openBases.length === 0;

  return (
    <section className="crew-panel" aria-labelledby="crew-actions-heading">
      <div className="crew-panel__head">
        <h2 className="crew-panel__title" id="crew-actions-heading">
          Actions
        </h2>
      </div>

      <ul className="crew-cards">
        {CARDS.map((card) => (
          <li key={card.kind}>
            <button
              type="button"
              className="crew-card"
              aria-expanded={open === card.kind}
              onClick={() => {
                onOpenChange(open === card.kind ? null : card.kind);
              }}
            >
              <span className="crew-card__title">{card.title}</span>
              <span className="crew-card__blurb">{card.blurb}</span>
              <span className="crew-card__cta" aria-hidden="true">
                {card.cta} →
              </span>
            </button>
          </li>
        ))}
      </ul>

      {open !== null && (
        <div className="crew-form">
          {noBase && open !== 'base' ? (
            <p className="crew__note">Open a crew base first — crew are hired and held at one.</p>
          ) : open === 'hire' ? (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                if (currentBase === undefined) return;
                onHire({
                  crewBaseId: currentBase,
                  family: currentFamily,
                  rank: currentRank,
                  heads,
                });
              }}
            >
              <div className="crew-form__fields">
                <BaseField bases={openBases} value={currentBase ?? ''} onChange={setBaseId} />
                <FamilyField
                  label="Family"
                  families={families}
                  value={currentFamily}
                  onChange={setFamily}
                />
                <RankField value={currentRank} onChange={setRank} />
                <label>
                  Heads
                  <input
                    type="number"
                    min={1}
                    max={crew.costs.weeklyHiringCapacity}
                    value={heads}
                    onChange={(event) => {
                      setHeads(Number(event.target.value));
                    }}
                  />
                </label>
              </div>
              <p className="crew__hint">
                {formatCash(
                  FLIGHT_DECK.includes(currentRank)
                    ? crew.costs.hireFlightDeckMinor
                    : crew.costs.hireCabinMinor,
                )}{' '}
                each · up to {crew.costs.weeklyHiringCapacity} a week. You cannot buy a Captain
                instantly; growing one takes time, and time is the constraint money cannot route
                around.
              </p>
              <button type="submit" disabled={busy}>
                Hire crew
              </button>
            </form>
          ) : open === 'convert' ? (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                if (currentBase === undefined) return;
                onConvert({
                  crewBaseId: currentBase,
                  fromFamily: currentFamily,
                  toFamily: currentTo,
                  rank: currentRank,
                  heads,
                });
              }}
            >
              <div className="crew-form__fields">
                <BaseField bases={openBases} value={currentBase ?? ''} onChange={setBaseId} />
                <FamilyField
                  label="From family"
                  families={families}
                  value={currentFamily}
                  onChange={setFamily}
                />
                <FamilyField
                  label="To family"
                  families={families}
                  value={currentTo}
                  onChange={setToFamily}
                />
                <RankField value={currentRank} onChange={setRank} />
                <label>
                  Heads
                  <input
                    type="number"
                    min={1}
                    value={heads}
                    onChange={(event) => {
                      setHeads(Number(event.target.value));
                    }}
                  />
                </label>
              </div>
              <p className="crew__hint">
                {formatCash(crew.costs.conversionPerHeadMinor)} each ·{' '}
                {crew.costs.conversionDurationDays} world days off the roster. Converting changes
                what crew are <em>qualified</em> on — it does not create anybody.
              </p>
              <button type="submit" disabled={busy}>
                Start conversion
              </button>
            </form>
          ) : open === 'reserve' ? (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                if (currentBase === undefined) return;
                onSetReserve({
                  crewBaseId: currentBase,
                  family: currentFamily,
                  rank: currentRank,
                  reserve,
                });
              }}
            >
              <div className="crew-form__fields">
                <BaseField bases={openBases} value={currentBase ?? ''} onChange={setBaseId} />
                <FamilyField
                  label="Family"
                  families={families}
                  value={currentFamily}
                  onChange={setFamily}
                />
                <RankField value={currentRank} onChange={setRank} />
                <label>
                  Standby heads
                  <input
                    type="number"
                    min={0}
                    value={reserve}
                    onChange={(event) => {
                      setReserve(Number(event.target.value));
                    }}
                  />
                </label>
              </div>
              <p className="crew__hint">
                A level, not a change. Standby crew are paid exactly like everyone else and fly
                nothing — until a rotation slips, and they are the difference between a delay and a
                cancellation.
              </p>
              <button type="submit" disabled={busy}>
                Set standby
              </button>
            </form>
          ) : (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                onOpenBase({ airportIcao: icao.trim().toUpperCase() });
              }}
            >
              <div className="crew-form__fields">
                <label>
                  Airport
                  <input
                    value={icao}
                    onChange={(event) => {
                      setIcao(event.target.value);
                    }}
                    placeholder="EHAM"
                    maxLength={4}
                    required
                  />
                </label>
              </div>
              {/*
               * The opening cost is quoted; the monthly overhead is not, because
               * `costs` does not carry it on its own — only the airline's whole
               * payroll, which is a different number. Naming it would mean
               * inventing it.
               */}
              <p className="crew__hint">
                {formatCash(crew.costs.baseOpeningMinor)} to open, then a monthly overhead charged
                whether or not anybody is posted there — which is what makes a base per destination
                the wrong shape.
              </p>
              <button type="submit" disabled={busy}>
                Open base
              </button>
            </form>
          )}
        </div>
      )}
    </section>
  );
}

const FLIGHT_DECK: readonly CrewRank[] = [
  'cadet',
  'first_officer',
  'senior_first_officer',
  'captain',
  'training_captain',
];

function BaseField({
  bases,
  value,
  onChange,
}: {
  bases: readonly { id: string; airportIcao: string }[];
  value: string;
  onChange: (value: string) => void;
}): ReactNode {
  return (
    <label>
      Base
      <select
        value={value}
        onChange={(event) => {
          onChange(event.target.value);
        }}
      >
        {bases.map((base) => (
          <option key={base.id} value={base.id}>
            {base.airportIcao}
          </option>
        ))}
      </select>
    </label>
  );
}

/**
 * A picker, never a text box.
 *
 * The first version of this page had free text, and a pool rated on a family
 * literally called `test` is still sitting in the dev database because of it. A
 * rating that matches no aeroplane can never be used and cannot be spent away.
 */
function FamilyField({
  label,
  families,
  value,
  onChange,
}: {
  label: string;
  families: readonly string[];
  value: string;
  onChange: (value: string) => void;
}): ReactNode {
  return (
    <label>
      {label}
      <select
        value={value}
        onChange={(event) => {
          onChange(event.target.value);
        }}
      >
        {families.map((family) => (
          <option key={family} value={family}>
            {family}
          </option>
        ))}
      </select>
    </label>
  );
}

/** Every rank the enum holds, in promotion order — not the three the page used to show. */
function RankField({
  value,
  onChange,
}: {
  value: CrewRank;
  onChange: (rank: CrewRank) => void;
}): ReactNode {
  return (
    <label>
      Rank
      <select
        value={value}
        onChange={(event) => {
          onChange(event.target.value as CrewRank);
        }}
      >
        {RANK_ORDER.map((rank) => (
          <option key={rank} value={rank}>
            {CREW_RANK_LABEL[rank]}
          </option>
        ))}
      </select>
    </label>
  );
}

function formatCash(minor: number): string {
  return (minor / 100).toLocaleString('en-GB', { maximumFractionDigits: 0 });
}
