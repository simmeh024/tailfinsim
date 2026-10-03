import { useEffect, useId, useRef } from 'react';

import type { ResearchNodeStatus, ResearchNodeView, ResearchResponse } from '@tailfin/shared';

import { Button } from '../ui/Button';
import { StateBlock } from '../ui/StateBlock';

import {
  academyRequirement,
  catalogueTargets,
  effectInWords,
  formatCash,
  formatGameDate,
  formatGameWeeks,
  formatPoints,
  gameDaysRemaining,
  refusalInWords,
  remainingInWords,
  targetsInWords,
} from './research-presentation';

import type { ReactNode } from 'react';

/**
 * One node of §10.3's tree (M9-05).
 *
 * ## Locked is legible, not faded
 *
 * §10.5 asks for locked tiers to be visibly subdued, *"with the facility level
 * required stated plainly"*. Subdued here means a quieter ground and a dashed edge — **not**
 * opacity, which would take the requirement down with the card and leave the
 * one sentence the player needs at the lowest contrast on the page. The
 * requirement and the lock reason stay at full text contrast, and every state
 * carries a glyph and a word as well as a colour (H.4, H.7).
 *
 * ## The button is the server's verdict
 *
 * `startRefusal` is what a `POST` would answer right now. The card never works
 * out for itself whether a node may start: a refusal disables the control and
 * says why beside it, and null is the only state with a live button. So the
 * control and the server cannot disagree, except across a race — which the
 * page answers by showing the 409 and re-reading the tree.
 *
 * ## Room for M9-06
 *
 * `footer` is where doctrine strength and its funding control go once §10.4's
 * upkeep exists. The card renders it last, under the start control, so adding
 * it moves nothing above.
 */

const STATUS_WORDS: Record<ResearchNodeStatus, { glyph: string; label: string }> = {
  complete: { glyph: '✔', label: 'Researched' },
  in_progress: { glyph: '◐', label: 'Researching' },
  available: { glyph: '○', label: 'Available' },
  locked: { glyph: '⊘', label: 'Locked' },
};

export interface ResearchNodeCardProps {
  node: ResearchNodeView;
  research: ResearchResponse;
  /** True while any start request is in flight. One project at a time, so every card waits. */
  busy: boolean;
  /** True on the one card whose start is awaiting confirmation. */
  confirming: boolean;
  /** This card's own request is the one in flight. */
  pending: boolean;
  /** First step: ask for confirmation. */
  onRequestStart: () => void;
  onCancelStart: () => void;
  /** Second step: actually start. */
  onConfirmStart: () => void;
  /** What went wrong the last time this node was started, already in words. */
  failure: { kind: 'refused' | 'broken'; message: string } | null;
  /** M9-06's slot: doctrine strength and funding. Rendered last. */
  footer?: ReactNode;
}

export function ResearchNodeCard({
  node,
  research,
  busy,
  confirming,
  pending,
  onRequestStart,
  onCancelStart,
  onConfirmStart,
  failure,
  footer,
}: ResearchNodeCardProps): ReactNode {
  const headingId = useId();
  const reasonId = useId();
  const status = STATUS_WORDS[node.status];
  const met = node.requiredAcademyLevel <= research.academy.highestLevel;

  /*
   * Focus follows the two-step confirm. Entering it removes the button that was
   * just pressed, which would drop focus to the document; so focus moves to the
   * confirm button, and back to the start button on Cancel. A keyboard user
   * otherwise has to find their place again after every change of mind.
   */
  const confirmRef = useRef<HTMLDivElement>(null);
  const startRef = useRef<HTMLDivElement>(null);
  const wasConfirming = useRef(confirming);
  useEffect(() => {
    if (confirming) confirmRef.current?.querySelector('button')?.focus();
    else if (wasConfirming.current) startRef.current?.querySelector('button')?.focus();
    wasConfirming.current = confirming;
  }, [confirming]);

  return (
    <article
      className="research-node"
      data-status={node.status}
      data-released={node.released}
      aria-labelledby={headingId}
    >
      <div className="research-node__head">
        <p className="research-node__tier">Tier {node.tier}</p>
        <p className="research-node__status" data-status={node.status}>
          <span aria-hidden="true">{status.glyph}</span> {status.label}
        </p>
      </div>
      <h4 className="research-node__name" id={headingId}>
        {node.name}
      </h4>
      <p className="research-node__description">{node.description}</p>

      <Effects node={node} />

      <dl className="research-node__cost">
        <div>
          <dt>Research points</dt>
          <dd className="figure">{formatPoints(node.cost.researchPoints)} RP</dd>
        </div>
        <div>
          <dt>Cash</dt>
          <dd className="figure">{formatCash(node.cost.cashMinor)}</dd>
        </div>
        <div>
          <dt>Takes</dt>
          <dd className="figure">{formatGameWeeks(node.cost.buildWeeks)}</dd>
        </div>
      </dl>

      {/* Every tier, met or not: the player sees what opened it and what opens the next. */}
      <p className="research-node__requires" data-met={met}>
        <span>{academyRequirement(node)}</span>{' '}
        <span className="research-node__met">
          <span aria-hidden="true">{met ? '✔' : '✕'}</span>{' '}
          {met ? 'Your academy meets this' : 'Not yet met'}
        </span>
      </p>

      {node.status === 'locked' && node.startRefusal !== null && (
        <p className="research-node__lock">
          <span className="research-node__lock-label">Locked:</span>{' '}
          {refusalInWords(node.startRefusal, node, research)}
        </p>
      )}

      {node.status === 'in_progress' && node.completesAt !== null && (
        <p className="research-node__progress">
          {progressLine(research.gameNow, node.completesAt)} · completes{' '}
          <span className="figure">{formatGameDate(node.completesAt)}</span> (game date)
        </p>
      )}

      {node.status === 'complete' && node.completesAt !== null && (
        <p className="research-node__done">
          Researched on <span className="figure">{formatGameDate(node.completesAt)}</span> (game
          date)
        </p>
      )}

      {node.status === 'available' &&
        (node.startRefusal !== null ? (
          <div className="research-node__action">
            <Button size="sm" disabled aria-describedby={reasonId}>
              Start research
            </Button>
            <p className="research-node__reason" id={reasonId}>
              {refusalInWords(node.startRefusal, node, research)}
            </p>
          </div>
        ) : confirming ? (
          <div
            className="research-node__confirm"
            ref={confirmRef}
            role="group"
            aria-label={`Confirm starting ${node.name}`}
          >
            <p className="research-node__confirm-note">
              Spends <span className="figure">{formatPoints(node.cost.researchPoints)} RP</span> and{' '}
              <span className="figure">{formatCash(node.cost.cashMinor)}</span> now, and takes{' '}
              <span className="figure">{formatGameWeeks(node.cost.buildWeeks)}</span>. Nothing can
              rush it, and only one project runs at a time.
            </p>
            <div className="research-node__confirm-actions">
              <Button variant="primary" size="sm" disabled={busy} onClick={onConfirmStart}>
                {pending ? 'Starting…' : `Confirm — start ${node.name}`}
              </Button>
              <Button variant="tertiary" size="sm" disabled={busy} onClick={onCancelStart}>
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <div className="research-node__action" ref={startRef}>
            <Button size="sm" disabled={busy} onClick={onRequestStart}>
              Start research
            </Button>
          </div>
        ))}

      {/* The failure belongs where the action was taken, not on the page behind. */}
      {failure !== null && (
        <StateBlock kind={failure.kind} className="research-node__failure">
          {failure.message}
        </StateBlock>
      )}

      {footer !== undefined && <div className="research-node__footer">{footer}</div>}
    </article>
  );
}

function progressLine(gameNow: string, completesAt: string): string {
  const days = gameDaysRemaining(gameNow, completesAt);
  return days === null ? 'Researching' : remainingInWords(days);
}

/**
 * What the node makes better.
 *
 * The amounts are the world's balance and arrive only for released nodes. For a
 * tier 3 or 4 node the catalogue still says *which* quantity it aims at, and
 * says so without a number rather than inventing one; a node whose effect is a
 * capability nothing models yet says that instead of showing an empty list.
 */
function Effects({ node }: { node: ResearchNodeView }): ReactNode {
  if (node.effects.length > 0) {
    return (
      <ul className="research-node__effects" aria-label="Effect">
        {node.effects.map((effect) => (
          <li key={effect.target} className="research-node__effect figure">
            {effectInWords(effect)}
          </li>
        ))}
      </ul>
    );
  }
  const targets = catalogueTargets(node.id);
  return (
    <p className="research-node__effect-pending">
      {targets.length > 0
        ? `Improves ${targetsInWords(targets)} — the amount is set when it is released.`
        : 'A capability rather than an efficiency; nothing in this release models it yet.'}
    </p>
  );
}
