import type {
  AirlineLogoLayer,
  AirlineLogoLayerContent,
  AirlineLogoPaint,
  AirlineLogoPalette,
  AirlineLogoShape,
  AirlineLogoSymbol,
  ComposedAirlineLogo,
} from '@tailfin/shared';

import type { ReactNode } from 'react';

/**
 * One source of truth for turning a composed logo into SVG.
 *
 * Both the {@link AirlineLogoEmblem} viewer and the studio canvas draw from these
 * helpers, in the same 0..100 `viewBox`, so what the editor shows is exactly what
 * is saved and rendered everywhere else. Layer coordinates are normalised 0..1
 * over the whole emblem; `S` (100) scales them into the viewBox.
 */

export const EMBLEM_SPAN = 100;

/** The framed background shape, in 0..100 space. Shared with the legacy renderer. */
export function framePath(shape: AirlineLogoShape): {
  tag: 'circle' | 'rect' | 'path';
  attrs: Record<string, number | string>;
} {
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

/** A built-in symbol drawn in its native 0..100 box, centred on (50,50). */
export function symbolGlyph(symbol: AirlineLogoSymbol, color: string): ReactNode {
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
/** The native box a symbol glyph occupies, so a sized symbol layer scales sanely. */
const SYMBOL_NATIVE_SPAN = 60;

/**
 * Resolve a fill/stroke reference to a hex colour, or `undefined` for `none`.
 * A palette slot name resolves against the palette; anything else is already a
 * literal `#RRGGBB` (a layer's own colour) and is returned as-is.
 */
export function resolvePaint(
  palette: AirlineLogoPalette,
  paint: AirlineLogoPaint,
): string | undefined {
  if (paint === 'none') return undefined;
  if (paint === 'background' || paint === 'mark' || paint === 'ring' || paint === 'accent') {
    return palette[paint];
  }
  return paint;
}

/** The centre of a layer's content, in normalised 0..1 space. */
export function layerCenter(content: AirlineLogoLayerContent): { x: number; y: number } {
  switch (content.type) {
    case 'line':
      return { x: (content.x1 + content.x2) / 2, y: (content.y1 + content.y2) / 2 };
    case 'path': {
      const xs = content.points.map((p) => p.x);
      const ys = content.points.map((p) => p.y);
      return {
        x: (Math.min(...xs) + Math.max(...xs)) / 2,
        y: (Math.min(...ys) + Math.max(...ys)) / 2,
      };
    }
    default:
      return { x: content.cx, y: content.cy };
  }
}

const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));

/** Move a layer's content so its centre lands on (nx, ny), clamped into range. */
export function moveLayerContent(
  content: AirlineLogoLayerContent,
  nx: number,
  ny: number,
): AirlineLogoLayerContent {
  const mid = layerCenter(content);
  const dx = nx - mid.x;
  const dy = ny - mid.y;
  if (content.type === 'line') {
    return {
      ...content,
      x1: clamp01(content.x1 + dx),
      y1: clamp01(content.y1 + dy),
      x2: clamp01(content.x2 + dx),
      y2: clamp01(content.y2 + dy),
    };
  }
  if (content.type === 'path') {
    return {
      ...content,
      points: content.points.map((p) => ({ x: clamp01(p.x + dx), y: clamp01(p.y + dy) })),
    };
  }
  return { ...content, cx: clamp01(nx), cy: clamp01(ny) };
}

const MONOGRAM_FONT: Record<number, number> = { 1: 1.06, 2: 0.9, 3: 0.7 };

/** Vertices of a regular n-gon, point-up, as an SVG `points` string. */
function regularPolygonPoints(cx: number, cy: number, radius: number, sides: number): string {
  return Array.from({ length: sides }, (_, k) => {
    const angle = ((-90 + (360 / sides) * k) * Math.PI) / 180;
    return `${String(cx + radius * Math.cos(angle))},${String(cy + radius * Math.sin(angle))}`;
  }).join(' ');
}

/** Vertices of an n-pointed star, point-up, alternating outer and inner radius. */
function starPointsString(cx: number, cy: number, radius: number, points: number): string {
  const inner = radius * 0.42;
  return Array.from({ length: points * 2 }, (_, k) => {
    const r = k % 2 === 0 ? radius : inner;
    const angle = ((-90 + (180 / points) * k) * Math.PI) / 180;
    return `${String(cx + r * Math.cos(angle))},${String(cy + r * Math.sin(angle))}`;
  }).join(' ');
}

/** Draw one layer's geometry, painted from the palette. Returns the inner nodes. */
function drawContent(
  content: AirlineLogoLayerContent,
  fill: string | undefined,
  stroke: string | undefined,
  strokeWidth: number,
): ReactNode {
  const S = EMBLEM_SPAN;
  const t = (u: number): number => u * S;
  const sw = strokeWidth * S;
  const strokeProps =
    stroke !== undefined && strokeWidth > 0
      ? {
          stroke,
          strokeWidth: sw,
          strokeLinecap: 'round' as const,
          strokeLinejoin: 'round' as const,
        }
      : {};
  const fillProp = fill ?? 'none';

  switch (content.type) {
    case 'circle':
      return (
        <circle
          cx={t(content.cx)}
          cy={t(content.cy)}
          r={content.r * S}
          fill={fillProp}
          {...strokeProps}
        />
      );
    case 'ellipse':
      return (
        <ellipse
          cx={t(content.cx)}
          cy={t(content.cy)}
          rx={content.rx * S}
          ry={content.ry * S}
          fill={fillProp}
          {...strokeProps}
        />
      );
    case 'rect': {
      const w = content.w * S;
      const h = content.h * S;
      const x = t(content.cx);
      const y = t(content.cy);
      return (
        <rect x={x - w / 2} y={y - h / 2} width={w} height={h} fill={fillProp} {...strokeProps} />
      );
    }
    case 'triangle':
      return (
        <polygon
          points={regularPolygonPoints(t(content.cx), t(content.cy), (content.size * S) / 2, 3)}
          fill={fillProp}
          {...strokeProps}
        />
      );
    case 'polygon':
      return (
        <polygon
          points={regularPolygonPoints(
            t(content.cx),
            t(content.cy),
            (content.size * S) / 2,
            content.sides,
          )}
          fill={fillProp}
          {...strokeProps}
        />
      );
    case 'star':
      return (
        <polygon
          points={starPointsString(
            t(content.cx),
            t(content.cy),
            (content.size * S) / 2,
            content.points,
          )}
          fill={fillProp}
          {...strokeProps}
        />
      );
    case 'line':
      return (
        <line
          x1={t(content.x1)}
          y1={t(content.y1)}
          x2={t(content.x2)}
          y2={t(content.y2)}
          stroke={stroke ?? fill ?? 'currentColor'}
          strokeWidth={Math.max(sw, 0.5)}
          strokeLinecap="round"
        />
      );
    case 'path': {
      const d =
        content.points
          .map((p, i) => `${i === 0 ? 'M' : 'L'}${String(t(p.x))} ${String(t(p.y))}`)
          .join(' ') + (content.closed ? ' Z' : '');
      return content.closed ? (
        <path d={d} fill={fillProp} {...strokeProps} />
      ) : (
        <path
          d={d}
          fill="none"
          stroke={stroke ?? fill ?? 'currentColor'}
          strokeWidth={Math.max(sw, 0.5)}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      );
    }
    case 'text': {
      const x = t(content.cx);
      const y = t(content.cy);
      const fontSize = content.size * S * (MONOGRAM_FONT[content.text.length] ?? 0.7);
      return (
        <text
          x={x}
          y={y}
          textAnchor="middle"
          dominantBaseline="central"
          fontFamily="'Inter', system-ui, sans-serif"
          fontWeight={700}
          fontSize={fontSize}
          fill={fillProp}
          {...strokeProps}
        >
          {content.text}
        </text>
      );
    }
    case 'symbol': {
      const x = t(content.cx);
      const y = t(content.cy);
      const k = (content.size * S) / SYMBOL_NATIVE_SPAN;
      // The glyph paints in its own colour; we drive that colour from the fill slot.
      const color = fill ?? stroke ?? 'currentColor';
      return (
        <g
          transform={`translate(${String(x)} ${String(y)}) scale(${String(k)}) translate(-50 -50)`}
        >
          {symbolGlyph(content.symbol, color)}
        </g>
      );
    }
  }
}

/** Draw a whole layer (or nothing, if hidden), resolving its paints from the palette. */
export function drawLayer(layer: AirlineLogoLayer, palette: AirlineLogoPalette): ReactNode {
  if (layer.hidden) return null;
  const fill = resolvePaint(palette, layer.fill);
  const stroke = resolvePaint(palette, layer.stroke);
  // Rotation is applied once, around the content's own centre, so every element
  // type rotates identically — including line and path, which have no angle field.
  const c = layerCenter(layer.content);
  const transform =
    layer.rotation === 0
      ? undefined
      : `rotate(${String(layer.rotation)} ${String(c.x * EMBLEM_SPAN)} ${String(c.y * EMBLEM_SPAN)})`;
  return (
    <g opacity={layer.opacity} transform={transform}>
      {drawContent(layer.content, fill, stroke, layer.strokeWidth)}
    </g>
  );
}

/** The frame plus every visible layer, back to front — the composed emblem's body. */
export function drawComposed(logo: ComposedAirlineLogo): ReactNode {
  const frame = framePath(logo.shape);
  const FrameTag = frame.tag;
  const frameFill = resolvePaint(logo.palette, logo.frameFill) ?? 'none';
  const frameStroke = resolvePaint(logo.palette, logo.frameStroke);
  return (
    <>
      <FrameTag
        {...frame.attrs}
        fill={frameFill}
        stroke={frameStroke ?? 'none'}
        strokeWidth={frameStroke !== undefined ? 5 : 0}
      />
      {logo.layers.map((layer) => (
        <g key={layer.id}>{drawLayer(layer, logo.palette)}</g>
      ))}
    </>
  );
}
