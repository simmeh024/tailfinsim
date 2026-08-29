import { CUSTOM_GRID_SIZE, isComposedLogo } from '@tailfin/shared';
import type { AirlineLogo, AirlineLogoCustomDesign, LegacyAirlineLogo } from '@tailfin/shared';

import { drawComposed, framePath, symbolGlyph } from './logo-draw';

import type { ReactNode } from 'react';

/**
 * Renders an {@link AirlineLogo} as inline SVG (§15/§16).
 *
 * The one place a logo becomes pixels — the viewer on the airline page and the
 * live preview in the studio are the same component, so what you edit is exactly
 * what is saved and shown. A `viewBox` of 0..100 means it scales to any `size`
 * without re-layout, and there are no external assets to load or fail.
 *
 * Two shapes flow through here: a **composed** logo (the studio's frame + palette
 * + layers) draws through {@link drawComposed}; a **legacy** logo (#789's frame +
 * single mark + three colours) keeps its original renderer below, so a logo
 * written before the studio still draws exactly as it always did.
 */

/** The mark occupies a centred square of the 0..100 emblem; legacy designs are 0..1 within it. */
export const MARK_INSET = 18;
export const MARK_SPAN = 64;
/** Map a normalised 0..1 mark coordinate into the emblem's pixel space. */
export function markToEmblem(u: number): number {
  return MARK_INSET + u * MARK_SPAN;
}

/** Draw a legacy player-designed custom mark (grid / shapes / path) into the mark region. */
function customMark(design: AirlineLogoCustomDesign, color: string): ReactNode {
  const t = markToEmblem;

  if (design.design === 'grid') {
    const u = MARK_SPAN / CUSTOM_GRID_SIZE;
    const rects: ReactNode[] = [];
    for (let row = 0; row < CUSTOM_GRID_SIZE; row += 1) {
      let col = 0;
      while (col < CUSTOM_GRID_SIZE) {
        if (design.cells[row * CUSTOM_GRID_SIZE + col] === '1') {
          let run = 1;
          while (
            col + run < CUSTOM_GRID_SIZE &&
            design.cells[row * CUSTOM_GRID_SIZE + col + run] === '1'
          ) {
            run += 1;
          }
          rects.push(
            <rect
              key={`${String(row)}-${String(col)}`}
              x={MARK_INSET + col * u}
              y={MARK_INSET + row * u}
              width={run * u}
              height={u}
              fill={color}
            />,
          );
          col += run;
        } else {
          col += 1;
        }
      }
    }
    return <g>{rects}</g>;
  }

  if (design.design === 'shapes') {
    return (
      <g fill={color}>
        {design.shapes.map((shape, index) => {
          switch (shape.type) {
            case 'circle':
              return (
                <circle key={index} cx={t(shape.cx)} cy={t(shape.cy)} r={shape.r * MARK_SPAN} />
              );
            case 'rect': {
              const w = shape.w * MARK_SPAN;
              const h = shape.h * MARK_SPAN;
              const cx = t(shape.cx);
              const cy = t(shape.cy);
              return (
                <rect
                  key={index}
                  x={cx - w / 2}
                  y={cy - h / 2}
                  width={w}
                  height={h}
                  transform={`rotate(${String(shape.rot)} ${String(cx)} ${String(cy)})`}
                />
              );
            }
            case 'triangle': {
              const cx = t(shape.cx);
              const cy = t(shape.cy);
              const radius = (shape.size * MARK_SPAN) / 2;
              const points = [0, 1, 2]
                .map((k) => {
                  const angle = ((-90 + shape.rot + k * 120) * Math.PI) / 180;
                  return `${String(cx + radius * Math.cos(angle))},${String(cy + radius * Math.sin(angle))}`;
                })
                .join(' ');
              return <polygon key={index} points={points} />;
            }
            case 'line':
              return (
                <line
                  key={index}
                  x1={t(shape.x1)}
                  y1={t(shape.y1)}
                  x2={t(shape.x2)}
                  y2={t(shape.y2)}
                  stroke={color}
                  strokeWidth={shape.width * MARK_SPAN}
                  strokeLinecap="round"
                />
              );
          }
        })}
      </g>
    );
  }

  const d =
    design.points
      .map((p, index) => `${index === 0 ? 'M' : 'L'}${String(t(p.x))} ${String(t(p.y))}`)
      .join(' ') + (design.closed ? ' Z' : '');
  return design.closed ? (
    <path d={d} fill={color} />
  ) : (
    <path
      d={d}
      fill="none"
      stroke={color}
      strokeWidth={6}
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  );
}

const MONOGRAM_SIZE: Record<number, number> = { 1: 48, 2: 40, 3: 31 };

/** The legacy #789 emblem body: frame + a single centred mark, three colours. */
function LegacyBody({ logo }: { logo: LegacyAirlineLogo }): ReactNode {
  const frame = framePath(logo.shape);
  const FrameTag = frame.tag;
  return (
    <>
      <FrameTag {...frame.attrs} fill={logo.background} stroke={logo.accent} strokeWidth={5} />
      {logo.mark.kind === 'monogram' ? (
        <text
          x={50}
          y={52}
          textAnchor="middle"
          dominantBaseline="central"
          fontFamily="'Inter', system-ui, sans-serif"
          fontWeight={700}
          fontSize={MONOGRAM_SIZE[logo.mark.text.length] ?? 31}
          fill={logo.foreground}
        >
          {logo.mark.text}
        </text>
      ) : logo.mark.kind === 'symbol' ? (
        symbolGlyph(logo.mark.symbol, logo.foreground)
      ) : (
        customMark(logo.mark.custom, logo.foreground)
      )}
    </>
  );
}

export function AirlineLogoEmblem({
  logo,
  size = 96,
  label,
}: {
  logo: AirlineLogo;
  size?: number;
  label?: string;
}): ReactNode {
  return (
    <svg
      className="airline-logo-emblem"
      width={size}
      height={size}
      viewBox="0 0 100 100"
      role="img"
      aria-label={label ?? 'Airline logo'}
      xmlns="http://www.w3.org/2000/svg"
    >
      {isComposedLogo(logo) ? drawComposed(logo) : <LegacyBody logo={logo} />}
    </svg>
  );
}
