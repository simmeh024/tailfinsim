/**
 * The right-hand inspector (M6-08).
 *
 * Everything about the selected element, in the mockup's three tabs: Overview
 * (the numbers), Product (what is fitted, and the controls to change it), and
 * Constraints (why the row is or is not legal). With nothing selected it invites
 * a selection rather than showing an empty frame. Every edit is a `dispatch`, so
 * the panel never holds its own copy of the config — it reads the one truth and
 * asks the reducer to change it.
 */

import { useState } from 'react';

import { EXIT_ROW_MIN_PITCH_IN } from './analysis';
import {
  CABIN_CLASS_ACCENT,
  MONUMENT_SPECS,
  productsForClass,
  seatProduct,
  seatsInLayout,
} from './catalogue';
import { MAX_PITCH_IN, MIN_PITCH_IN } from './editor';
import { comfortStars, formatKg, formatUsd, inchesWithCm } from './format';
import { numberElements } from './layout';
import { CABIN_CLASS_META, CABIN_CLASSES, isSeatRow } from './types';

import type { ConstraintStatus } from './analysis';
import type { CabinAction } from './editor';
import type { CabinConfig, CabinElement, CabinFrame, SeatRow } from './types';
import type { CSSProperties, ReactNode } from 'react';

type Tab = 'overview' | 'product' | 'constraints';

function comfortLabel(comfort: number): string {
  if (comfort >= 4.8) return 'Exceptional';
  if (comfort >= 4.3) return 'Excellent';
  if (comfort >= 3.8) return 'Very good';
  if (comfort >= 3) return 'Good';
  return 'Basic';
}

function StatusDot({ status }: { status: ConstraintStatus }): ReactNode {
  const glyph = status === 'ok' ? '✓' : status === 'warn' ? '●' : '✕';
  return (
    <span className={`cc-check__status cc-check__status--${status}`} aria-hidden="true">
      {glyph}
    </span>
  );
}

/** Per-row legality checks, the mockup's right-panel CONSTRAINTS & STATUS. */
function rowChecks(
  config: CabinConfig,
  row: SeatRow,
): { label: string; status: ConstraintStatus; note: string }[] {
  const checks: { label: string; status: ConstraintStatus; note: string }[] = [];

  // Distance in elements to the nearest galley, for the galley-proximity check.
  const index = config.elements.findIndex((element) => element.id === row.id);
  let nearest = Number.POSITIVE_INFINITY;
  config.elements.forEach((element, i) => {
    if (!isSeatRow(element) && (element.kind === 'galley' || element.kind === 'lounge')) {
      nearest = Math.min(nearest, Math.abs(i - index));
    }
  });

  if (row.isExitRow) {
    checks.push({
      label: 'Exit clearance',
      status: row.pitchIn >= EXIT_ROW_MIN_PITCH_IN ? 'ok' : 'error',
      note: row.pitchIn >= EXIT_ROW_MIN_PITCH_IN ? 'OK' : 'Too tight',
    });
    checks.push({ label: 'Exit access', status: 'ok', note: 'OK' });
    checks.push({
      label: 'Pitch requirement',
      status: row.pitchIn >= EXIT_ROW_MIN_PITCH_IN ? 'ok' : 'error',
      note: `≥ ${String(EXIT_ROW_MIN_PITCH_IN)} in`,
    });
  } else {
    checks.push({
      label: 'Pitch requirement',
      status: row.pitchIn >= 28 ? 'ok' : 'warn',
      note: '≥ 28 in',
    });
    checks.push({ label: 'Aisle access', status: 'ok', note: 'OK' });
  }

  checks.push({
    label: 'Galley proximity',
    status: nearest <= 6 ? 'ok' : 'warn',
    note: nearest <= 6 ? 'OK' : 'Check min.',
  });

  return checks;
}

function OverviewTab({ element }: { element: CabinElement }): ReactNode {
  if (!isSeatRow(element)) {
    const spec = MONUMENT_SPECS[element.kind];
    return (
      <dl className="cc-spec">
        <div className="cc-spec__row">
          <dt>Module</dt>
          <dd>{spec.label}</dd>
        </div>
        <div className="cc-spec__row">
          <dt>Footprint</dt>
          <dd>{spec.lengthM.toFixed(2)} m</dd>
        </div>
        <div className="cc-spec__row">
          <dt>Weight</dt>
          <dd>{formatKg(spec.weightKg)}</dd>
        </div>
        <div className="cc-spec__row">
          <dt>Turnaround effect</dt>
          <dd>{spec.turnaroundDeltaMin > 0 ? `+${String(spec.turnaroundDeltaMin)} min` : '—'}</dd>
        </div>
        <div className="cc-spec__row">
          <dt>Config cost</dt>
          <dd>{formatUsd(spec.costUsd)}</dd>
        </div>
      </dl>
    );
  }

  const product = seatProduct(element.productId);
  const seats = seatsInLayout(element.seatLayout);
  const rowWeight = seats * (product?.weightKgPerSeat ?? 12);
  const rowCost = seats * (product?.unitCostUsd ?? 3000);
  const comfort = product?.comfort ?? 3;

  return (
    <dl className="cc-spec">
      <div className="cc-spec__row">
        <dt>Row type</dt>
        <dd>{element.isExitRow ? 'Exit row' : 'Standard'}</dd>
      </div>
      <div className="cc-spec__row">
        <dt>Seat layout</dt>
        <dd>{element.seatLayout.split('-').join(' – ')}</dd>
      </div>
      <div className="cc-spec__row">
        <dt>Seats in row</dt>
        <dd>{seats}</dd>
      </div>
      <div className="cc-spec__row">
        <dt>Seat pitch</dt>
        <dd>{inchesWithCm(element.pitchIn)}</dd>
      </div>
      <div className="cc-spec__row">
        <dt>Seat width</dt>
        <dd>{inchesWithCm(product?.widthIn ?? 17)}</dd>
      </div>
      <div className="cc-spec__row">
        <dt>Recline</dt>
        <dd>{product ? inchesWithCm(product.reclineIn) : '—'}</dd>
      </div>
      <div className="cc-spec__row">
        <dt>Comfort</dt>
        <dd>
          <span className="cc-stars" aria-hidden="true">
            {comfortStars(comfort)}
          </span>{' '}
          {comfortLabel(comfort)}
        </dd>
      </div>
      <div className="cc-spec__divider" role="presentation" />
      <div className="cc-spec__row">
        <dt>Weight (row)</dt>
        <dd>{formatKg(rowWeight)}</dd>
      </div>
      <div className="cc-spec__row">
        <dt>Config cost (row)</dt>
        <dd>{formatUsd(rowCost)}</dd>
      </div>
    </dl>
  );
}

function ProductTab({
  element,
  dispatch,
}: {
  element: CabinElement;
  dispatch: (action: CabinAction) => void;
}): ReactNode {
  if (!isSeatRow(element)) {
    return <p className="cc-inspector__hint">This module has no seat product.</p>;
  }
  const products = productsForClass(element.cabinClass);
  const product = seatProduct(element.productId);
  const layouts = product?.layouts ?? [element.seatLayout];

  return (
    <div className="cc-form">
      <label className="cc-field">
        <span className="cc-field__label">Cabin class</span>
        <select
          className="cc-select"
          value={element.cabinClass}
          onChange={(event) => {
            const value = event.target.value as SeatRow['cabinClass'];
            dispatch({ type: 'setClass', id: element.id, cabinClass: value });
          }}
        >
          {CABIN_CLASSES.map((cabinClass) => (
            <option key={cabinClass} value={cabinClass}>
              {CABIN_CLASS_META[cabinClass].label}
            </option>
          ))}
        </select>
      </label>

      <label className="cc-field">
        <span className="cc-field__label">Seat product</span>
        <select
          className="cc-select"
          value={element.productId}
          onChange={(event) => {
            dispatch({ type: 'setProduct', id: element.id, productId: event.target.value });
          }}
        >
          {products.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </select>
      </label>

      <label className="cc-field">
        <span className="cc-field__label">Aisle layout</span>
        <select
          className="cc-select"
          value={element.seatLayout}
          onChange={(event) => {
            dispatch({ type: 'setLayout', id: element.id, layout: event.target.value });
          }}
        >
          {layouts.map((layout) => (
            <option key={layout} value={layout}>
              {layout.split('-').join(' – ')}
            </option>
          ))}
        </select>
      </label>

      <label className="cc-field">
        <span className="cc-field__label">Seat pitch — {String(element.pitchIn)} in</span>
        <input
          className="cc-range"
          type="range"
          min={MIN_PITCH_IN}
          max={MAX_PITCH_IN}
          value={element.pitchIn}
          onChange={(event) => {
            dispatch({ type: 'setPitch', id: element.id, pitchIn: Number(event.target.value) });
          }}
        />
      </label>

      <label className="cc-check-toggle">
        <input
          type="checkbox"
          checked={element.isExitRow}
          onChange={() => {
            dispatch({ type: 'toggleExit', id: element.id });
          }}
        />
        <span>Exit row</span>
      </label>
    </div>
  );
}

function ConstraintsTab({
  element,
  config,
}: {
  element: CabinElement;
  config: CabinConfig;
}): ReactNode {
  if (!isSeatRow(element)) {
    return <p className="cc-inspector__hint">Modules carry no seat constraints.</p>;
  }
  const checks = rowChecks(config, element);
  return (
    <ul className="cc-checks">
      {checks.map((check) => (
        <li key={check.label} className="cc-check">
          <StatusDot status={check.status} />
          <span className="cc-check__label">{check.label}</span>
          <span className="cc-check__note">{check.note}</span>
        </li>
      ))}
    </ul>
  );
}

export function Inspector({
  config,
  frame,
  selectedId,
  dispatch,
}: {
  config: CabinConfig;
  frame: CabinFrame;
  selectedId: string | null;
  dispatch: (action: CabinAction) => void;
}): ReactNode {
  const [tab, setTab] = useState<Tab>('overview');

  const numbered = numberElements(config);
  const found = numbered.find((entry) =>
    entry.kind === 'seats' ? entry.row.id === selectedId : entry.monument.id === selectedId,
  );

  if (found === undefined) {
    return (
      <aside className="cc-inspector" aria-label="Inspector">
        <p className="cc-inspector__empty">
          Select a row or a module in the cabin to see and change its detail.
        </p>
      </aside>
    );
  }

  const element = found.kind === 'seats' ? found.row : found.monument;
  const isRow = found.kind === 'seats';
  const title = isRow
    ? found.row.isExitRow
      ? `Row ${String(found.rowNumber)} · Exit row`
      : `Row ${String(found.rowNumber)}`
    : MONUMENT_SPECS[found.monument.kind].label;
  const subtitle = isRow
    ? `${CABIN_CLASS_META[found.row.cabinClass].label} · ${frame.label}`
    : `Cabin module · ${frame.label}`;
  const style = isRow
    ? ({ '--sec': CABIN_CLASS_ACCENT[found.row.cabinClass] } as CSSProperties)
    : undefined;

  return (
    <aside className="cc-inspector" aria-label="Inspector" style={style}>
      <header className="cc-inspector__head">
        <div>
          <h2 className="cc-inspector__title">{title}</h2>
          <p className="cc-inspector__sub">{subtitle}</p>
        </div>
      </header>

      <div className="cc-tabs" role="tablist" aria-label="Inspector sections">
        {(['overview', 'product', 'constraints'] as const).map((key) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={tab === key}
            className={`cc-tab${tab === key ? ' is-active' : ''}`}
            onClick={() => {
              setTab(key);
            }}
          >
            {key === 'overview' ? 'Overview' : key === 'product' ? 'Product' : 'Constraints'}
          </button>
        ))}
      </div>

      <div className="cc-inspector__body">
        {tab === 'overview' && <OverviewTab element={element} />}
        {tab === 'product' && <ProductTab element={element} dispatch={dispatch} />}
        {tab === 'constraints' && <ConstraintsTab element={element} config={config} />}
      </div>

      <footer className="cc-inspector__actions">
        <button
          type="button"
          className="cc-btn cc-btn--ghost"
          onClick={() => {
            dispatch({ type: 'duplicate', id: element.id });
          }}
        >
          Duplicate
        </button>
        <button
          type="button"
          className="cc-btn cc-btn--danger"
          onClick={() => {
            dispatch({ type: 'delete', id: element.id });
          }}
        >
          Delete
        </button>
      </footer>
    </aside>
  );
}
