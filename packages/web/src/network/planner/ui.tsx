import { WEEKDAYS, WEEKDAY_LABEL, type Weekday } from './types';

import type { ReactNode } from 'react';

/**
 * Small reusable presentation pieces for the Network workspace.
 *
 * Colour comes only from tokens via the `tone` prop → CSS class, never a literal,
 * so the colour-literal guard stays green and both themes work.
 */

export type Tone = 'neutral' | 'positive' | 'negative' | 'warn' | 'accent';

/** `12345` minor → `123.45`. Display only; the wire stays integer. */
export function major(minor: number): string {
  return (minor / 100).toFixed(2);
}

/** A compact money figure: `1.2k`, `3.4M`, in major units. */
export function compactMoney(minor: number): string {
  const value = minor / 100;
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return value.toFixed(0);
}

export function StatTile({
  label,
  value,
  sub,
  tone = 'neutral',
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  tone?: Tone;
}): ReactNode {
  return (
    <div className={`net-tile net-tile--${tone}`}>
      <span className="net-tile__label">{label}</span>
      <span className="net-tile__value figure">{value}</span>
      {sub !== undefined && <span className="net-tile__sub">{sub}</span>}
    </div>
  );
}

export function Chip({
  children,
  tone = 'neutral',
}: {
  children: ReactNode;
  tone?: Tone;
}): ReactNode {
  return <span className={`net-chip net-chip--${tone}`}>{children}</span>;
}

/** A horizontal proportion bar, 0–1. */
export function Meter({
  value,
  tone = 'accent',
  label,
}: {
  value: number;
  tone?: Tone;
  label?: string;
}): ReactNode {
  const pct = Math.max(0, Math.min(1, value)) * 100;
  return (
    <div className="net-meter" role="img" aria-label={label ?? `${pct.toFixed(0)}%`}>
      <div className={`net-meter__fill net-meter__fill--${tone}`} style={{ width: `${pct}%` }} />
    </div>
  );
}

/** A segmented control — also the tab strip and the view switch. */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
}: {
  options: readonly { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
  label: string;
}): ReactNode {
  return (
    <div className="net-segmented" role="tablist" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="tab"
          aria-selected={option.value === value}
          className="net-segmented__option"
          onClick={() => {
            onChange(option.value);
          }}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/** Weekday toggles for a frequency template. */
export function DayPicker({
  days,
  onToggle,
}: {
  days: readonly Weekday[];
  onToggle: (day: Weekday) => void;
}): ReactNode {
  const active = new Set(days);
  return (
    <div className="net-days" role="group" aria-label="Days of week">
      {WEEKDAYS.map((day) => (
        <button
          key={day}
          type="button"
          aria-pressed={active.has(day)}
          className="net-days__day"
          onClick={() => {
            onToggle(day);
          }}
        >
          {WEEKDAY_LABEL[day]}
        </button>
      ))}
    </div>
  );
}

/** An inline SVG sparkline of 0–1 values; colour is `currentColor` from the parent. */
export function Sparkline({ points }: { points: readonly number[] }): ReactNode {
  if (points.length < 2) return null;
  const width = 120;
  const height = 32;
  const step = width / (points.length - 1);
  const path = points
    .map((value, index) => {
      const x = index * step;
      const y = height - Math.max(0, Math.min(1, value)) * height;
      return `${index === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
  return (
    <svg
      className="net-spark"
      viewBox={`0 0 ${String(width)} ${String(height)}`}
      aria-hidden="true"
    >
      <path d={path} fill="none" stroke="currentColor" strokeWidth={1.5} />
    </svg>
  );
}
