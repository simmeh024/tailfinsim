/**
 * The live configuration summary and CG bar (§6.1, M6-08).
 *
 * The mockup's bottom band: seats and their headroom, the class split, and the
 * four trades §6.4 names — range, turnaround, crew, weight — plus the one-time
 * config cost. Every figure is read from {@link summarise}/{@link estimateCg}, so
 * the bar is a view of the analysis, never its own arithmetic. The CG bar draws
 * the envelope and the estimate against it, green inside the limits and the
 * status red outside.
 */

import { estimateCg, summarise } from './analysis';
import { CABIN_CLASS_ACCENT } from './catalogue';
import { formatDelta, formatNm, formatTonnes, formatUsdCompact } from './format';
import { CABIN_CLASS_META } from './types';

import type { CabinConfig, CabinFrame } from './types';
import type { CSSProperties, ReactNode } from 'react';

function Metric({
  label,
  value,
  delta,
  sub,
}: {
  label: string;
  value: string;
  delta?: { text: string; good: boolean } | null;
  sub?: string;
}): ReactNode {
  return (
    <div className="cc-metric">
      <span className="cc-metric__label">{label}</span>
      <span className="cc-metric__value figure">
        {value}
        {delta != null && (
          <span className={`cc-metric__delta cc-metric__delta--${delta.good ? 'good' : 'bad'}`}>
            {delta.text}
          </span>
        )}
      </span>
      {sub !== undefined && <span className="cc-metric__sub">{sub}</span>}
    </div>
  );
}

export function SummaryBar({
  config,
  frame,
}: {
  config: CabinConfig;
  frame: CabinFrame;
}): ReactNode {
  const summary = summarise(config, frame);
  const cg = estimateCg(config, frame);

  const available = frame.certifiedMaxSeats - summary.totalSeats;
  const seatFill = frame.certifiedMaxSeats === 0 ? 0 : summary.totalSeats / frame.certifiedMaxSeats;

  // CG bar spans a fixed 10–40% MAC window so the envelope has margin either side.
  const AXIS_MIN = 10;
  const AXIS_MAX = 40;
  const pct = (mac: number): number => ((mac - AXIS_MIN) / (AXIS_MAX - AXIS_MIN)) * 100;
  const bandLeft = pct(cg.minMac);
  const bandWidth = pct(cg.maxMac) - pct(cg.minMac);
  const markerLeft = Math.max(0, Math.min(100, pct(cg.mac)));

  return (
    <section className="cc-summary" aria-label="Live configuration summary">
      <div className="cc-summary__row">
        <div className="cc-metric cc-metric--seats">
          <span className="cc-metric__label">Total seats</span>
          <span className="cc-metric__value figure">
            {summary.totalSeats}
            <span className="cc-metric__of"> / {frame.certifiedMaxSeats}</span>
          </span>
          <div
            className="cc-seatbar"
            role="img"
            aria-label={`${String(summary.totalSeats)} of ${String(frame.certifiedMaxSeats)} certified seats`}
          >
            <span className="cc-seatbar__fill" style={{ width: `${String(seatFill * 100)}%` }} />
          </div>
          <span className="cc-metric__sub">
            {available >= 0
              ? `${String(available)} seats available`
              : `${String(-available)} over certified`}
          </span>
        </div>

        <div className="cc-metric cc-metric--classes">
          <span className="cc-metric__label">By class</span>
          <div className="cc-classchips">
            {summary.byClass.length === 0 ? (
              <span className="cc-metric__sub">No seats fitted</span>
            ) : (
              summary.byClass.map((row) => (
                <span
                  key={row.cabinClass}
                  className="cc-classchip"
                  style={{ '--sec': CABIN_CLASS_ACCENT[row.cabinClass] } as CSSProperties}
                >
                  <span className="cc-classchip__code">
                    {CABIN_CLASS_META[row.cabinClass].code}
                  </span>
                  <span className="cc-classchip__count figure">{row.seats}</span>
                  <span className="cc-classchip__share">{Math.round(row.share * 100)}%</span>
                </span>
              ))
            )}
          </div>
        </div>

        <Metric
          label="Range impact"
          value={formatNm(summary.rangeNm)}
          delta={{
            text: formatDelta(summary.rangeVsStandardNm, 'nm'),
            good: summary.rangeVsStandardNm >= 0,
          }}
          sub="vs standard layout"
        />
        <Metric
          label="Turnaround est."
          value={`${String(summary.turnaroundMin)} min`}
          delta={{
            text: formatDelta(summary.turnaroundVsStandardMin, 'min'),
            good: summary.turnaroundVsStandardMin <= 0,
          }}
          sub="vs standard layout"
        />
        <Metric label="Cabin crew" value={String(summary.crewRecommended)} sub="Recommended" />
        <Metric
          label="Cabin weight"
          value={formatTonnes(summary.cabinWeightKg)}
          delta={{
            text: formatDelta(summary.weightVsStandardKg / 1000, 't'),
            good: summary.weightVsStandardKg <= 0,
          }}
          sub="vs standard layout"
        />
        <Metric
          label="Config cost"
          value={formatUsdCompact(summary.configCostUsd)}
          sub="One-time cost"
        />
      </div>

      <div className="cc-cg">
        <span className="cc-cg__label">CG (centre of gravity) estimate</span>
        <div className="cc-cg__track">
          <span
            className="cc-cg__band"
            style={{ left: `${String(bandLeft)}%`, width: `${String(bandWidth)}%` }}
          />
          <span
            className={`cc-cg__marker${cg.withinLimits ? '' : ' is-out'}`}
            style={{ left: `${String(markerLeft)}%` }}
          >
            <span className="cc-cg__value figure">{cg.mac.toFixed(1)}% MAC</span>
          </span>
        </div>
        <span className={`cc-cg__verdict cc-cg__verdict--${cg.withinLimits ? 'ok' : 'out'}`}>
          {cg.withinLimits
            ? `Within limits (${String(cg.minMac)}–${String(cg.maxMac)}% MAC)`
            : `Outside limits (${String(cg.minMac)}–${String(cg.maxMac)}% MAC)`}
        </span>
      </div>
    </section>
  );
}
