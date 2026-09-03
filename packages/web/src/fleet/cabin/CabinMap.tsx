/**
 * The top-down cabin drawing (§6.1, M6-08).
 *
 * A pure SVG plan of the fuselage with the fitted cabin laid nose (left) to tail
 * (right), matching the mockup. Elements are placed by their real floor length —
 * a row's pitch, a monument's footprint — scaled from metres, so the drawing is
 * the geometry the analysis measures, not a separate picture that could drift
 * from it. Selecting a row is a click on its slot; the selected slot gets the
 * bracket and the numbered tab the mockup draws around row 12.
 *
 * The fidelity — a shaded fuselage over a lighter cabin floor, a cockpit at the
 * nose, seats drawn with a backrest and headrest, red door/EXIT markers on the
 * skin, and icon'd galley/lavatory monuments — is all vector, so it stays crisp,
 * themes, and works for every type. Colours are token references only.
 */

import { elementLengthM } from './analysis';
import { CABIN_CLASS_ACCENT, seatsInLayout } from './catalogue';
import { numberElements } from './layout';
import { resolvePlanform } from './planform';

import type { CabinConfig, CabinFrame, MonumentKind } from './types';
import type { CSSProperties, ReactNode } from 'react';

const SCALE = 10; // SVG user units per metre
const SEAT = 13; // seat cell height, units
const AISLE = 11; // aisle gap, units
const SEAT_DEPTH_M = 0.46; // along-fuselage seat depth
const NOSE_M = 5;
const TAIL_M = 6;

function aisleCount(maxAbreast: number): number {
  return maxAbreast >= 7 ? 2 : 1;
}

/** Vertical seat-centre offsets for one row's layout, centred in the body. */
function seatOffsets(layout: string, bodyHeight: number): number[] {
  const groups = layout
    .split('-')
    .map((value) => Number.parseInt(value, 10))
    .filter((value) => Number.isFinite(value) && value > 0);
  const seats = groups.reduce((sum, value) => sum + value, 0);
  const aisles = Math.max(groups.length - 1, 0);
  const usedHeight = seats * SEAT + aisles * AISLE;
  let cursor = (bodyHeight - usedHeight) / 2 + SEAT / 2;
  const offsets: number[] = [];
  for (const group of groups) {
    for (let i = 0; i < group; i += 1) {
      offsets.push(cursor);
      cursor += SEAT;
    }
    cursor += AISLE;
  }
  return offsets;
}

function tanDeg(deg: number): number {
  return Math.tan((deg * Math.PI) / 180);
}

/**
 * One seat, facing the nose (left): a shaded cushion, a taller backrest with a
 * lit headrest, armrests down each side, and a soft shadow beneath — so a row
 * reads as seats rather than blocks.
 */
function Seat({ x, cy, w }: { x: number; cy: number; w: number }): ReactNode {
  const h = SEAT * 0.92;
  const top = cy - h / 2;
  const cushionW = w * 0.58;
  const backW = w * 0.34;
  const armH = 1.5;
  return (
    <g className="cc-seat">
      {/* Soft shadow for depth. */}
      <rect className="cc-seat__shadow" x={x + 0.9} y={top + 1.4} width={w} height={h} rx={2.2} />
      {/* Armrests down each side. */}
      <rect className="cc-seat__arm" x={x} y={top} width={w * 0.9} height={armH} rx={0.7} />
      <rect
        className="cc-seat__arm"
        x={x}
        y={top + h - armH}
        width={w * 0.9}
        height={armH}
        rx={0.7}
      />
      {/* Seat pan. */}
      <rect
        className="cc-seat__cushion"
        x={x + 1}
        y={top + armH}
        width={cushionW}
        height={h - 2 * armH}
        rx={1.6}
      />
      {/* Backrest, with a lit headrest patch. */}
      <rect
        className="cc-seat__back"
        x={x + w - backW}
        y={top - 0.6}
        width={backW}
        height={h + 1.2}
        rx={2}
      />
      <rect
        className="cc-seat__headrest"
        x={x + w - backW + backW * 0.24}
        y={cy - h * 0.2}
        width={backW * 0.58}
        height={h * 0.4}
        rx={1.2}
      />
    </g>
  );
}

/** A little icon inside a monument box, so a galley reads as a galley. */
function MonumentIcon({
  kind,
  cx,
  cy,
  w,
  h,
}: {
  kind: MonumentKind;
  cx: number;
  cy: number;
  w: number;
  h: number;
}): ReactNode {
  const usable = Math.min(w - 3, 10);
  if (usable < 4) return null;
  if (kind === 'galley' || kind === 'lounge') {
    // Galley carts: a few horizontal slots.
    const rows = [-0.28, 0, 0.28];
    return (
      <g className="cc-mon__icon">
        {rows.map((f) => (
          <line
            key={f}
            x1={cx - usable / 2}
            x2={cx + usable / 2}
            y1={cy + f * h * 0.5}
            y2={cy + f * h * 0.5}
          />
        ))}
      </g>
    );
  }
  if (kind === 'lavatory') {
    return (
      <g className="cc-mon__icon">
        <circle cx={cx} cy={cy - h * 0.08} r={usable * 0.32} />
        <line x1={cx} x2={cx} y1={cy + h * 0.1} y2={cy + h * 0.32} />
      </g>
    );
  }
  if (kind === 'closet') {
    return (
      <g className="cc-mon__icon">
        <line x1={cx - usable / 2} x2={cx + usable / 2} y1={cy - h * 0.28} y2={cy - h * 0.28} />
        <line x1={cx} x2={cx} y1={cy - h * 0.28} y2={cy + h * 0.28} />
      </g>
    );
  }
  return null; // divider — the thin box is the icon
}

/**
 * The faded aeroplane behind the cabin (M6-08).
 *
 * Wings, engines, winglets and stabilisers are drawn to a span proportionate to
 * the cabin width and cropped at the tips, so a narrowbody's swept underwing
 * engines, a turboprop's straight high wing with props, and a widebody's big
 * sweep each read at a glance without any per-type artwork. Decorative, so hidden
 * from assistive tech.
 */
function PlaneBackdrop({
  frame,
  geom,
}: {
  frame: CabinFrame;
  geom: { cy: number; bodyHeight: number; bodyLeft: number; cabinM: number; scale: number };
}): ReactNode {
  const plan = resolvePlanform(frame);
  const { cy, bodyHeight, bodyLeft, cabinM, scale } = geom;
  const halfBody = bodyHeight / 2;

  const rootLEx = bodyLeft + plan.wingXFraction * cabinM * scale;
  const halfSpan = bodyHeight * plan.wingSpanFactor;
  const sweepShift = halfSpan * tanDeg(plan.wingSweepDeg);
  const rootChord = plan.wingRootChordM * scale;
  const tipChord = plan.wingTipChordM * scale;
  const tipLEx = rootLEx + sweepShift;

  const wing = (sign: 1 | -1): string => {
    const rootY = cy + sign * (halfBody - 3);
    const tipY = cy + sign * (halfBody + halfSpan);
    return `${String(rootLEx)},${String(rootY)} ${String(rootLEx + rootChord)},${String(rootY)} ${String(tipLEx + tipChord)},${String(tipY)} ${String(tipLEx)},${String(tipY)}`;
  };
  // A winglet: a short chord perpendicular-ish flick at the tip.
  const winglet = (sign: 1 | -1): string => {
    const tipY = cy + sign * (halfBody + halfSpan);
    return `${String(tipLEx)},${String(tipY)} ${String(tipLEx + tipChord)},${String(tipY)} ${String(tipLEx + tipChord + 6)},${String(tipY + sign * 7)} ${String(tipLEx + tipChord - 2)},${String(tipY + sign * 7)}`;
  };

  const stations = plan.engineCount >= 4 ? [0.3, 0.58] : [0.42];
  const engines: ReactNode[] = [];
  if (plan.engine !== 'none' && plan.engine !== 'rear') {
    for (const sign of [-1, 1] as const) {
      for (const [i, f] of stations.entries()) {
        const lex = rootLEx + sweepShift * f;
        const ey = cy + sign * (halfBody + halfSpan * f);
        const nacLen = (plan.engine === 'turboprop' ? 2 : 2.8) * scale;
        const nacW = (plan.engine === 'turboprop' ? 0.9 : 1.3) * scale;
        engines.push(
          <rect
            key={`e${String(sign)}-${String(i)}`}
            className="cc-plane__engine"
            x={lex - nacLen * 0.72}
            y={ey - nacW / 2}
            width={nacLen}
            height={nacW}
            rx={nacW / 2}
          />,
        );
        if (plan.engine === 'underwing') {
          // Dark intake at the front of the cowl, plus a cowl highlight.
          engines.push(
            <ellipse
              key={`i${String(sign)}-${String(i)}`}
              className="cc-plane__intake"
              cx={lex - nacLen * 0.72}
              cy={ey}
              rx={nacW * 0.28}
              ry={nacW * 0.42}
            />,
            <ellipse
              key={`h${String(sign)}-${String(i)}`}
              className="cc-plane__engine-hi"
              cx={lex - nacLen * 0.18}
              cy={ey - nacW * 0.22}
              rx={nacLen * 0.26}
              ry={nacW * 0.12}
            />,
          );
        }
        if (plan.engine === 'turboprop') {
          engines.push(
            <ellipse
              key={`p${String(sign)}-${String(i)}`}
              className="cc-plane__prop"
              cx={lex - nacLen * 0.72}
              cy={ey}
              rx={1.2}
              ry={1.9 * scale}
            />,
          );
        }
      }
    }
  }

  const hRootLEx = bodyLeft + plan.hStabXFraction * cabinM * scale;
  const hHalf = bodyHeight * plan.hStabSpanFactor;
  const hSweep = hHalf * tanDeg(28);
  const hChord = plan.hStabChordM * scale;
  const hStab = (sign: 1 | -1): string => {
    const rootY = cy + sign * (halfBody - 3);
    const tipY = cy + sign * (halfBody + hHalf);
    return `${String(hRootLEx)},${String(rootY)} ${String(hRootLEx + hChord)},${String(rootY)} ${String(hRootLEx + hSweep + hChord * 0.5)},${String(tipY)} ${String(hRootLEx + hSweep)},${String(tipY)}`;
  };

  // A control-surface line near each wing's trailing edge.
  const flap = (sign: 1 | -1): { x1: number; y1: number; x2: number; y2: number } => ({
    x1: rootLEx + rootChord * 0.72,
    y1: cy + sign * (halfBody - 3),
    x2: tipLEx + tipChord * 0.72,
    y2: cy + sign * (halfBody + halfSpan),
  });

  return (
    <g className="cc-plane" aria-hidden="true">
      <polygon className="cc-plane__wing" points={wing(-1)} />
      <polygon className="cc-plane__wing" points={wing(1)} />
      {([-1, 1] as const).map((sign) => {
        const f = flap(sign);
        return (
          <line key={sign} className="cc-plane__flap" x1={f.x1} y1={f.y1} x2={f.x2} y2={f.y2} />
        );
      })}
      {plan.engine === 'underwing' && (
        <>
          <polygon className="cc-plane__winglet" points={winglet(-1)} />
          <polygon className="cc-plane__winglet" points={winglet(1)} />
        </>
      )}
      <polygon className="cc-plane__stab" points={hStab(-1)} />
      <polygon className="cc-plane__stab" points={hStab(1)} />
      {engines}
    </g>
  );
}

export function CabinMap({
  config,
  frame,
  selectedId,
  onSelect,
}: {
  config: CabinConfig;
  frame: CabinFrame;
  selectedId: string | null;
  onSelect: (id: string) => void;
}): ReactNode {
  const bodyHeight = frame.maxAbreast * SEAT + aisleCount(frame.maxAbreast) * AISLE + 12;
  const numbered = numberElements(config);

  const contentM = config.elements.reduce((sum, element) => sum + elementLengthM(element), 0);
  const cabinM = Math.max(contentM, frame.cabinLengthM);
  const totalM = NOSE_M + cabinM + TAIL_M;

  const WING_ROOM = 74;
  const width = totalM * SCALE;
  const bodyTop = WING_ROOM;
  const bodyBottom = bodyTop + bodyHeight;
  const height = bodyBottom + WING_ROOM + 24;
  const bodyLeft = NOSE_M * SCALE;
  const bodyRight = bodyLeft + cabinM * SCALE;
  const midY = bodyTop + bodyHeight / 2;

  // Lay each element left-to-right by its own length.
  let cursorM = NOSE_M;
  const placed = numbered.map((entry) => {
    const element = entry.kind === 'seats' ? entry.row : entry.monument;
    const lengthM = elementLengthM(element);
    const x = cursorM * SCALE;
    const w = lengthM * SCALE;
    cursorM += lengthM;
    return { entry, x, w, element };
  });

  // Fuselage skin: tapered nose and tail around the straight cabin section.
  const noseTipX = 0;
  const tailTipX = width;
  const fuselage = [
    `M ${String(bodyLeft)} ${String(bodyTop)}`,
    `L ${String(bodyRight)} ${String(bodyTop)}`,
    `Q ${String(bodyRight + TAIL_M * SCALE * 0.6)} ${String(bodyTop)} ${String(tailTipX)} ${String(midY)}`,
    `Q ${String(bodyRight + TAIL_M * SCALE * 0.6)} ${String(bodyBottom)} ${String(bodyRight)} ${String(bodyBottom)}`,
    `L ${String(bodyLeft)} ${String(bodyBottom)}`,
    `Q ${String(bodyLeft - NOSE_M * SCALE * 0.7)} ${String(bodyBottom)} ${String(noseTipX)} ${String(midY)}`,
    `Q ${String(bodyLeft - NOSE_M * SCALE * 0.7)} ${String(bodyTop)} ${String(bodyLeft)} ${String(bodyTop)}`,
    'Z',
  ].join(' ');

  // Doors on the skin: forward and aft pairs, plus one at each exit row.
  const doors: { x: number }[] = [{ x: bodyLeft + 5 }, { x: bodyRight - 5 }];
  for (const p of placed) {
    if (p.entry.kind === 'seats' && p.entry.row.isExitRow) doors.push({ x: p.x + p.w / 2 });
  }

  const rulerStep = 10;
  const ticks: number[] = [];
  for (let m = 0; m <= cabinM; m += rulerStep) ticks.push(m);

  return (
    <svg
      className="cc-map"
      viewBox={`0 0 ${String(width)} ${String(height)}`}
      role="group"
      aria-label={`${frame.label} cabin plan`}
      preserveAspectRatio="xMidYMid meet"
    >
      <defs>
        {/* A cylinder highlight down the fuselage: shadowed skin, lit crown. */}
        <linearGradient id="cc-fuselage-grad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" className="cc-grad-lo" />
          <stop offset="0.4" className="cc-grad-hi" />
          <stop offset="0.62" className="cc-grad-mid" />
          <stop offset="1" className="cc-grad-lo" />
        </linearGradient>
        {/* Wings lit at the leading edge, shadowed at the trailing edge. */}
        <linearGradient id="cc-wing-grad" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" className="cc-grad-hi" />
          <stop offset="1" className="cc-grad-lo" />
        </linearGradient>
        <linearGradient id="cc-engine-grad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" className="cc-grad-lo" />
          <stop offset="0.45" className="cc-grad-hi" />
          <stop offset="1" className="cc-grad-lo" />
        </linearGradient>
      </defs>

      {/* The faded aeroplane behind the cabin. */}
      <PlaneBackdrop
        frame={frame}
        geom={{ cy: midY, bodyHeight, bodyLeft, cabinM, scale: SCALE }}
      />

      {/* Fuselage skin, then the lighter cabin floor the seats sit on. */}
      <path className="cc-map__fuselage" d={fuselage} />
      <rect
        className="cc-map__floor"
        x={bodyLeft}
        y={bodyTop + 3}
        width={bodyRight - bodyLeft}
        height={bodyHeight - 6}
        rx={4}
      />

      {/* Cockpit at the nose: a windscreen arc and a few dark panes. */}
      <g className="cc-cockpit" aria-hidden="true">
        <path
          className="cc-cockpit__arc"
          d={`M ${String(bodyLeft - 2)} ${String(midY - bodyHeight * 0.28)} Q ${String(noseTipX + 10)} ${String(midY)} ${String(bodyLeft - 2)} ${String(midY + bodyHeight * 0.28)}`}
        />
        {[-1, 0, 1].map((k) => (
          <rect
            key={k}
            className="cc-cockpit__win"
            x={bodyLeft - NOSE_M * SCALE * 0.42}
            y={midY + k * (bodyHeight * 0.12) - 1.6}
            width={5}
            height={3.2}
            rx={1}
          />
        ))}
      </g>

      {/* Doors on the skin. */}
      <g className="cc-doors" aria-hidden="true">
        {doors.map((d, i) => (
          <g key={i}>
            <rect className="cc-door" x={d.x - 3} y={bodyTop - 1.5} width={6} height={3} rx={1} />
            <rect
              className="cc-door"
              x={d.x - 3}
              y={bodyBottom - 1.5}
              width={6}
              height={3}
              rx={1}
            />
          </g>
        ))}
      </g>

      {placed.map(({ entry, x, w, element }) => {
        const selected = element.id === selectedId;
        if (entry.kind === 'monument') {
          return (
            <g
              key={element.id}
              className={`cc-el cc-mon cc-mon--${element.kind}${selected ? ' is-selected' : ''}`}
              role="button"
              tabIndex={0}
              aria-label={`${element.kind}, ${selected ? 'selected' : 'not selected'}`}
              onClick={() => {
                onSelect(element.id);
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  onSelect(element.id);
                }
              }}
            >
              <rect
                className="cc-mon__box"
                x={x + 1}
                y={bodyTop + 4}
                width={Math.max(w - 2, 3)}
                height={bodyHeight - 8}
                rx={2}
              />
              <MonumentIcon
                kind={entry.monument.kind}
                cx={x + w / 2}
                cy={midY}
                w={w}
                h={bodyHeight - 8}
              />
              {selected && (
                <rect
                  className="cc-el__bracket"
                  x={x - 1}
                  y={bodyTop - 5}
                  width={w + 2}
                  height={bodyHeight + 10}
                  rx={3}
                />
              )}
            </g>
          );
        }

        const row = entry.row;
        const offsets = seatOffsets(row.seatLayout, bodyHeight);
        const seatW = Math.min(w * 0.66, SEAT_DEPTH_M * SCALE * 1.7);
        const seatX = x + (w - seatW) / 2;
        const style = { '--sec': CABIN_CLASS_ACCENT[row.cabinClass] } as CSSProperties;
        return (
          <g
            key={element.id}
            className={`cc-el cc-row cc-row--${row.cabinClass}${selected ? ' is-selected' : ''}`}
            style={style}
            role="button"
            tabIndex={0}
            aria-label={`Row ${String(entry.rowNumber)}, ${row.cabinClass}, ${String(seatsInLayout(row.seatLayout))} seats${row.isExitRow ? ', exit row' : ''}${selected ? ', selected' : ''}`}
            onClick={() => {
              onSelect(element.id);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                onSelect(element.id);
              }
            }}
          >
            {offsets.map((oy, i) => (
              <Seat key={i} x={seatX} cy={bodyTop + oy} w={seatW} />
            ))}
            {row.isExitRow && (
              <>
                <path
                  className="cc-exit"
                  d={`M ${String(x + w / 2 - 4)} ${String(bodyTop - 4)} L ${String(x + w / 2 + 4)} ${String(bodyTop - 4)} L ${String(x + w / 2)} ${String(bodyTop + 2)} Z`}
                  aria-hidden="true"
                />
                <path
                  className="cc-exit"
                  d={`M ${String(x + w / 2 - 4)} ${String(bodyBottom + 4)} L ${String(x + w / 2 + 4)} ${String(bodyBottom + 4)} L ${String(x + w / 2)} ${String(bodyBottom - 2)} Z`}
                  aria-hidden="true"
                />
              </>
            )}
            {selected && (
              <>
                <rect
                  className="cc-el__bracket"
                  x={x - 1}
                  y={bodyTop - 5}
                  width={w + 2}
                  height={bodyHeight + 10}
                  rx={3}
                />
                <g className="cc-rowtab">
                  <rect x={x + w / 2 - 9} y={bodyBottom + 6} width={18} height={13} rx={3} />
                  <text x={x + w / 2} y={bodyBottom + 12.6} textAnchor="middle">
                    {entry.rowNumber}
                  </text>
                </g>
              </>
            )}
          </g>
        );
      })}

      {/* Ruler under the plan. */}
      <g className="cc-ruler" aria-hidden="true">
        <line x1={bodyLeft} y1={height - 10} x2={bodyRight} y2={height - 10} />
        {ticks.map((m) => (
          <g key={m}>
            <line
              x1={bodyLeft + m * SCALE}
              y1={height - 13}
              x2={bodyLeft + m * SCALE}
              y2={height - 7}
            />
            <text className="cc-ruler__label" x={bodyLeft + m * SCALE} y={height - 15}>
              {m}
            </text>
          </g>
        ))}
        <text className="cc-ruler__unit" x={bodyRight + 6} y={height - 10}>
          {frame.lengthUnit}
        </text>
      </g>
    </svg>
  );
}
