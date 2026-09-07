import { Link } from 'react-router';

import type { MetricDrillDown, MetricPolarity, MetricTrend } from '@tailfin/shared';

import { drillHref, formatMetric, formatTrend, trendTone, type DisplayUnit } from './format';

import type { ReactNode } from 'react';

/**
 * One headline figure: level, movement, and where it came from (§14.6, M8-10).
 *
 * The three parts are not decoration and none of them is optional.
 *
 * **The level and the movement together**, because §14.6 says so: *"absolute
 * value **and** rate of change on every headline metric — a falling profit
 * that's falling more slowly is a different story from one that isn't."* A tile
 * that showed only the number would hide the second story entirely.
 *
 * **The drill-down**, because §14.1's rule is that no figure is a dead end. The
 * link is rendered from the server's own `drillDown`, so a page cannot invent a
 * destination — and when this build has no page for that endpoint the tile shows
 * its figure with **no link** rather than sending a player somewhere that cannot
 * answer. A missing link is honest; a broken one is not.
 *
 * **Tone is never colour alone** (H.4, H.7). Each direction pairs its hue with
 * an arrow glyph, and the accessible name spells the movement out — so the tile
 * survives greyscale, colour blindness and a screen reader.
 */

export interface MetricTileProps {
  label: string;
  /** One sentence for the tooltip. RASK and yield are not obviously different. */
  description?: string;
  value: number | null;
  /** For a figure whose value is a word — a credit rating is `B`, not a number. */
  text?: string | null;
  unit: DisplayUnit;
  polarity: MetricPolarity;
  trend: MetricTrend;
  drillDown: MetricDrillDown;
  /** Emphasised tiles lead the grid — cash, runway, net worth. */
  featured?: boolean;
}

export function MetricTile({
  label,
  description,
  value,
  text,
  unit,
  polarity,
  trend,
  drillDown,
  featured = false,
}: MetricTileProps): ReactNode {
  const tone = trendTone(trend, polarity);
  const href = drillHref(drillDown.endpoint);
  const shown = text ?? formatMetric(value, unit);
  const movement = formatTrend(trend, unit);

  const classes = ['tile'];
  if (featured) classes.push('tile--featured');

  return (
    <article className={classes.join(' ')} aria-label={label}>
      <h3 className="tile__label" title={description}>
        {label}
      </h3>
      <p className="tile__value figure">{shown}</p>
      <p className={`tile__trend tile__trend--${tone}`}>
        <span aria-hidden="true">{movement.slice(0, 1)}</span>
        <span className="tile__trend-text">{movement.slice(1).trim()}</span>
      </p>
      {href === null ? (
        // §14.1 asks every figure to explain itself. Until a page consumes this
        // endpoint, saying where the answer lives is more honest than a link
        // that goes somewhere unable to give it.
        <p className="tile__drill tile__drill--absent">{drillDown.label}</p>
      ) : (
        <Link className="tile__drill" to={href}>
          {drillDown.label} →
        </Link>
      )}
    </article>
  );
}
