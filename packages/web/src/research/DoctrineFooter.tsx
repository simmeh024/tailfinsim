import { useEffect, useRef } from 'react';

import type { DoctrineView, ResearchNodeView } from '@tailfin/shared';

import { Button } from '../ui/Button';
import { StateBlock } from '../ui/StateBlock';

import {
  doctrineTrend,
  doctrineTrendInWords,
  effectAtStrength,
  formatCash,
  formatStrength,
  type DoctrineTrend,
} from './research-presentation';

import type { ReactNode } from 'react';

/**
 * A completed node's standing as doctrine (M9-06, §10.4's third rule).
 *
 * > *"**Upkeep.** Academies and research carry ongoing cost. Doctrine lapses if
 * > you stop funding it — advantages must be maintained, not just banked."*
 *
 * Rendered in the card's footer slot M9-05 left for it, so a researched node
 * reads top to bottom as *what it is, what it cost, and what it is worth now*.
 *
 * ## What the player has to be able to see
 *
 *   - whether it is funded and what that costs a game month;
 *   - how strong it is, as a bar **and** a percentage;
 *   - which way the strength is moving and when it stops, in game weeks;
 *   - each effect at the strength it is in force, beside the full figure.
 *
 * ## Stopping is two clicks, resuming is one
 *
 * Stopping is the decision with a delayed bill: the advantage decays over game
 * weeks and this month's upkeep is still owed, so the confirm says both before
 * anything is sent. Resuming only costs what the state line above already
 * states, and getting it wrong is undone by stopping again.
 */

const TREND_GLYPH: Record<DoctrineTrend, string> = {
  full: '✔',
  recovering: '↗',
  lapsing: '↘',
  lapsed: '⊘',
};

export interface DoctrineFooterProps {
  node: ResearchNodeView;
  doctrine: DoctrineView;
  /** The world's clock with this response, for the time left in game weeks. */
  gameNow: string;
  /** Any research write in flight. Funding waits for it, and it for funding. */
  busy: boolean;
  /** True while the stop is awaiting its second click. */
  confirming: boolean;
  /** This node's own funding request is the one in flight. */
  pending: boolean;
  onRequestStop: () => void;
  onCancelStop: () => void;
  onConfirmStop: () => void;
  onResume: () => void;
  /** What went wrong on the last funding change, already in words. */
  failure: { kind: 'refused' | 'broken'; message: string } | null;
}

export function DoctrineFooter({
  node,
  doctrine,
  gameNow,
  busy,
  confirming,
  pending,
  onRequestStop,
  onCancelStop,
  onConfirmStop,
  onResume,
  failure,
}: DoctrineFooterProps): ReactNode {
  const trend = doctrineTrend(doctrine);
  const percent = Math.round(doctrine.strength * 100);
  const upkeep = formatCash(doctrine.monthlyUpkeepMinor);

  // Focus follows the confirm, as it does on the start control above.
  const confirmRef = useRef<HTMLDivElement>(null);
  const stopRef = useRef<HTMLDivElement>(null);
  const wasConfirming = useRef(confirming);
  useEffect(() => {
    if (confirming) confirmRef.current?.querySelector('button')?.focus();
    else if (wasConfirming.current) stopRef.current?.querySelector('button')?.focus();
    wasConfirming.current = confirming;
  }, [confirming]);

  return (
    <div
      className="doctrine"
      role="group"
      aria-label={`${node.name} doctrine`}
      data-funded={doctrine.funded}
      data-trend={trend}
    >
      <p className="doctrine__funding">
        {doctrine.funded ? (
          <>
            <span className="doctrine__funded">Funded</span> ·{' '}
            <span className="figure">{upkeep}</span> a game month
          </>
        ) : (
          <>
            <span className="doctrine__funded">Not funded</span> · upkeep{' '}
            <span className="figure">{upkeep}</span> a game month when funded
          </>
        )}
      </p>

      <div className="doctrine__strength">
        <div
          className="doctrine__bar"
          role="meter"
          aria-label={`${node.name} doctrine strength`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
          aria-valuetext={`${formatStrength(doctrine.strength)} strength`}
        >
          <span className="doctrine__fill" style={{ inlineSize: `${String(percent)}%` }} />
        </div>
        <span className="doctrine__percent figure">
          Strength {formatStrength(doctrine.strength)}
        </span>
      </div>

      <p className="doctrine__trend" data-trend={trend}>
        <span aria-hidden="true">{TREND_GLYPH[trend]}</span>{' '}
        {doctrineTrendInWords(doctrine, gameNow)}
      </p>

      {node.effects.length > 0 && (
        <ul className="doctrine__effects" aria-label="In force now">
          {node.effects.map((effect) => (
            <li key={effect.target} className="figure">
              {effectAtStrength(effect, doctrine.strength)}
            </li>
          ))}
        </ul>
      )}

      {doctrine.funded ? (
        confirming ? (
          <div
            className="doctrine__confirm"
            ref={confirmRef}
            role="group"
            aria-label={`Confirm stopping ${node.name}`}
          >
            <p className="doctrine__confirm-note">
              This month’s <span className="figure">{upkeep}</span> upkeep is still owed. After that
              nothing is billed, and the advantage decays over game weeks until none of it is left.
              Funding it again rebuilds it, over game weeks too.
            </p>
            <div className="doctrine__confirm-actions">
              <Button variant="danger" size="sm" disabled={busy} onClick={onConfirmStop}>
                {pending ? 'Stopping…' : `Confirm — stop funding ${node.name}`}
              </Button>
              <Button variant="tertiary" size="sm" disabled={busy} onClick={onCancelStop}>
                Keep funding
              </Button>
            </div>
          </div>
        ) : (
          <div className="doctrine__action" ref={stopRef}>
            <Button size="sm" disabled={busy} onClick={onRequestStop}>
              Stop funding
            </Button>
          </div>
        )
      ) : (
        <div className="doctrine__action">
          <Button size="sm" disabled={busy} onClick={onResume}>
            {pending ? 'Resuming…' : 'Resume funding'}
          </Button>
        </div>
      )}

      {failure !== null && (
        <StateBlock kind={failure.kind} className="doctrine__failure">
          {failure.message}
        </StateBlock>
      )}
    </div>
  );
}
