import type { AirlineLogo, AirlineLogoShape, AirlineLogoSymbol } from '@tailfin/shared';

import type { ReactNode } from 'react';

/**
 * Renders an {@link AirlineLogo} as inline SVG (§15/§16).
 *
 * The one place a logo becomes pixels — the viewer on the airline page and the
 * live preview in its editor are the same component, so what you edit is exactly
 * what is saved and shown. Everything is drawn from the logo's own three colours;
 * the shape is the frame, the mark is either a monogram or a built-in symbol.
 *
 * Pure and self-contained: a `viewBox` of 0..100 means it scales to any `size`
 * without re-layout, and there are no external assets to load or fail.
 */

/** The framed background shape, filled with `background` and ringed in `accent`. */
function framePath(shape: AirlineLogoShape): { tag: 'circle' | 'rect' | 'path'; attrs: object } {
  switch (shape) {
    case 'roundel':
      return { tag: 'circle', attrs: { cx: 50, cy: 50, r: 46 } };
    case 'square':
      return { tag: 'rect', attrs: { x: 6, y: 6, width: 88, height: 88, rx: 14 } };
    case 'shield':
      return {
        tag: 'path',
        attrs: { d: 'M50 5 L91 19 L91 52 C91 78 73 91 50 97 C27 91 9 78 9 52 L9 19 Z' },
      };
    case 'hexagon':
      return { tag: 'path', attrs: { d: 'M50 5 L91 27.5 L91 72.5 L50 95 L9 72.5 L9 27.5 Z' } };
  }
}

/** The centre symbol glyphs, in the same 0..100 space, painted in `foreground`. */
function symbolMark(symbol: AirlineLogoSymbol, color: string): ReactNode {
  switch (symbol) {
    case 'star':
      return (
        <path
          fill={color}
          d="M50 24 L56.1 41.6 L74.7 42 L59.9 53.2 L65.3 71 L50 60.4 L34.7 71 L40.1 53.2 L25.3 42 L43.9 41.6 Z"
        />
      );
    case 'mountain':
      return <path fill={color} d="M24 72 L44 40 L57 58 L67 44 L80 72 Z" />;
    case 'wings':
      return (
        <g fill={color}>
          <path d="M50 45 L21 50 C31 53 41 54 50 54 Z" />
          <path d="M50 45 L79 50 C69 53 59 54 50 54 Z" />
          <circle cx={50} cy={49} r={4} />
        </g>
      );
    case 'bird':
      return (
        <path
          fill="none"
          stroke={color}
          strokeWidth={6}
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M25 55 Q38 39 50 53 Q62 39 75 55"
        />
      );
    case 'globe':
      return (
        <g fill="none" stroke={color} strokeWidth={4}>
          <circle cx={50} cy={50} r={22} />
          <ellipse cx={50} cy={50} rx={9} ry={22} />
          <line x1={28} y1={50} x2={72} y2={50} />
          <line x1={33} y1={36} x2={67} y2={36} />
          <line x1={33} y1={64} x2={67} y2={64} />
        </g>
      );
  }
}

const MONOGRAM_SIZE: Record<number, number> = { 1: 48, 2: 40, 3: 31 };

export function AirlineLogoEmblem({
  logo,
  size = 96,
  label,
}: {
  logo: AirlineLogo;
  size?: number;
  label?: string;
}): ReactNode {
  const frame = framePath(logo.shape);
  const FrameTag = frame.tag;

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
      ) : (
        symbolMark(logo.mark.symbol, logo.foreground)
      )}
    </svg>
  );
}
