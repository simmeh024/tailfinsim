import { useCallback, useEffect, useState } from 'react';

import type { CrewBaseView, CrewPoolView, CrewRank, CrewResponse } from '@tailfin/shared';

import { fetchCrew, hireCrew, openCrewBase, startCrewConversion, type CrewFailure } from './api';

import type { ReactNode } from 'react';

/**
 * Crew (M5-01, §9.2).
 *
 * ## Pools, and no way to reach a person
 *
 * There is no roster on this page and there is no row for a crew member,
 * because there is no crew member. The issue is blunt about the failure mode:
 * *"if they have to hand-roster 400 flight attendants, the feature has failed."*
 * Every control here moves a **number** — hire six, convert three — and the
 * hardest way to build hand-rostering later is to have shipped nothing that
 * looks like a name.
 *
 * ## Fragmentation is the headline, because §9.2's complaint is that it is quiet
 *
 * A mixed fleet *"quietly wrecks your utilisation"*. The quiet is the bug, so the
 * cost of commonality is the first thing on the page rather than something a
 * player infers by adding up two tables. There is no penalty coefficient behind
 * the number — crew rated on one family are simply not in another's pool — and
 * the panel says so, because a figure that looks like a fine invites the question
 * "how do I avoid the fine?" when the answer is "fly one family".
 *
 * Every figure is the server's. `packages/web` may not import `@tailfin/sim`, so
 * `available` arrives computed rather than subtracted here — the rule for what
 * counts as available is the server's, and duty and rest will make it more than
 * "not in a classroom".
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

/** Integer minor units; the currency itself remains M8-02's decision. */
function formatCash(minor: number): string {
  return (minor / 100).toLocaleString('en-GB', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  });
}

/** `2024-10-28`, UTC, as everywhere else that shows a world date. */
function formatDate(iso: string): string {
  return iso.slice(0, 10);
}

type Load =
  { state: 'loading' } | { state: 'ready'; value: CrewResponse | null } | { state: 'failed' };

function Fragmentation({ crew }: { crew: CrewResponse }): ReactNode {
  const { families, totalAvailable, largestFamilyAvailable, strandedHeads } = crew.fragmentation;

  if (families.length === 0) {
    return (
      <p className="crew__note">
        No crew yet. Open a base and hire before scheduling — a flight needs a legal complement, and
        an airline with none cannot put one on the books.
      </p>
    );
  }

  return (
    <div className="crew__fragmentation">
      <p className="crew__note">
        {families.length === 1 ? (
          <>
            One family, <span className="figure">{families[0]}</span>: every one of your{' '}
            <span className="figure">{totalAvailable}</span> available crew can fly every aeroplane
            you own.
          </>
        ) : (
          <>
            <span className="figure">{families.length}</span> families. Of{' '}
            <span className="figure">{totalAvailable}</span> available crew, the largest family can
            call on <span className="figure">{largestFamilyAvailable}</span> —{' '}
            <span className="figure">{strandedHeads}</span> cannot fly it.
          </>
        )}
      </p>
      {families.length > 1 && (
        <p className="crew__hint">
          {/* No count in this sentence: the number is already in the line above,
              and repeating it here read as "those 1 fly their own aeroplanes"
              whenever exactly one crew member was stranded. */}
          Not a penalty: crew are rated per family, so the rest fly their own aeroplanes and no
          others. Fleet commonality is what buys them back.
        </p>
      )}
    </div>
  );
}

function PoolRows({ pools }: { pools: readonly CrewPoolView[] }): ReactNode {
  if (pools.length === 0) return <p className="crew__note">No crew at this base yet.</p>;

  return (
    <table className="crew__table">
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

function BaseSection({
  base,
  costs,
  onHire,
  onConvert,
  busy,
}: {
  base: CrewBaseView;
  costs: CrewResponse['costs'];
  onHire: (crewBaseId: string, family: string, rank: CrewRank, heads: number) => void;
  onConvert: (crewBaseId: string, from: string, to: string, rank: CrewRank, heads: number) => void;
  busy: boolean;
}): ReactNode {
  const [family, setFamily] = useState('');
  const [rank, setRank] = useState<CrewRank>('captain');
  const [heads, setHeads] = useState(1);
  const [toFamily, setToFamily] = useState('');

  const families = [...new Set(base.pools.map((pool) => pool.family))];

  return (
    <section className="crew__base">
      <h2 className="crew__heading">
        <span className="figure">{base.airportIcao}</span>
        {base.status === 'closed' && ' · closed'}
      </h2>

      <PoolRows pools={base.pools} />

      {base.conversions.length > 0 && (
        <>
          <h3 className="crew__subheading">In conversion</h3>
          <table className="crew__table">
            <thead>
              <tr>
                <th scope="col">Rank</th>
                <th scope="col">From</th>
                <th scope="col">To</th>
                <th scope="col">Heads</th>
                <th scope="col">Back on</th>
              </tr>
            </thead>
            <tbody>
              {base.conversions.map((conversion) => (
                <tr key={conversion.id}>
                  <td>{RANK_LABEL[conversion.rank]}</td>
                  <td className="figure">{conversion.fromFamily}</td>
                  <td className="figure">{conversion.toFamily}</td>
                  <td className="figure">{conversion.heads}</td>
                  {/* World time. A conversion runs on the world's clock, so this
                      arrives sooner in a faster world. */}
                  <td className="figure">{formatDate(conversion.completesAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      <form
        className="crew__form"
        onSubmit={(event) => {
          event.preventDefault();
          onHire(base.id, family.trim(), rank, heads);
        }}
      >
        <h3 className="crew__subheading">Hire</h3>
        <label>
          Family
          <input
            value={family}
            onChange={(event) => setFamily(event.target.value)}
            placeholder="A320neo"
            required
          />
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
            max={costs.weeklyHiringCapacity}
            value={heads}
            onChange={(event) => setHeads(Number(event.target.value))}
          />
        </label>
        <button type="submit" disabled={busy || base.status === 'closed'}>
          Hire
        </button>
        <p className="crew__hint">
          Up to <span className="figure">{costs.weeklyHiringCapacity}</span> a week. You cannot buy
          a Captain instantly; growing one takes time, and that is the constraint money cannot route
          around.
        </p>
      </form>

      {families.length > 0 && (
        <form
          className="crew__form"
          onSubmit={(event) => {
            event.preventDefault();
            onConvert(base.id, family.trim(), toFamily.trim(), rank, heads);
          }}
        >
          <h3 className="crew__subheading">Convert type rating</h3>
          <label>
            To family
            <input
              value={toFamily}
              onChange={(event) => setToFamily(event.target.value)}
              placeholder="737 MAX"
              required
            />
          </label>
          <button type="submit" disabled={busy || base.status === 'closed'}>
            Convert
          </button>
          <p className="crew__hint">
            Uses the family, rank and heads above.{' '}
            <span className="figure">{formatCash(costs.conversionPerHeadMinor)}</span> each, and{' '}
            <span className="figure">{costs.conversionDurationDays}</span> days off the roster —
            which is the part that hurts.
          </p>
        </form>
      )}
    </section>
  );
}

export function CrewPage(): ReactNode {
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const [refusal, setRefusal] = useState<CrewFailure | null>(null);
  const [busy, setBusy] = useState(false);
  const [icao, setIcao] = useState('');

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
   * The first version returned the `crew` captured in the render closure
   * instead, and that is a stale value the moment anything has succeeded since:
   * opening a base and then asking for the same one again reverted the page to
   * "no crew yet" while the base sat happily in the database. Found by using it
   * on dev, not by a test.
   */
  const apply = useCallback(async (run: () => Promise<CrewResponse | undefined>) => {
    setBusy(true);
    setRefusal(null);
    try {
      const next = await run();
      if (next !== undefined) setLoad({ state: 'ready', value: next });
    } finally {
      setBusy(false);
    }
  }, []);

  /*
   * The title renders in every state, including while loading.
   *
   * Returning a bare "Loading…" instead makes the page briefly headingless,
   * which moves the document outline under a screen reader and — as the shell's
   * routing test found — means there is a moment when nothing on screen says
   * which page this is.
   */
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

  const run = (
    call: Promise<{ ok: true; state: CrewResponse } | { ok: false; refusal: CrewFailure }>,
  ) =>
    void apply(async () => {
      const outcome = await call;
      if (outcome.ok) return outcome.state;
      setRefusal(outcome.refusal);
      return undefined;
    });

  return (
    <div className="crew">
      {title}

      <Fragmentation crew={crew} />

      {refusal !== null && (
        <p className="crew__refusal" role="alert">
          {refusal.message}
        </p>
      )}

      {crew.bases.map((base) => (
        <BaseSection
          key={base.id}
          base={base}
          costs={crew.costs}
          busy={busy}
          onHire={(crewBaseId, family, rank, heads) => {
            run(hireCrew({ crewBaseId, family, rank, heads }));
          }}
          onConvert={(crewBaseId, fromFamily, toFamily, rank, heads) => {
            run(startCrewConversion({ crewBaseId, fromFamily, toFamily, rank, heads }));
          }}
        />
      ))}

      <form
        className="crew__form"
        onSubmit={(event) => {
          event.preventDefault();
          run(openCrewBase({ airportIcao: icao.trim().toUpperCase() }));
        }}
      >
        <h2 className="crew__subheading">Open a crew base</h2>
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
          Open
        </button>
        <p className="crew__hint">
          <span className="figure">{formatCash(crew.costs.baseOpeningMinor)}</span> to open, and a
          monthly overhead afterwards — which is what makes a base per destination the wrong shape.
        </p>
      </form>
    </div>
  );
}
