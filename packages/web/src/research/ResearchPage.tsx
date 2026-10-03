import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router';

import {
  ACADEMY_LEVELS,
  type ResearchNodeId,
  type ResearchNodeView,
  type ResearchRefusal,
  type ResearchResponse,
  type ResearchTier,
} from '@tailfin/shared';

import { Button } from '../ui/Button';
import { StateBlock } from '../ui/StateBlock';

import { fetchResearch, startResearch } from './api';
import {
  academyRequirement,
  accrualExplanation,
  formatGameDate,
  formatHours,
  formatPoints,
  formatStaffQuality,
  gameDaysRemaining,
  nodeById,
  progressFraction,
  refusalInWords,
  remainingInWords,
} from './research-presentation';
import { ResearchNodeCard } from './ResearchNodeCard';

import type { ReactNode } from 'react';

import './research.css';

/**
 * The research tree, "Operational Doctrine" (M9-05, §10.3, §10.5).
 *
 * > *"Airline-wide, permanent unlocks. Distinct from personal skill trees:
 * > **skill trees make one pilot good, research makes your whole airline
 * > good.**"*
 *
 * ## The order is the argument
 *
 * Points first, because they are the constraint on everything below and the one
 * figure §10.3 is most insistent about: *"You cannot buy RP. You cannot rush
 * it."* The header therefore shows the formula with the airline's own numbers
 * in it, so a large airline with no academy can see *which* factor is zero
 * rather than being shown a bare `0.0`. Then the project running, then the tree.
 *
 * ## Tier gating is the whole point
 *
 * §10.3: *"Tier 3 and 4 nodes are visible but locked until you have an academy
 * at the required level. The player can see exactly what they're working toward
 * and what facility investment it demands."* So every node is drawn, priced and
 * labelled with the academy level its tier needs — met or not — and a locked
 * node says why in words. Tiers 3 and 4 are not in this release (issue #92) and
 * say so, with their cost still shown.
 *
 * ## Nothing on this page decides anything
 *
 * Every figure, status and refusal is the server's. `research-presentation.ts`
 * turns codes into sentences and instants into countdowns; it never works out
 * whether a node may start.
 *
 * ## Room for M9-06
 *
 * {@link ResearchView} takes a `readout` slot — §10.4's six quantities against
 * their ceilings — between the points and the tree, and a per-node `nodeFooter`
 * for doctrine strength and funding. Both render nothing until something passes
 * them, so the efficiency work adds a panel rather than rewriting this one.
 */

type Load =
  { state: 'loading' } | { state: 'ready'; value: ResearchResponse | null } | { state: 'failed' };

/** What went wrong on the last start, and on which node. Rendered in words against current state. */
interface StartFailure {
  nodeId: ResearchNodeId;
  kind: 'refused' | 'broken';
  refusal: ResearchRefusal | null;
  message: string;
}

export function ResearchPage(): ReactNode {
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const [confirming, setConfirming] = useState<ResearchNodeId | null>(null);
  const [pending, setPending] = useState<ResearchNodeId | null>(null);
  const [failure, setFailure] = useState<StartFailure | null>(null);

  const reload = useCallback(() => {
    setLoad({ state: 'loading' });
    void fetchResearch()
      .then((value) => {
        setLoad({ state: 'ready', value });
      })
      .catch(() => {
        setLoad({ state: 'failed' });
      });
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  /**
   * The second step of the confirm.
   *
   * Success replaces the whole state with the response, which is the only
   * writer. A refusal means the button said yes and the server said no — the
   * tree was stale (another tab started a project, a flight settled, a payment
   * cleared) — so the refusal is shown on the node *and* the tree is re-read
   * quietly, which leaves every other card telling the truth again.
   */
  const start = useCallback((nodeId: ResearchNodeId) => {
    setPending(nodeId);
    setFailure(null);
    void startResearch({ nodeId })
      .then(async (outcome) => {
        if (outcome.ok) {
          setLoad({ state: 'ready', value: outcome.state });
          return;
        }
        setFailure({
          nodeId,
          kind: 'refused',
          refusal: outcome.failure.refusal,
          message: outcome.failure.message,
        });
        try {
          const fresh = await fetchResearch();
          if (fresh !== null) setLoad({ state: 'ready', value: fresh });
        } catch {
          // The refusal is already on screen; a failed re-read leaves the last state.
        }
      })
      .catch(() => {
        setFailure({
          nodeId,
          kind: 'broken',
          refusal: null,
          message:
            'The request did not complete, so whether the project started is unknown. Reload the page to see.',
        });
      })
      .finally(() => {
        setPending(null);
        setConfirming(null);
      });
  }, []);

  return (
    <div className="research">
      {/*
        One header for every state, so the page's heading is the same element
        from the first frame to the loaded tree: the shell moves focus to the
        stage on navigation, and a heading swapped out from under it would be
        announced twice or not at all.
      */}
      <header className="research__header">
        <h1 className="research__title">Research</h1>
        <p className="research__subtitle">
          Operational Doctrine — airline-wide improvements. Skill trees make one pilot good;
          research makes your whole airline good.
        </p>
      </header>
      <ResearchBody
        load={load}
        reload={reload}
        confirming={confirming}
        pending={pending}
        failure={failure}
        onRequestStart={(nodeId) => {
          setFailure(null);
          setConfirming(nodeId);
        }}
        onCancelStart={() => {
          setConfirming(null);
        }}
        onConfirmStart={start}
      />
    </div>
  );
}

function ResearchBody({
  load,
  reload,
  confirming,
  pending,
  failure,
  onRequestStart,
  onCancelStart,
  onConfirmStart,
}: {
  load: Load;
  reload: () => void;
  confirming: ResearchNodeId | null;
  pending: ResearchNodeId | null;
  failure: StartFailure | null;
  onRequestStart: (nodeId: ResearchNodeId) => void;
  onCancelStart: () => void;
  onConfirmStart: (nodeId: ResearchNodeId) => void;
}): ReactNode {
  if (load.state === 'loading') {
    return <StateBlock kind="loading">Reading your research…</StateBlock>;
  }
  if (load.state === 'failed') {
    return (
      <StateBlock
        kind="broken"
        action={
          <Button size="sm" onClick={reload}>
            Try again
          </Button>
        }
      >
        Could not read your research. Points, projects and locks are unknown until it loads —
        nothing here is assumed.
      </StateBlock>
    );
  }
  if (load.value === null) {
    return (
      <StateBlock kind="empty" action={<Link to="/found">Open the founding desk</Link>}>
        No airline to research for yet. Doctrine belongs to an airline — found one first.
      </StateBlock>
    );
  }

  const research = load.value;
  return (
    <ResearchView
      research={research}
      confirming={confirming}
      pending={pending}
      failureFor={(node) => failureInWords(failure, node, research)}
      onRequestStart={onRequestStart}
      onCancelStart={onCancelStart}
      onConfirmStart={onConfirmStart}
    />
  );
}

function failureInWords(
  failure: StartFailure | null,
  node: ResearchNodeView,
  research: ResearchResponse,
): { kind: 'refused' | 'broken'; message: string } | null {
  if (failure?.nodeId !== node.id) return null;
  return {
    kind: failure.kind,
    message:
      failure.refusal === null
        ? failure.message
        : `Not started. ${refusalInWords(failure.refusal, node, research)}`,
  };
}

export interface ResearchViewProps {
  research: ResearchResponse;
  /** The node awaiting its second click, if any. */
  confirming: ResearchNodeId | null;
  /** The node whose start request is in flight, if any. */
  pending: ResearchNodeId | null;
  failureFor: (node: ResearchNodeView) => { kind: 'refused' | 'broken'; message: string } | null;
  onRequestStart: (nodeId: ResearchNodeId) => void;
  onCancelStart: () => void;
  onConfirmStart: (nodeId: ResearchNodeId) => void;
  /** M9-06: §10.4's efficiency readout, between the points and the tree. */
  readout?: ReactNode;
  /** M9-06: doctrine strength and funding, under each node's controls. */
  nodeFooter?: (node: ResearchNodeView) => ReactNode;
}

/**
 * The page's body once there is something to show — everything under the
 * heading. Presentational: every callback is the caller's.
 */
export function ResearchView({
  research,
  confirming,
  pending,
  failureFor,
  onRequestStart,
  onCancelStart,
  onConfirmStart,
  readout,
  nodeFooter,
}: ResearchViewProps): ReactNode {
  return (
    <>
      <div className="research__top">
        <PointsPanel research={research} />
        <ActivePanel research={research} />
      </div>

      {readout}

      <section className="research-panel research-tree-panel" aria-labelledby="research-tree-title">
        <div className="research-panel__head">
          <h2 className="research-panel__title" id="research-tree-title">
            Doctrine tree
          </h2>
          <p className="research-panel__sub">
            Six branches, four tiers. Each node needs the tier before it in its branch researched
            first, and an academy at the level its tier names.
          </p>
        </div>

        <TierLegend research={research} />

        <div className="research-tree">
          {research.branches.map((branch) => {
            const headingId = `research-branch-${branch.branch}`;
            return (
              <section className="research-branch" key={branch.branch} aria-labelledby={headingId}>
                <header className="research-branch__head">
                  <h3 className="research-branch__name" id={headingId}>
                    {branch.name}
                  </h3>
                  <p className="research-branch__summary">{branch.summary}</p>
                </header>
                <ol className="research-branch__nodes">
                  {branch.nodes.map((node, index) => {
                    const above = index === 0 ? undefined : branch.nodes[index - 1];
                    return (
                      <li
                        className="research-branch__step"
                        key={node.id}
                        data-link={
                          above === undefined
                            ? undefined
                            : above.status === 'complete'
                              ? 'complete'
                              : 'pending'
                        }
                      >
                        <ResearchNodeCard
                          node={node}
                          research={research}
                          busy={pending !== null}
                          confirming={confirming === node.id}
                          pending={pending === node.id}
                          onRequestStart={() => {
                            onRequestStart(node.id);
                          }}
                          onCancelStart={onCancelStart}
                          onConfirmStart={() => {
                            onConfirmStart(node.id);
                          }}
                          failure={failureFor(node)}
                          footer={nodeFooter?.(node)}
                        />
                      </li>
                    );
                  })}
                </ol>
              </section>
            );
          })}
        </div>
      </section>
    </>
  );
}

/**
 * §10.3's balance and its formula, with the airline's own numbers.
 *
 * The rate is an observation over seven game days, not a forecast: what the
 * fleet will fly next week is not known here, so the formula's third factor is
 * shown as the quantity it is rather than as a number this page would have to
 * invent.
 */
function PointsPanel({ research }: { research: ResearchResponse }): ReactNode {
  const { points, formula, academy } = research;
  const explanation = accrualExplanation(research);
  const level = ACADEMY_LEVELS.find((row) => row.level === academy.highestLevel);

  return (
    <section className="research-panel research-points" aria-labelledby="research-points-title">
      <div className="research-panel__head">
        <h2 className="research-panel__title" id="research-points-title">
          Research points
        </h2>
      </div>

      <dl className="research-points__figures">
        <div className="research-points__figure research-points__figure--lead">
          <dt>Balance</dt>
          <dd className="figure">{formatPoints(points.balance)} RP</dd>
        </div>
        <div className="research-points__figure">
          <dt>Recent rate</dt>
          <dd>
            <span className="figure">{formatPoints(points.recentPerDay)} RP</span> a game day
            <span className="research-points__qualifier">, averaged over the last seven</span>
          </dd>
        </div>
        <div className="research-points__figure">
          <dt>Earned in total</dt>
          <dd className="figure">{formatPoints(points.earnedTotal)} RP</dd>
        </div>
      </dl>

      <div className="research-formula">
        <p className="research-formula__rule">
          RP/day = Σ academy levels × academy staff quality × (fleet flight hours ÷ scaling factor)
        </p>
        <p className="research-formula__yours">
          <span className="research-formula__label">Yours:</span> Σ academy levels{' '}
          <strong className="figure">{formula.academyLevelSum}</strong> × staff quality{' '}
          <strong className="figure">{formatStaffQuality(formula.academyStaffQuality)}</strong> ×
          (fleet flight hours ÷{' '}
          <strong className="figure">{formatHours(formula.scalingFactorHours)}</strong>)
        </p>
        <p className="research-formula__academy">
          {level === undefined
            ? 'No commissioned academy, so every tier is locked.'
            : `Highest academy: ${level.name} (level ${String(level.level)}), which opens research tier ${String(academy.researchTier ?? level.researchTier)}.`}
        </p>
      </div>

      {explanation !== null && (
        <StateBlock kind="empty" className="research-points__none">
          {explanation}
        </StateBlock>
      )}

      <p className="research-points__rule">
        Research points cannot be bought, and no project can be rushed. Cash pays a project’s bill;
        it never buys the points.
      </p>
    </section>
  );
}

/** The one project running, counted down on the world's clock rather than the browser's. */
function ActivePanel({ research }: { research: ResearchResponse }): ReactNode {
  const { active } = research;
  const node = active === null ? undefined : nodeById(research, active.nodeId);

  return (
    <section className="research-panel research-active" aria-labelledby="research-active-title">
      <div className="research-panel__head">
        <h2 className="research-panel__title" id="research-active-title">
          Active project
        </h2>
        <p className="research-panel__sub">One at a time, airline-wide</p>
      </div>

      {active === null ? (
        <StateBlock kind="empty">
          No project running. Start one from an available node in the tree below.
        </StateBlock>
      ) : (
        <ActiveProject
          name={node?.name ?? active.nodeId}
          tier={node?.tier ?? null}
          branchName={
            node === undefined
              ? null
              : (research.branches.find((branch) => branch.branch === node.branch)?.name ?? null)
          }
          startedAt={active.startedAt}
          completesAt={active.completesAt}
          gameNow={research.gameNow}
        />
      )}
    </section>
  );
}

function ActiveProject({
  name,
  tier,
  branchName,
  startedAt,
  completesAt,
  gameNow,
}: {
  name: string;
  tier: ResearchTier | null;
  branchName: string | null;
  startedAt: string;
  completesAt: string;
  gameNow: string;
}): ReactNode {
  const fraction = progressFraction(startedAt, completesAt, gameNow);
  const days = gameDaysRemaining(gameNow, completesAt);
  const percent = fraction === null ? null : Math.round(fraction * 100);

  return (
    <div className="research-active__body">
      <p className="research-active__name">{name}</p>
      {branchName !== null && tier !== null && (
        <p className="research-active__where">
          {branchName} · Tier {tier}
        </p>
      )}
      {percent !== null && (
        <div
          className="research-active__bar"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
          aria-label={`${name} research progress`}
        >
          <span className="research-active__fill" style={{ inlineSize: `${String(percent)}%` }} />
        </div>
      )}
      {days !== null && <p className="research-active__remaining">{remainingInWords(days)}</p>}
      <dl className="research-active__dates">
        <div>
          <dt>Started</dt>
          <dd className="figure">{formatGameDate(startedAt)}</dd>
        </div>
        <div>
          <dt>Completes</dt>
          <dd className="figure">{formatGameDate(completesAt)}</dd>
        </div>
      </dl>
      <p className="research-active__clock">Game dates, on your world’s clock.</p>
    </div>
  );
}

const TIERS: readonly ResearchTier[] = [1, 2, 3, 4];

/**
 * Each tier and the academy that opens it, read from the nodes themselves.
 *
 * The requirement comes from `requiredAcademyName` / `requiredAcademyLevel` on
 * the tier's nodes — the server's statement of it — rather than from a table
 * here, so the legend and the cards below it cannot disagree.
 */
function TierLegend({ research }: { research: ResearchResponse }): ReactNode {
  const nodes = research.branches.flatMap((branch) => branch.nodes);
  return (
    <ol className="research-tiers" aria-label="Research tiers and the academy each needs">
      {TIERS.map((tier) => {
        const sample = nodes.find((node) => node.tier === tier);
        if (sample === undefined) return null;
        const open =
          research.academy.researchTier !== null && research.academy.researchTier >= tier;
        const state = !sample.released
          ? { key: 'unreleased', glyph: '◇', label: 'Arrives in a later release' }
          : open
            ? { key: 'open', glyph: '✔', label: 'Open to you' }
            : { key: 'locked', glyph: '⊘', label: 'Locked' };
        return (
          <li className="research-tiers__item" key={tier} data-state={state.key}>
            <span className="research-tiers__tier">Tier {tier}</span>
            <span className="research-tiers__requires">{academyRequirement(sample)}</span>
            <span className="research-tiers__state">
              <span aria-hidden="true">{state.glyph}</span> {state.label}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
