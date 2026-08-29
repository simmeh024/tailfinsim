import { createContext, useContext } from 'react';

import type { Tone } from './ui';
import type { PointerEvent as ReactPointerEvent, ReactNode } from 'react';

/**
 * A horizontal 24-hour timeline: an hour axis, aircraft rows down the side, and
 * flight blocks placed along each row by local departure time. Shared by the
 * per-route Schedule tab and the whole-airline Fleet Schedule view, so both read
 * the same way. The scale (which hours are shown) is passed through context so a
 * block can position itself without every caller threading the bounds.
 */

interface Scale {
  hourStart: number;
  hourEnd: number;
}

const ScaleContext = createContext<Scale>({ hourStart: 0, hourEnd: 24 });

function pct(minute: number, scale: Scale): number {
  const span = (scale.hourEnd - scale.hourStart) * 60;
  return ((minute - scale.hourStart * 60) / span) * 100;
}

export function minuteLabel(minute: number): string {
  const wrapped = ((minute % 1440) + 1440) % 1440;
  const h = Math.floor(wrapped / 60);
  const m = Math.floor(wrapped % 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

export function Timeline({
  hourStart = 0,
  hourEnd = 24,
  children,
}: {
  hourStart?: number;
  hourEnd?: number;
  children: ReactNode;
}): ReactNode {
  const ticks: number[] = [];
  for (let h = hourStart; h <= hourEnd; h += 2) ticks.push(h);
  return (
    <ScaleContext.Provider value={{ hourStart, hourEnd }}>
      <div className="net-timeline">
        <div className="net-timeline__axis">
          <div className="net-timeline__axis-spacer" />
          <div className="net-timeline__axis-track">
            {ticks.map((h) => (
              <span
                key={h}
                className="net-timeline__tick"
                style={{ left: `${pct(h * 60, { hourStart, hourEnd })}%` }}
              >
                {String(h).padStart(2, '0')}
              </span>
            ))}
          </div>
        </div>
        <div className="net-timeline__rows">{children}</div>
      </div>
    </ScaleContext.Provider>
  );
}

export function TimelineRow({
  label,
  sub,
  meter,
  selected = false,
  onLabelClick,
  trackAttrs,
  children,
}: {
  label: ReactNode;
  sub?: ReactNode;
  meter?: ReactNode;
  selected?: boolean;
  onLabelClick?: () => void;
  /** Extra data-* attributes on the track, e.g. `data-aircraft-id` for drop hit-testing. */
  trackAttrs?: Record<string, string>;
  children: ReactNode;
}): ReactNode {
  return (
    <div className={selected ? 'net-row net-row--selected' : 'net-row'}>
      <button
        type="button"
        className="net-row__label"
        onClick={onLabelClick}
        disabled={onLabelClick === undefined}
      >
        <span className="net-row__label-main">{label}</span>
        {sub !== undefined && <span className="net-row__label-sub">{sub}</span>}
        {meter}
      </button>
      <div className="net-row__track" data-net-track="" {...trackAttrs}>
        {/* Faint hour gridlines behind the blocks. */}
        <RowGrid />
        {children}
      </div>
    </div>
  );
}

function RowGrid(): ReactNode {
  const scale = useContext(ScaleContext);
  const lines: number[] = [];
  for (let h = scale.hourStart; h <= scale.hourEnd; h += 2) lines.push(h);
  return (
    <>
      {lines.map((h) => (
        <span
          key={h}
          className="net-row__gridline"
          style={{ left: `${pct(h * 60, scale)}%` }}
          aria-hidden="true"
        />
      ))}
    </>
  );
}

/** A placed flight, with an optional turnaround tail drawn immediately after it. */
export function TimelineBlock({
  startMinute,
  durationMinutes,
  turnaroundMinutes = 0,
  tone = 'accent',
  selected = false,
  label,
  title,
  onClick,
  onPointerDown,
}: {
  startMinute: number;
  durationMinutes: number;
  turnaroundMinutes?: number;
  tone?: Tone;
  selected?: boolean;
  label: ReactNode;
  title?: string;
  onClick?: () => void;
  onPointerDown?: (event: ReactPointerEvent) => void;
}): ReactNode {
  const scale = useContext(ScaleContext);
  const left = pct(startMinute, scale);
  const width = pct(startMinute + durationMinutes, scale) - left;
  const turnWidth = pct(startMinute + durationMinutes + turnaroundMinutes, scale) - (left + width);
  return (
    <>
      <button
        type="button"
        title={title}
        className={`net-block net-block--${tone}${selected ? ' net-block--selected' : ''}${
          onPointerDown ? ' net-block--draggable' : ''
        }`}
        style={{ left: `${left}%`, width: `${Math.max(width, 1.2)}%` }}
        onClick={onClick}
        onPointerDown={onPointerDown}
      >
        <span className="net-block__label">{label}</span>
      </button>
      {turnaroundMinutes > 0 && (
        <span
          className="net-block__turn"
          style={{ left: `${left + width}%`, width: `${Math.max(turnWidth, 0.4)}%` }}
          aria-hidden="true"
        />
      )}
    </>
  );
}

/** A clickable empty slot band, for adding a departure at a given hour. */
export function TimelineSlot({
  hour,
  tone = 'neutral',
  selected = false,
  title,
  onClick,
}: {
  hour: number;
  tone?: Tone;
  selected?: boolean;
  title?: string;
  onClick?: () => void;
}): ReactNode {
  const scale = useContext(ScaleContext);
  const left = pct(hour * 60, scale);
  const width = pct((hour + 1) * 60, scale) - left;
  return (
    <button
      type="button"
      title={title}
      className={`net-slot net-slot--${tone}${selected ? ' net-slot--selected' : ''}`}
      style={{ left: `${left}%`, width: `${width}%` }}
      onClick={onClick}
      aria-label={title}
    />
  );
}
