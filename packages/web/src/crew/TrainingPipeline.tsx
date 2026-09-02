import type { CrewResponse } from '@tailfin/shared';

import { formatUsdMinor } from '../currency/display';

import { CREW_RANK_LABEL } from './CrewRoleBanner';

import type { ReactNode } from 'react';

/**
 * Conversions in progress (M5-01, §9.2).
 *
 * ## The clock here is the world's, not the browser's
 *
 * `crew_conversion.completes_at` is **game time** — a fortnight of training is a
 * span in the world's calendar, so a world at 4× returns its crew twice as fast
 * in real time as one at 2×. Measuring "days remaining" against `Date.now()`
 * would be wrong by the speed multiplier, and wrong in the direction that makes
 * a fast world look stuck.
 *
 * So progress needs the world clock, and the world clock is `null` until its
 * first sync. **When it is null this shows the dates and no progress at all**,
 * rather than a bar computed against the wrong clock. A dash is a smaller lie
 * than a number.
 *
 * ## What it costs is arithmetic on authoritative figures
 *
 * `conversionPerHeadMinor × heads`. Multiplying two numbers the server sent is
 * presentation; deciding what a conversion costs is not, and is not done here.
 */

export interface TrainingPipelineProps {
  crew: CrewResponse;
  /** The world's game time, or `null` before the first sync. */
  inGameTime: Date | null;
}

export function TrainingPipeline({ crew, inGameTime }: TrainingPipelineProps): ReactNode {
  const conversions = crew.bases.flatMap((base) =>
    base.conversions.map((conversion) => ({ ...conversion, airportIcao: base.airportIcao })),
  );

  return (
    <section className="crew-panel" aria-labelledby="crew-training-heading">
      <div className="crew-panel__head">
        <h2 className="crew-panel__title" id="crew-training-heading">
          Training pipeline
        </h2>
        <p className="crew-panel__sub">Type conversions in progress</p>
      </div>

      {conversions.length === 0 ? (
        <p className="crew__note">
          No training in progress. Convert a type rating and the crew appear here until they qualify
          — off the roster for the whole course, which is the part that costs you.
        </p>
      ) : (
        <ul className="crew-training">
          {conversions.map((conversion) => {
            const progress = progressOf(conversion.startedAt, conversion.completesAt, inGameTime);
            return (
              <li className="crew-training__item" key={conversion.id}>
                <div className="crew-training__head">
                  <span className="crew-training__route figure">
                    {conversion.fromFamily} → {conversion.toFamily}
                  </span>
                  <span className="crew-training__base figure">{conversion.airportIcao}</span>
                </div>

                <p className="crew-training__who">
                  <span className="figure">{conversion.heads}</span>{' '}
                  {CREW_RANK_LABEL[conversion.rank]}
                  {conversion.heads === 1 ? '' : 's'}
                </p>

                {progress === null ? (
                  <p className="crew__hint">
                    Completes {formatDate(conversion.completesAt)} in world time.
                  </p>
                ) : (
                  <>
                    <div
                      className="crew-training__bar"
                      role="progressbar"
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={Math.round(progress.fraction * 100)}
                      aria-label={`${conversion.fromFamily} to ${conversion.toFamily} conversion`}
                    >
                      <span
                        className="crew-training__fill"
                        style={{ width: `${String(Math.round(progress.fraction * 100))}%` }}
                      />
                    </div>
                    <p className="crew-training__remaining">
                      {progress.daysRemaining <= 0
                        ? 'Due to complete'
                        : `${String(progress.daysRemaining)} world day${progress.daysRemaining === 1 ? '' : 's'} remaining`}
                    </p>
                  </>
                )}

                <dl className="crew-training__facts">
                  <div>
                    <dt>Started</dt>
                    <dd className="figure">{formatDate(conversion.startedAt)}</dd>
                  </div>
                  <div>
                    <dt>Completes</dt>
                    <dd className="figure">{formatDate(conversion.completesAt)}</dd>
                  </div>
                  <div>
                    <dt>Cost</dt>
                    <dd className="figure">
                      {formatCash(crew.costs.conversionPerHeadMinor * conversion.heads)}
                    </dd>
                  </div>
                </dl>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/** `null` when the world clock has not arrived — see the note at the top. */
function progressOf(
  startedAt: string,
  completesAt: string,
  inGameTime: Date | null,
): { fraction: number; daysRemaining: number } | null {
  if (inGameTime === null) return null;

  const start = Date.parse(startedAt);
  const end = Date.parse(completesAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;

  const now = inGameTime.getTime();
  const fraction = Math.min(1, Math.max(0, (now - start) / (end - start)));
  return { fraction, daysRemaining: Math.max(0, Math.ceil((end - now) / 86_400_000)) };
}

/** `2024-10-28` — UTC, as everywhere else that shows a world date. */
function formatDate(iso: string): string {
  return iso.slice(0, 10);
}

function formatCash(minor: number): string {
  return formatUsdMinor(minor, { fractionDigits: 0 });
}
