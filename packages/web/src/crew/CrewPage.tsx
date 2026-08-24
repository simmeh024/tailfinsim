import { useCallback, useEffect, useMemo, useState } from 'react';

import type { CrewRank, CrewResponse } from '@tailfin/shared';

import { useContextSelection } from '../shell/context-selection';
import { useWorldClock } from '../world/useWorldClock';

import {
  fetchCrew,
  hireCrew,
  openCrewBase,
  setCrewReserve,
  startCrewConversion,
  type CrewFailure,
} from './api';
import { bannerPriorityRanks } from './crew-presentation';
import { CrewActions, type CrewActionKind } from './CrewActions';
import { CrewBaseTable, poolKey } from './CrewBaseTable';
import { CrewCoverage, coverageKey } from './CrewCoverage';
import { CrewKpiStrip } from './CrewKpiStrip';
import { CREW_RANK_LABEL, CrewRoleBanner } from './CrewRoleBanner';
import { FleetCommonality } from './FleetCommonality';
import { TrainingPipeline } from './TrainingPipeline';

import type { ReactNode } from 'react';

/**
 * Crew operations (M5-01, M5-02, §9.2).
 *
 * ## The order is the argument
 *
 * Status, then problem, then cause, then action. Coverage and shortages first,
 * because they are the only figures that are a verdict; then which family is
 * short; then why one qualification does not cover the fleet; then the controls.
 * The previous version gave a table, three permanent forms and four paragraphs
 * of explanation equal weight, so the page had to be read rather than glanced at.
 *
 * ## Pools, and still no way to reach a person
 *
 * There is no roster here and no row for a crew member, because there is no crew
 * member. M5-01 is blunt about the failure mode: *"if they have to hand-roster
 * 400 flight attendants, the feature has failed."* Every control moves a
 * **number**, and the surest way to make hand-rostering inevitable later is to
 * ship something today that looks like a name.
 *
 * ## "Required" is a floor and every surface says so
 *
 * It is one departure per aeroplane owned. A single aircraft flying a day of
 * rotations needs several crews, and working out how many is duty-aware
 * rostering — which does not exist. Duty and rest **are** modelled as of M5-02;
 * rosters are not, so nothing here may say *"all flights covered today"*. The
 * wording throughout is "minimum requirement", and it is chosen so that it stays
 * true rather than needing a redesign when rostering lands.
 *
 * ## Nothing on this page decides anything
 *
 * Every figure arrives from `/api/crew`. `packages/web` may not import
 * `@tailfin/sim` (§21), and `crew-presentation.ts` holds the folds — regroupings,
 * counts and ratios of numbers the server already decided. No component here
 * works out what an aeroplane needs, what a hire costs, or whether a head is
 * qualified.
 */

type Load =
  { state: 'loading' } | { state: 'ready'; value: CrewResponse | null } | { state: 'failed' };

/** What the player has clicked, in whichever table. */
interface Selection {
  /** Absent for a coverage row, which is about the whole airline's fleet. */
  baseId?: string;
  family: string;
  rank: CrewRank;
}

export function CrewPage(): ReactNode {
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const [refusal, setRefusal] = useState<CrewFailure | null>(null);
  const [busy, setBusy] = useState(false);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [openAction, setOpenAction] = useState<CrewActionKind | null>(null);

  const { inGameTime } = useWorldClock();
  const { select, clear } = useContextSelection();

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

  /*
   * A selection outlives the route that made it unless somebody clears it, and a
   * crew pool shown while the player is looking at their fleet is worse than an
   * empty panel.
   */
  useEffect(() => clear, [clear]);

  /**
   * Every mutation answers with the whole state, so this is the only writer.
   *
   * `undefined` means **leave the state alone**, which is what a refusal wants.
   * Returning the state captured in the render closure instead is stale the
   * moment anything has succeeded, and once reverted the page to "no crew" while
   * the base sat happily in the database.
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

  const run = useCallback(
    (outcome: Promise<{ ok: true; state: CrewResponse } | { ok: false; refusal: CrewFailure }>) => {
      void apply(async () => {
        const result = await outcome;
        if (result.ok) return result.state;
        setRefusal(result.refusal);
        return undefined;
      });
    },
    [apply],
  );

  const crew = load.state === 'ready' ? load.value : null;

  /* The panel is rebuilt whenever the numbers move, so it cannot show a stale
     headcount for a row that has just been hired into. */
  useEffect(() => {
    if (crew === null || selection === null) return;
    select({
      kind: 'crew-pool',
      id: `${selection.baseId ?? 'fleet'}/${selection.family}/${selection.rank}`,
      title: `${selection.family} · ${CREW_RANK_LABEL[selection.rank]}`,
      subtitle:
        selection.baseId === undefined
          ? 'Across the airline'
          : (crew.bases.find((base) => base.id === selection.baseId)?.airportIcao ?? undefined),
      body: (
        <CrewContextBody
          crew={crew}
          selection={selection}
          onAction={(kind) => {
            setOpenAction(kind);
          }}
        />
      ),
    });
  }, [crew, selection, select]);

  const priorityRanks = useMemo(() => (crew === null ? [] : bannerPriorityRanks(crew)), [crew]);

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
          Could not load your crew. Coverage is unknown until it loads — nothing here is assumed.
        </p>
      </div>
    );
  }
  if (crew === null) {
    return (
      <div className="crew">
        {title}
        <p className="crew__note">Found an airline first — crew belong to one.</p>
      </div>
    );
  }

  const selectedCoverage =
    selection && selection.baseId === undefined
      ? coverageKey(selection.family, selection.rank)
      : null;
  const selectedPool =
    selection?.baseId !== undefined
      ? poolKey(selection.baseId, selection.family, selection.rank)
      : null;

  return (
    <div className="crew">
      <header className="crew__header">
        {title}
        <p className="crew__subtitle">Coverage, qualifications and training across your network.</p>
      </header>

      {refusal !== null && (
        <p className="crew__refusal" role="alert">
          {refusal.message}
        </p>
      )}

      <CrewKpiStrip crew={crew} />

      <CrewRoleBanner priorityRanks={priorityRanks} />

      <div className="crew-split">
        <CrewCoverage
          crew={crew}
          selectedKey={selectedCoverage}
          onSelect={(next) => {
            setSelection(next);
          }}
        />
        <FleetCommonality crew={crew} />
      </div>

      <CrewBaseTable
        crew={crew}
        selectedKey={selectedPool}
        onSelect={(next) => {
          setSelection(next);
        }}
      />

      <div className="crew-split">
        <TrainingPipeline crew={crew} inGameTime={inGameTime} />
        <CrewActions
          crew={crew}
          busy={busy}
          open={openAction}
          onOpenChange={setOpenAction}
          prefill={
            selection === null
              ? undefined
              : {
                  crewBaseId: selection.baseId,
                  family: selection.family,
                  rank: selection.rank,
                }
          }
          onHire={(input) => {
            run(hireCrew(input));
          }}
          onConvert={(input) => {
            run(startCrewConversion(input));
          }}
          onOpenBase={(input) => {
            run(openCrewBase(input));
          }}
          onSetReserve={(input) => {
            run(setCrewReserve(input));
          }}
        />
      </div>

      <HowCrewWork />
    </div>
  );
}

/**
 * What the context panel shows for a selected pool.
 *
 * Deliberately **no forecast**. A "next 7 days" strip would need schedule-aware
 * crew demand, which does not exist — and a fabricated one would be the single
 * most convincing wrong number on the page. When a forecast is real it slots in
 * here without moving anything else.
 */
function CrewContextBody({
  crew,
  selection,
  onAction,
}: {
  crew: CrewResponse;
  selection: Selection;
  onAction: (kind: CrewActionKind) => void;
}): ReactNode {
  const demand = crew.demand.rows.find(
    (row) => row.family === selection.family && row.rank === selection.rank,
  );

  const pools = crew.bases
    .filter((base) => selection.baseId === undefined || base.id === selection.baseId)
    .flatMap((base) => base.pools)
    .filter((pool) => pool.family === selection.family && pool.rank === selection.rank);

  const sum = (pick: (pool: (typeof pools)[number]) => number): number =>
    pools.reduce((total, pool) => total + pick(pool), 0);

  return (
    <div className="crew-context">
      <dl className="crew-context__facts">
        {demand !== undefined && (
          <div>
            <dt>Minimum required</dt>
            <dd className="figure">{demand.required}</dd>
          </div>
        )}
        <div>
          <dt>On strength</dt>
          <dd className="figure">{sum((pool) => pool.headcount)}</dd>
        </div>
        <div>
          <dt>Available</dt>
          <dd className="figure">{sum((pool) => pool.available)}</dd>
        </div>
        <div>
          <dt>In training</dt>
          <dd className="figure">{sum((pool) => pool.unavailable)}</dd>
        </div>
        <div>
          <dt>On duty</dt>
          <dd className="figure">{sum((pool) => pool.onDuty)}</dd>
        </div>
        <div>
          <dt>Standby</dt>
          <dd className="figure">{sum((pool) => pool.reserve)}</dd>
        </div>
        {demand !== undefined && (
          <div>
            <dt>Balance</dt>
            <dd className="figure">
              {demand.delta === 0
                ? 'Exact'
                : demand.delta > 0
                  ? `+${String(demand.delta)}`
                  : String(demand.delta)}
            </dd>
          </div>
        )}
      </dl>

      <h3 className="crew-context__heading">Qualification</h3>
      <p className="crew-context__note">
        Rated on <span className="figure">{selection.family}</span> only. Crew are qualified per
        family, so these cannot fly anything else until they are converted.
      </p>

      <h3 className="crew-context__heading">Actions</h3>
      <div className="crew-context__actions">
        <button
          type="button"
          onClick={() => {
            onAction('hire');
          }}
        >
          Hire crew
        </button>
        <button
          type="button"
          onClick={() => {
            onAction('convert');
          }}
        >
          Convert rating
        </button>
        <button
          type="button"
          onClick={() => {
            onAction('reserve');
          }}
        >
          Set standby
        </button>
      </div>
    </div>
  );
}

/**
 * The rules, behind a disclosure.
 *
 * They were four paragraphs of permanent page height explaining mechanics a
 * returning player already knows. Hidden by default and one click away — but
 * **not** removed: these are game rules, and a rule a player cannot find is a
 * rule they will discover by losing money.
 */
function HowCrewWork(): ReactNode {
  return (
    <details className="crew-help">
      <summary>How crew work</summary>
      <ul className="crew__notes">
        <li>
          Crew are pooled by <strong>rank, family and base</strong>. There are no individuals to
          roster.
        </li>
        <li>
          A type rating is per aircraft <strong>family</strong>. Converting costs money and takes
          the crew off the roster for the whole course.
        </li>
        <li>Captains take time to grow. Hiring is capped per week, not priced per hurry.</li>
        <li>A base carries a monthly overhead, so one per destination is the wrong shape.</li>
        <li>A flight cannot be scheduled without a legal complement rated on its family.</li>
        <li>
          <strong>Required is a floor</strong> — one departure per aeroplane you own, not a day of
          rotations. Duty and rest are modelled; rostering is not, so this figure is the minimum and
          never a promise about a schedule.
        </li>
        <li>
          Crew have duty limits. A day that runs long times them out, and the flight delays or
          cancels until a rested crew is available.
        </li>
        <li>
          Standby crew cost the same as anyone else and fly nothing most days. That is the trade,
          not a bug.
        </li>
      </ul>
    </details>
  );
}
