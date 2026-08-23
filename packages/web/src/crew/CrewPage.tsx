import { useCallback, useEffect, useState } from 'react';

import type { CrewBaseView, CrewPoolView, CrewRank, CrewResponse } from '@tailfin/shared';

import { fetchCrew, hireCrew, openCrewBase, startCrewConversion, type CrewFailure } from './api';
import { crewBanner } from './crew-banners';
import { CrewReadiness } from './CrewReadiness';

import type { ReactNode } from 'react';

/**
 * Crew (M5-01, §9.2).
 *
 * ## Pools, and no way to reach a person
 *
 * There is no roster on this page and no row for a crew member, because there is
 * no crew member. The issue is blunt about the failure mode: *"if they have to
 * hand-roster 400 flight attendants, the feature has failed."* Every control here
 * moves a **number**, and the hardest way to build hand-rostering later is to
 * have shipped nothing that looks like a name.
 *
 * ## Cover first, inventory second
 *
 * The page opens with whether the crew can fly the fleet, not with how many there
 * are. A headcount is a fact; *"short two Captains on the 737 MAX"* is a
 * decision, and the decision is what somebody opened this page for.
 *
 * **"Required" is a floor and says so wherever it appears.** It is one departure
 * per aeroplane — a single aircraft flying a day of rotations needs several
 * crews, and working that out is duty and rest, which §9.2 defers. A number that
 * quietly pretended to be a rostering answer would be worse than no number.
 *
 * ## Fragmentation is stated, because §9.2's complaint is that it is quiet
 *
 * A mixed fleet *"quietly wrecks your utilisation"*. There is no penalty
 * coefficient behind the figure — crew rated on one family are simply not in
 * another's pool — and the page says so, because a number that reads as a fine
 * invites "how do I avoid the fine?" when the answer is "fly one family".
 *
 * Every figure is the server's. `packages/web` may not import `@tailfin/sim`, so
 * `available` and the whole demand fold arrive computed (§21).
 */

const RANK_LABEL: Record<CrewRank, string> = {
  cadet: 'Cadet',
  first_officer: 'First Officer',
  senior_first_officer: 'Senior First Officer',
  captain: 'Captain',
  training_captain: 'Training Captain',
  cabin_crew: 'Cabin Crew',
  senior_cabin_crew: 'Senior Cabin Crew',
  purser: 'Purser',
  cabin_service_manager: 'Cabin Service Manager',
};

/**
 * One line per rank, shown on the banner.
 *
 * Says what the rank *does* rather than restating the ladder: the promotion
 * order is already visible in the picker, and repeating it here would be a
 * caption that adds nothing.
 */
const RANK_BLURB: Record<CrewRank, string> = {
  cadet: 'In training for the right-hand seat. Cannot yet operate a flight.',
  first_officer: 'The right-hand seat. Every flight needs one.',
  senior_first_officer: 'A first officer with the hours to cover a captain’s slot.',
  captain: 'Commands the aircraft. Grown over weeks, never bought in a hurry.',
  training_captain: 'Commands, and makes the next captain.',
  cabin_crew: 'One for every fifty seats fitted, by regulation.',
  senior_cabin_crew: 'Experienced cabin crew, able to lead a smaller cabin.',
  purser: 'Leads the cabin from a hundred seats up.',
  cabin_service_manager: 'Runs the cabin on the widebodies.',
};

const FLIGHT_DECK_RANKS: readonly CrewRank[] = [
  'cadet',
  'first_officer',
  'senior_first_officer',
  'captain',
  'training_captain',
];

/**
 * Integer minor units, and **no currency symbol**.
 *
 * The currency is deliberately unnamed until M8-02 and every other surface shows
 * cash bare. A `$` here would be inventing the answer to an open question on the
 * strength of a mockup.
 */
function formatCash(minor: number): string {
  return (minor / 100).toLocaleString('en-GB', { maximumFractionDigits: 0 });
}

/** `2024-10-28` — UTC, as everywhere else that shows a world date. */
function formatDate(iso: string): string {
  return iso.slice(0, 10);
}

type Load =
  { state: 'loading' } | { state: 'ready'; value: CrewResponse | null } | { state: 'failed' };

function Stat({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail: string;
}): ReactNode {
  return (
    <div className="crew-stat">
      <span className="crew-stat__label">{label}</span>
      <span className="crew-stat__value figure">{value}</span>
      <span className="crew-stat__detail">{detail}</span>
    </div>
  );
}

function DemandRows({ crew }: { crew: CrewResponse }): ReactNode {
  const { rows } = crew.demand;
  if (rows.length === 0) {
    return (
      <p className="crew__note">
        No aircraft and no crew yet. Cover appears here once you own an aeroplane or hire somebody.
      </p>
    );
  }

  return (
    <table className="crew__table">
      <caption className="visually-hidden">Fleet cover by family and rank</caption>
      <thead>
        <tr>
          <th scope="col">Family</th>
          <th scope="col">Rank</th>
          <th scope="col">Required</th>
          <th scope="col">Available</th>
          <th scope="col">Surplus / shortage</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={`${row.family}-${row.rank}`} data-cover={row.delta < 0 ? 'short' : 'ok'}>
            <td className="figure">{row.family}</td>
            <td>{RANK_LABEL[row.rank]}</td>
            <td className="figure">{row.required}</td>
            <td className="figure">{row.available}</td>
            <td>
              <span className="crew-delta" data-cover={row.delta < 0 ? 'short' : 'ok'}>
                {row.delta > 0 ? `+${String(row.delta)}` : String(row.delta)}
              </span>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function PoolRows({
  pools,
  airportIcao,
}: {
  pools: readonly CrewPoolView[];
  airportIcao: string;
}): ReactNode {
  if (pools.length === 0) return <p className="crew__note">No crew at this base yet.</p>;

  return (
    <table className="crew__table">
      <caption className="visually-hidden">Crew at {airportIcao}</caption>
      <thead>
        <tr>
          <th scope="col">Family</th>
          <th scope="col">Rank</th>
          <th scope="col">On strength</th>
          <th scope="col">In training</th>
          <th scope="col">Available</th>
        </tr>
      </thead>
      <tbody>
        {pools.map((pool) => (
          <tr key={pool.id}>
            <td className="figure">{pool.family}</td>
            <td>{RANK_LABEL[pool.rank]}</td>
            <td className="figure">{pool.headcount}</td>
            {/* Shown rather than netted off, so crew in a classroom are visibly
                still yours — which is the whole point of conversion taking time. */}
            <td className="figure">{pool.unavailable === 0 ? '—' : pool.unavailable}</td>
            <td className="figure">{pool.available}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function TrainingPipeline({ bases }: { bases: readonly CrewBaseView[] }): ReactNode {
  const conversions = bases.flatMap((base) =>
    base.conversions.map((conversion) => ({ ...conversion, airportIcao: base.airportIcao })),
  );

  if (conversions.length === 0) {
    return (
      <p className="crew__note">
        No training in progress. Convert a type rating and the crew appear here until they qualify.
      </p>
    );
  }

  return (
    <table className="crew__table">
      <caption className="visually-hidden">Conversions in progress</caption>
      <thead>
        <tr>
          <th scope="col">Base</th>
          <th scope="col">Rank</th>
          <th scope="col">From</th>
          <th scope="col">To</th>
          <th scope="col">Heads</th>
          <th scope="col">Back on</th>
        </tr>
      </thead>
      <tbody>
        {conversions.map((conversion) => (
          <tr key={conversion.id}>
            <td className="figure">{conversion.airportIcao}</td>
            <td>{RANK_LABEL[conversion.rank]}</td>
            <td className="figure">{conversion.fromFamily}</td>
            <td className="figure">{conversion.toFamily}</td>
            <td className="figure">{conversion.heads}</td>
            {/* World time: a conversion runs on the world's clock, so this
                arrives sooner in a faster world. */}
            <td className="figure">{formatDate(conversion.completesAt)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function CrewPage(): ReactNode {
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const [refusal, setRefusal] = useState<CrewFailure | null>(null);
  const [busy, setBusy] = useState(false);

  const [icao, setIcao] = useState('');
  const [baseId, setBaseId] = useState('');
  const [family, setFamily] = useState('');
  const [rank, setRank] = useState<CrewRank>('captain');
  const [heads, setHeads] = useState(1);
  const [toFamily, setToFamily] = useState('');

  useEffect(() => {
    let live = true;
    void fetchCrew()
      .then((value) => {
        if (live) setLoad({ state: 'ready', value });
      })
      .catch(() => {
        if (live) setLoad({ state: 'failed' });
      });
    return () => {
      live = false;
    };
  }, []);

  /**
   * Every mutation answers with the whole state, so this is the only writer.
   *
   * `undefined` means **leave the state alone**, which is what a refusal wants.
   * Returning the state captured in the render closure instead is stale the
   * moment anything has succeeded, and reverted the page to "no crew" while the
   * base sat happily in the database.
   */
  const apply = useCallback(async (call: () => Promise<CrewResponse | undefined>) => {
    setBusy(true);
    setRefusal(null);
    try {
      const next = await call();
      if (next !== undefined) setLoad({ state: 'ready', value: next });
    } finally {
      setBusy(false);
    }
  }, []);

  const title = <h1 className="crew__title">Crew</h1>;

  if (load.state === 'loading') {
    return (
      <div className="crew">
        {title}
        <p className="crew__note">Loading…</p>
      </div>
    );
  }
  if (load.state === 'failed') {
    return (
      <div className="crew">
        {title}
        <p className="crew__note" role="alert">
          Could not load your crew.
        </p>
      </div>
    );
  }
  if (load.value === null) {
    return (
      <div className="crew">
        {title}
        <p className="crew__note">Found an airline first — crew belong to one.</p>
      </div>
    );
  }

  const crew = load.value;
  const openBases = crew.bases.filter((base) => base.status === 'open');
  const pools = crew.bases.flatMap((base) => base.pools);
  const onStrength = pools.reduce((total, pool) => total + pool.headcount, 0);
  const inTraining = pools.reduce((total, pool) => total + pool.unavailable, 0);
  const available = crew.fragmentation.totalAvailable;
  const selectedBase = baseId === '' ? openBases[0]?.id : baseId;
  const familyOptions = [...new Set([...crew.families, ...pools.map((pool) => pool.family)])];

  const run = (
    outcome: Promise<{ ok: true; state: CrewResponse } | { ok: false; refusal: CrewFailure }>,
  ) =>
    void apply(async () => {
      const result = await outcome;
      if (result.ok) return result.state;
      setRefusal(result.refusal);
      return undefined;
    });

  return (
    <div className="crew">
      <header className="crew__header">
        {title}
        <p className="crew__subtitle">Pools, training and bases across your network.</p>
      </header>

      {/*
       * The banner follows the rank picker below it. It is the one place the page
       * shows a person, and it can be: it illustrates the rank being hired, not a
       * member of staff who exists.
       *
       * **Shown whole, never cropped.** The artwork carries its own headline and
       * body copy baked into the pixels, so `object-fit: cover` ate the first
       * letter of every line — the first version rendered "ommand the aircraft"
       * and overlaid a caption of its own on top of the one already there. The
       * height therefore follows each image's aspect ratio, which does move the
       * page a little when the rank changes; that only happens on a deliberate
       * click, and it is the price of not mangling the artwork.
       *
       * `key` on the rank so React swaps the element rather than mutating the
       * `src` of the one already painted — without it the browser keeps showing
       * the previous image until the new one decodes, which reads as the selector
       * having done nothing.
       *
       * The alt carries the baked-in message, because text inside a picture is
       * text a screen reader cannot reach.
       */}
      <img
        key={rank}
        className="crew-banner"
        src={crewBanner(rank).src}
        srcSet={crewBanner(rank).srcSet}
        sizes="(max-width: 48rem) 440px, 880px"
        alt={`${RANK_LABEL[rank]}. ${RANK_BLURB[rank]}`}
        width={880}
        height={217}
      />

      <div className="crew-stats">
        <Stat
          label="Total crew"
          value={String(onStrength)}
          detail={
            openBases.length === 1 ? 'Across 1 base' : `Across ${String(openBases.length)} bases`
          }
        />
        <Stat
          label="Available"
          value={String(available)}
          detail={
            onStrength === 0
              ? 'Nobody hired yet'
              : `${String(Math.round((available / onStrength) * 100))}% of crew`
          }
        />
        <Stat
          label="In training"
          value={String(inTraining)}
          detail={inTraining === 0 ? 'No conversions running' : 'Back when their course ends'}
        />
        <Stat
          label="Open bases"
          value={String(openBases.length)}
          detail="Crew are hired at a base"
        />
      </div>

      {refusal !== null && (
        <p className="crew__refusal" role="alert">
          {refusal.message}
        </p>
      )}

      <section className="crew__panel">
        <h2 className="crew__heading">Fleet cover</h2>
        <p className="crew__hint">
          <strong>Required</strong> is one departure per aeroplane you own — a floor, not a roster.
          A single aircraft flying a day of rotations needs several crews; duty and rest are not
          modelled yet, so this is the smallest number that can be true.
        </p>
        <DemandRows crew={crew} />
        {crew.demand.uncoveredFamilies.length > 0 && (
          <p className="crew__refusal" role="status">
            No crew at all rated on {crew.demand.uncoveredFamilies.join(', ')}. Those aeroplanes
            cannot be scheduled.
          </p>
        )}
      </section>

      <div className="crew__split">
        <section className="crew__panel">
          <h2 className="crew__heading">Readiness</h2>
          <CrewReadiness
            available={available}
            inTraining={inTraining}
            required={crew.demand.totalRequired}
            met={crew.demand.metRequired}
            covered={crew.demand.covered}
          />
        </section>

        <section className="crew__panel">
          <h2 className="crew__heading">Commonality</h2>
          {crew.fragmentation.families.length === 0 ? (
            <p className="crew__note">
              No crew yet. Open a base and hire before scheduling — a flight needs a legal
              complement, and an airline with none cannot put one on the books.
            </p>
          ) : crew.fragmentation.families.length === 1 ? (
            <p className="crew__note">
              One family, <span className="figure">{crew.fragmentation.families[0]}</span>: every
              one of your <span className="figure">{available}</span> available crew can fly every
              aeroplane you own.
            </p>
          ) : (
            <>
              <p className="crew__note">
                <span className="figure">{crew.fragmentation.families.length}</span> families. Of{' '}
                <span className="figure">{available}</span> available crew, the largest family can
                call on <span className="figure">{crew.fragmentation.largestFamilyAvailable}</span>{' '}
                — <span className="figure">{crew.fragmentation.strandedHeads}</span> cannot fly it.
              </p>
              <p className="crew__hint">
                Not a penalty: crew are rated per family, so the rest fly their own aeroplanes and
                no others. Fleet commonality is what buys them back.
              </p>
            </>
          )}
        </section>
      </div>

      {crew.bases.map((base) => (
        <section className="crew__panel" key={base.id}>
          <h2 className="crew__heading">
            <span className="figure">{base.airportIcao}</span>
            {base.status === 'closed' && ' · closed'}
          </h2>
          <PoolRows pools={base.pools} airportIcao={base.airportIcao} />
        </section>
      ))}

      <section className="crew__panel">
        <h2 className="crew__heading">Training pipeline</h2>
        <TrainingPipeline bases={crew.bases} />
      </section>

      <div className="crew__actions">
        <section className="crew-action">
          <h2 className="crew-action__title">
            <span className="crew-action__step">1</span> Hire crew
          </h2>
          <p className="crew__hint">Grow a pool at a base you already hold.</p>
          <form
            className="crew__form"
            onSubmit={(event) => {
              event.preventDefault();
              if (selectedBase === undefined) return;
              run(hireCrew({ crewBaseId: selectedBase, family, rank, heads }));
            }}
          >
            <label>
              Base
              <select
                value={selectedBase ?? ''}
                onChange={(event) => setBaseId(event.target.value)}
              >
                {openBases.map((base) => (
                  <option key={base.id} value={base.id}>
                    {base.airportIcao}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Family
              {/* A picker, not a text box. The free-text version created a pool
                  rated on a family called `test`, which no aeroplane matches and
                  no amount of money can undo. */}
              <select value={family} onChange={(event) => setFamily(event.target.value)} required>
                <option value="">Choose…</option>
                {familyOptions.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Rank
              <select value={rank} onChange={(event) => setRank(event.target.value as CrewRank)}>
                {Object.entries(RANK_LABEL).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Heads
              <input
                type="number"
                min={1}
                max={crew.costs.weeklyHiringCapacity}
                value={heads}
                onChange={(event) => setHeads(Number(event.target.value))}
              />
            </label>
            <button type="submit" disabled={busy || openBases.length === 0}>
              Hire crew
            </button>
            <p className="crew__hint">
              {formatCash(
                FLIGHT_DECK_RANKS.includes(rank)
                  ? crew.costs.hireFlightDeckMinor
                  : crew.costs.hireCabinMinor,
              )}{' '}
              each · up to {crew.costs.weeklyHiringCapacity} a week. You cannot buy a Captain
              instantly; growing one takes time, and time is the constraint money cannot route
              around.
            </p>
          </form>
        </section>

        <section className="crew-action">
          <h2 className="crew-action__title">
            <span className="crew-action__step">2</span> Convert type rating
          </h2>
          <p className="crew__hint">Re-rate crew you already have onto another family.</p>
          <form
            className="crew__form"
            onSubmit={(event) => {
              event.preventDefault();
              if (selectedBase === undefined) return;
              run(
                startCrewConversion({
                  crewBaseId: selectedBase,
                  fromFamily: family,
                  toFamily,
                  rank,
                  heads,
                }),
              );
            }}
          >
            <label>
              To family
              <select
                value={toFamily}
                onChange={(event) => setToFamily(event.target.value)}
                required
              >
                <option value="">Choose…</option>
                {familyOptions.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            </label>
            <button type="submit" disabled={busy || openBases.length === 0}>
              Convert rating
            </button>
            <p className="crew__hint">
              Uses the base, family, rank and heads above.{' '}
              {formatCash(crew.costs.conversionPerHeadMinor)} each ·{' '}
              {crew.costs.conversionDurationDays} days off the roster, which is the part that hurts.
            </p>
          </form>
        </section>

        <section className="crew-action">
          <h2 className="crew-action__title">
            <span className="crew-action__step">3</span> Open a crew base
          </h2>
          <p className="crew__hint">A base is where crew are hired and held.</p>
          <form
            className="crew__form"
            onSubmit={(event) => {
              event.preventDefault();
              run(openCrewBase({ airportIcao: icao.trim().toUpperCase() }));
            }}
          >
            <label>
              Airport
              <input
                value={icao}
                onChange={(event) => setIcao(event.target.value)}
                placeholder="EHAM"
                maxLength={4}
                required
              />
            </label>
            <button type="submit" disabled={busy}>
              Open base
            </button>
            <p className="crew__hint">
              {formatCash(crew.costs.baseOpeningMinor)} to open, then a monthly overhead — which is
              what makes a base per destination the wrong shape.
            </p>
          </form>
        </section>
      </div>

      <section className="crew__panel">
        <h2 className="crew__heading">How crew work</h2>
        <ul className="crew__notes">
          <li>Captains take time to grow. Hiring is capped per week, not priced per hurry.</li>
          <li>Crew are pooled by rank and family, and can fly any aircraft in that family.</li>
          <li>
            A type rating is per family. Converting costs money and a fortnight of availability.
          </li>
          <li>A base carries a monthly overhead, so one per destination is the wrong shape.</li>
          <li>A flight cannot be scheduled without a legal complement rated on its family.</li>
        </ul>
      </section>
    </div>
  );
}
