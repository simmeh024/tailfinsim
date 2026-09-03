/**
 * The top-down cabin drawing (§6.1, M6-08).
 *
 * A pure SVG plan of the fuselage with the fitted cabin laid nose (left) to tail
 * (right), matching the mockup. Elements are placed by their real floor length —
 * a row's pitch, a monument's footprint — scaled from metres, so the drawing is
 * the geometry the analysis measures, not a separate picture that could drift
 * from it. Selecting a row is a click on its slot; the selected slot gets the
 * bracket the mockup draws around row 12.
 *
 * Colours are all token references (`theme/tokens.css`); the per-class accent
 * arrives as a CSS variable on the group, never as a literal.
 */

import { elementLengthM } from './analysis';
import { CABIN_CLASS_ACCENT, seatsInLayout } from './catalogue';
import { numberElements } from './layout';
import { resolvePlanform } from './planform';

import type { CabinConfig, CabinFrame } from './types';
import type { CSSProperties, ReactNode } from 'react';

const SCALE = 10; // SVG user units per metre
const SEAT = 13; // seat cell height, units
const AISLE = 11; // aisle gap, units
const SEAT_DEPTH_M = 0.46; // along-fuselage seat depth
const NOSE_M = 4;
const TAIL_M = 5;

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

const MONUMENT_GLYPH: Record<string, string> = {
  galley: 'G',
  lavatory: 'WC',
  closet: 'C',
  divider: '',
  lounge: '☕',
};

function tanDeg(deg: number): number {
  return Math.tan((deg * Math.PI) / 180);
}

/**
 * The faded aeroplane behind the cabin (M6-08).
 *
 * Wings and stabilisers are drawn to a span proportionate to the cabin width and
 * cropped at the tips, so a narrowbody's swept underwing engines, a turboprop's
 * straight high wing with props, and a widebody's big sweep each read at a glance
 * without any per-type artwork. Purely decorative, so hidden from assistive tech.
 */
function PlaneBackdrop({
  frame,
  geom,
}: {
  frame: CabinFrame;
  geom: {
    cy: number;
    bodyHeight: number;
    bodyLeft: number;
    cabinM: number;
    scale: number;
  };
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

  // Engine stations along the span (fraction of half-span), per wing.
  const stations = plan.engineCount >= 4 ? [0.3, 0.58] : [0.44];
  const engines: ReactNode[] = [];
  if (plan.engine !== 'none' && plan.engine !== 'rear') {
    for (const sign of [-1, 1] as const) {
      for (const [i, f] of stations.entries()) {
        const lex = rootLEx + sweepShift * f;
        const ey = cy + sign * (halfBody + halfSpan * f);
        const nacLen = (plan.engine === 'turboprop' ? 1.9 : 2.4) * scale;
        const nacW = (plan.engine === 'turboprop' ? 0.8 : 1.1) * scale;
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
        if (plan.engine === 'turboprop') {
          engines.push(
            <ellipse
              key={`p${String(sign)}-${String(i)}`}
              className="cc-plane__prop"
              cx={lex - nacLen * 0.72}
              cy={ey}
              rx={1}
              ry={1.7 * scale}
            />,
          );
        }
      }
    }
  }

  // Horizontal stabiliser near the tail — a smaller swept wing.
  const hRootLEx = bodyLeft + plan.hStabXFraction * cabinM * scale;
  const hHalf = bodyHeight * plan.hStabSpanFactor;
  const hSweep = hHalf * tanDeg(28);
  const hChord = plan.hStabChordM * scale;
  const hStab = (sign: 1 | -1): string => {
    const rootY = cy + sign * (halfBody - 3);
    const tipY = cy + sign * (halfBody + hHalf);
    return `${String(hRootLEx)},${String(rootY)} ${String(hRootLEx + hChord)},${String(rootY)} ${String(hRootLEx + hSweep + hChord * 0.5)},${String(tipY)} ${String(hRootLEx + hSweep)},${String(tipY)}`;
  };

  return (
    <g className="cc-plane" aria-hidden="true">
      <polygon className="cc-plane__wing" points={wing(-1)} />
      <polygon className="cc-plane__wing" points={wing(1)} />
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

  // Room above and below the fuselage for the wings and stabilisers, which are
  // drawn to a proportionate span and deliberately cropped at the tips.
  const WING_ROOM = 72;
  const width = totalM * SCALE;
  const bodyTop = WING_ROOM;
  const bodyBottom = bodyTop + bodyHeight;
  const height = bodyBottom + WING_ROOM + 22;
  const bodyLeft = NOSE_M * SCALE;
  const bodyRight = bodyLeft + cabinM * SCALE;

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

  // Fuselage silhouette: a rounded body with a tapered nose and tail.
  const midY = bodyTop + bodyHeight / 2;
  const fuselage = [
    `M ${String(bodyLeft)} ${String(bodyTop)}`,
    `L ${String(bodyRight)} ${String(bodyTop)}`,
    `Q ${String(bodyRight + TAIL_M * SCALE * 0.7)} ${String(bodyTop)} ${String(width)} ${String(midY)}`,
    `Q ${String(bodyRight + TAIL_M * SCALE * 0.7)} ${String(bodyBottom)} ${String(bodyRight)} ${String(bodyBottom)}`,
    `L ${String(bodyLeft)} ${String(bodyBottom)}`,
    `Q ${String(bodyLeft - NOSE_M * SCALE * 0.8)} ${String(bodyBottom)} 0 ${String(midY)}`,
    `Q ${String(bodyLeft - NOSE_M * SCALE * 0.8)} ${String(bodyTop)} ${String(bodyLeft)} ${String(bodyTop)}`,
    'Z',
  ].join(' ');

  // A metre ruler under the plan, every 10 units of the frame's length unit.
  const rulerStep = frame.lengthUnit === 'ft' ? 10 : 10;
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
      {/* The faded aeroplane behind the cabin — wings, engines, stabilisers. */}
      <PlaneBackdrop
        frame={frame}
        geom={{ cy: midY, bodyHeight, bodyLeft, cabinM, scale: SCALE }}
      />

      <path className="cc-map__fuselage" d={fuselage} />

      {placed.map(({ entry, x, w, element }) => {
        const selected = element.id === selectedId;
        if (entry.kind === 'monument') {
          const glyph = MONUMENT_GLYPH[element.kind] ?? '';
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
                y={bodyTop + 3}
                width={Math.max(w - 2, 3)}
                height={bodyHeight - 6}
                rx={2}
              />
              {glyph !== '' && w > 8 && (
                <text className="cc-mon__glyph" x={x + w / 2} y={midY} dominantBaseline="middle">
                  {glyph}
                </text>
              )}
              {selected && (
                <rect
                  className="cc-el__bracket"
                  x={x}
                  y={bodyTop - 4}
                  width={w}
                  height={bodyHeight + 8}
                  rx={3}
                />
              )}
            </g>
          );
        }

        const row = entry.row;
        const offsets = seatOffsets(row.seatLayout, bodyHeight);
        const seatW = Math.min(w * 0.62, SEAT_DEPTH_M * SCALE * 1.6);
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
              <rect
                key={i}
                className="cc-seat"
                x={seatX}
                y={bodyTop + oy - SEAT * 0.42}
                width={seatW}
                height={SEAT * 0.84}
                rx={2}
              />
            ))}
            {row.isExitRow && (
              <>
                <path
                  className="cc-exit"
                  d={`M ${String(x + w / 2 - 4)} ${String(bodyTop - 2)} L ${String(x + w / 2 + 4)} ${String(bodyTop - 2)} L ${String(x + w / 2)} ${String(bodyTop + 4)} Z`}
                  aria-hidden="true"
                />
                <path
                  className="cc-exit"
                  d={`M ${String(x + w / 2 - 4)} ${String(bodyBottom + 2)} L ${String(x + w / 2 + 4)} ${String(bodyBottom + 2)} L ${String(x + w / 2)} ${String(bodyBottom - 4)} Z`}
                  aria-hidden="true"
                />
              </>
            )}
            {selected && (
              <rect
                className="cc-el__bracket"
                x={x}
                y={bodyTop - 4}
                width={w}
                height={bodyHeight + 8}
                rx={3}
              />
            )}
          </g>
        );
      })}

      {/* Ruler */}
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
