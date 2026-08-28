import { useRef, useState } from 'react';

import {
  CUSTOM_GRID_SIZE,
  defaultCustomDesign,
  type AirlineLogoCustomDesign,
  type AirlineLogoGridDesign,
  type AirlineLogoPathDesign,
  type AirlineLogoShapePrimitive,
  type AirlineLogoShapesDesign,
} from '@tailfin/shared';

import type { PointerEvent as ReactPointerEvent, ReactNode } from 'react';

/**
 * The custom symbol designer (§15/§16 follow-up).
 *
 * Three tools of increasing depth over one output — the player picks how far to
 * go, and every tool writes the same {@link AirlineLogoCustomDesign} the emblem
 * renderer already draws, so the preview is exact:
 *
 *  - **Grid**: paint a 16×16 monochrome bitmap, click-and-drag.
 *  - **Shapes**: stack primitives (circle / square / triangle / line), each moved
 *    on the canvas and sized with sliders.
 *  - **Path**: drop and drag points into a freeform polygon, open or closed.
 *
 * The canvas is a 0..100 viewBox; the design's normalised 0..1 space maps into the
 * padded drawable square, the same relative layout the emblem uses.
 */

const PAD = 6;
const SPAN = 88;
const cc = (u: number): number => PAD + u * SPAN;
const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));

function unitFromPointer(svg: SVGSVGElement, event: ReactPointerEvent): { x: number; y: number } {
  const rect = svg.getBoundingClientRect();
  const vx = ((event.clientX - rect.left) / rect.width) * 100;
  const vy = ((event.clientY - rect.top) / rect.height) * 100;
  return { x: clamp01((vx - PAD) / SPAN), y: clamp01((vy - PAD) / SPAN) };
}

function CanvasFrame({
  svgRef,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  children,
}: {
  svgRef: React.RefObject<SVGSVGElement | null>;
  onPointerDown?: (event: ReactPointerEvent) => void;
  onPointerMove?: (event: ReactPointerEvent) => void;
  onPointerUp?: (event: ReactPointerEvent) => void;
  children: ReactNode;
}): ReactNode {
  return (
    <svg
      ref={svgRef}
      className="symbol-designer__canvas"
      viewBox="0 0 100 100"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerLeave={onPointerUp}
    >
      <rect x={PAD} y={PAD} width={SPAN} height={SPAN} className="symbol-designer__bed" />
      {children}
    </svg>
  );
}

/* --------------------------------------------------------------------- Grid */

function GridDesigner({
  design,
  onChange,
  color,
}: {
  design: AirlineLogoGridDesign;
  onChange: (next: AirlineLogoCustomDesign) => void;
  color: string;
}): ReactNode {
  const svgRef = useRef<SVGSVGElement>(null);
  const paint = useRef<'0' | '1' | null>(null);
  const cell = SPAN / CUSTOM_GRID_SIZE;

  const indexAt = (event: ReactPointerEvent): number | null => {
    const svg = svgRef.current;
    if (!svg) return null;
    const rect = svg.getBoundingClientRect();
    const vx = ((event.clientX - rect.left) / rect.width) * 100;
    const vy = ((event.clientY - rect.top) / rect.height) * 100;
    const col = Math.floor((vx - PAD) / cell);
    const row = Math.floor((vy - PAD) / cell);
    if (col < 0 || col >= CUSTOM_GRID_SIZE || row < 0 || row >= CUSTOM_GRID_SIZE) return null;
    return row * CUSTOM_GRID_SIZE + col;
  };

  const setCell = (index: number, value: '0' | '1'): void => {
    if (design.cells[index] === value) return;
    onChange({
      design: 'grid',
      cells: design.cells.slice(0, index) + value + design.cells.slice(index + 1),
    });
  };

  const onDown = (event: ReactPointerEvent): void => {
    const index = indexAt(event);
    if (index === null) return;
    const value = design.cells[index] === '1' ? '0' : '1';
    paint.current = value;
    svgRef.current?.setPointerCapture(event.pointerId);
    setCell(index, value);
  };
  const onMove = (event: ReactPointerEvent): void => {
    if (paint.current === null) return;
    const index = indexAt(event);
    if (index !== null) setCell(index, paint.current);
  };
  const onUp = (): void => {
    paint.current = null;
  };

  const cells: ReactNode[] = [];
  for (let row = 0; row < CUSTOM_GRID_SIZE; row += 1) {
    for (let col = 0; col < CUSTOM_GRID_SIZE; col += 1) {
      const on = design.cells[row * CUSTOM_GRID_SIZE + col] === '1';
      cells.push(
        <rect
          key={`${String(row)}-${String(col)}`}
          x={PAD + col * cell}
          y={PAD + row * cell}
          width={cell}
          height={cell}
          fill={on ? color : 'transparent'}
          className="symbol-designer__grid-cell"
        />,
      );
    }
  }

  const map = (fn: (c: string) => string): void =>
    onChange({ design: 'grid', cells: [...design.cells].map(fn).join('') });

  return (
    <>
      <CanvasFrame svgRef={svgRef} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp}>
        {cells}
      </CanvasFrame>
      <div className="symbol-designer__row">
        <button type="button" onClick={() => map(() => '0')}>
          Clear
        </button>
        <button type="button" onClick={() => map((c) => (c === '1' ? '0' : '1'))}>
          Invert
        </button>
        <button type="button" onClick={() => map(() => '1')}>
          Fill
        </button>
      </div>
      <p className="symbol-designer__hint">
        Click or drag across the grid to paint. Drag again to erase.
      </p>
    </>
  );
}

/* ------------------------------------------------------------------- Shapes */

function shapeCenter(shape: AirlineLogoShapePrimitive): { x: number; y: number } {
  if (shape.type === 'line') return { x: (shape.x1 + shape.x2) / 2, y: (shape.y1 + shape.y2) / 2 };
  return { x: shape.cx, y: shape.cy };
}

function moveShape(
  shape: AirlineLogoShapePrimitive,
  nx: number,
  ny: number,
): AirlineLogoShapePrimitive {
  if (shape.type === 'line') {
    const mid = shapeCenter(shape);
    const dx = nx - mid.x;
    const dy = ny - mid.y;
    return {
      ...shape,
      x1: clamp01(shape.x1 + dx),
      y1: clamp01(shape.y1 + dy),
      x2: clamp01(shape.x2 + dx),
      y2: clamp01(shape.y2 + dy),
    };
  }
  return { ...shape, cx: clamp01(nx), cy: clamp01(ny) };
}

function defaultShape(type: AirlineLogoShapePrimitive['type']): AirlineLogoShapePrimitive {
  switch (type) {
    case 'circle':
      return { type: 'circle', cx: 0.5, cy: 0.5, r: 0.2 };
    case 'rect':
      return { type: 'rect', cx: 0.5, cy: 0.5, w: 0.32, h: 0.32, rot: 0 };
    case 'triangle':
      return { type: 'triangle', cx: 0.5, cy: 0.5, size: 0.4, rot: 0 };
    case 'line':
      return { type: 'line', x1: 0.3, y1: 0.5, x2: 0.7, y2: 0.5, width: 0.08 };
  }
}

function drawShape(shape: AirlineLogoShapePrimitive, key: number, color: string): ReactNode {
  switch (shape.type) {
    case 'circle':
      return (
        <circle key={key} cx={cc(shape.cx)} cy={cc(shape.cy)} r={shape.r * SPAN} fill={color} />
      );
    case 'rect': {
      const w = shape.w * SPAN;
      const h = shape.h * SPAN;
      const x = cc(shape.cx);
      const y = cc(shape.cy);
      return (
        <rect
          key={key}
          x={x - w / 2}
          y={y - h / 2}
          width={w}
          height={h}
          transform={`rotate(${String(shape.rot)} ${String(x)} ${String(y)})`}
          fill={color}
        />
      );
    }
    case 'triangle': {
      const x = cc(shape.cx);
      const y = cc(shape.cy);
      const radius = (shape.size * SPAN) / 2;
      const points = [0, 1, 2]
        .map((k) => {
          const angle = ((-90 + shape.rot + k * 120) * Math.PI) / 180;
          return `${String(x + radius * Math.cos(angle))},${String(y + radius * Math.sin(angle))}`;
        })
        .join(' ');
      return <polygon key={key} points={points} fill={color} />;
    }
    case 'line':
      return (
        <line
          key={key}
          x1={cc(shape.x1)}
          y1={cc(shape.y1)}
          x2={cc(shape.x2)}
          y2={cc(shape.y2)}
          stroke={color}
          strokeWidth={shape.width * SPAN}
          strokeLinecap="round"
        />
      );
  }
}

function ShapesDesigner({
  design,
  onChange,
  color,
}: {
  design: AirlineLogoShapesDesign;
  onChange: (next: AirlineLogoCustomDesign) => void;
  color: string;
}): ReactNode {
  const svgRef = useRef<SVGSVGElement>(null);
  const dragging = useRef(false);
  const [selected, setSelected] = useState(design.shapes.length - 1);
  const active = design.shapes[selected];

  const commit = (shapes: AirlineLogoShapePrimitive[]): void =>
    onChange({ design: 'shapes', shapes });

  const add = (type: AirlineLogoShapePrimitive['type']): void => {
    if (design.shapes.length >= 24) return;
    commit([...design.shapes, defaultShape(type)]);
    setSelected(design.shapes.length);
  };

  const patchActive = (next: AirlineLogoShapePrimitive): void => {
    commit(design.shapes.map((shape, index) => (index === selected ? next : shape)));
  };

  const remove = (): void => {
    const shapes = design.shapes.filter((_, index) => index !== selected);
    if (shapes.length === 0) {
      commit([defaultShape('circle')]);
      setSelected(0);
      return;
    }
    commit(shapes);
    setSelected(Math.max(0, selected - 1));
  };

  const onDown = (event: ReactPointerEvent): void => {
    const svg = svgRef.current;
    if (!svg) return;
    const point = unitFromPointer(svg, event);
    // Select the nearest shape centre within reach, and start dragging it.
    let best = -1;
    let bestDistance = 0.2;
    design.shapes.forEach((shape, index) => {
      const centre = shapeCenter(shape);
      const distance = Math.hypot(centre.x - point.x, centre.y - point.y);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = index;
      }
    });
    if (best >= 0) {
      setSelected(best);
      dragging.current = true;
      svg.setPointerCapture(event.pointerId);
    }
  };
  const onMove = (event: ReactPointerEvent): void => {
    if (!dragging.current || !active || !svgRef.current) return;
    const point = unitFromPointer(svgRef.current, event);
    patchActive(moveShape(active, point.x, point.y));
  };
  const onUp = (): void => {
    dragging.current = false;
  };

  return (
    <>
      <div className="symbol-designer__row">
        {(['circle', 'rect', 'triangle', 'line'] as const).map((type) => (
          <button
            key={type}
            type="button"
            onClick={() => add(type)}
            disabled={design.shapes.length >= 24}
          >
            + {type === 'rect' ? 'Square' : type[0]!.toUpperCase() + type.slice(1)}
          </button>
        ))}
      </div>
      <CanvasFrame svgRef={svgRef} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp}>
        {design.shapes.map((shape, index) => (
          <g key={index} opacity={index === selected ? 1 : 0.85}>
            {drawShape(shape, index, color)}
            {index === selected && (
              <circle
                cx={cc(shapeCenter(shape).x)}
                cy={cc(shapeCenter(shape).y)}
                r={2.5}
                className="symbol-designer__handle"
              />
            )}
          </g>
        ))}
      </CanvasFrame>

      {active && (
        <div className="symbol-designer__controls">
          {active.type === 'circle' && (
            <Slider
              label="Size"
              min={0.02}
              max={0.5}
              value={active.r}
              onChange={(r) => patchActive({ ...active, r })}
            />
          )}
          {active.type === 'rect' && (
            <>
              <Slider
                label="Size"
                min={0.02}
                max={1}
                value={active.w}
                onChange={(v) => patchActive({ ...active, w: v, h: v })}
              />
              <Slider
                label="Rotate"
                min={-180}
                max={180}
                value={active.rot}
                onChange={(rot) => patchActive({ ...active, rot })}
              />
            </>
          )}
          {active.type === 'triangle' && (
            <>
              <Slider
                label="Size"
                min={0.04}
                max={1}
                value={active.size}
                onChange={(size) => patchActive({ ...active, size })}
              />
              <Slider
                label="Rotate"
                min={-180}
                max={180}
                value={active.rot}
                onChange={(rot) => patchActive({ ...active, rot })}
              />
            </>
          )}
          {active.type === 'line' && (
            <Slider
              label="Thickness"
              min={0.01}
              max={0.3}
              value={active.width}
              onChange={(width) => patchActive({ ...active, width })}
            />
          )}
          <button type="button" onClick={remove}>
            Remove
          </button>
        </div>
      )}
      <p className="symbol-designer__hint">
        Add a primitive, then drag it on the canvas to place it. {design.shapes.length} of 24 used.
      </p>
    </>
  );
}

/* --------------------------------------------------------------------- Path */

function PathDesigner({
  design,
  onChange,
  color,
}: {
  design: AirlineLogoPathDesign;
  onChange: (next: AirlineLogoCustomDesign) => void;
  color: string;
}): ReactNode {
  const svgRef = useRef<SVGSVGElement>(null);
  const dragging = useRef<number | null>(null);

  const commit = (next: Partial<AirlineLogoPathDesign>): void =>
    onChange({ design: 'path', points: design.points, closed: design.closed, ...next });

  const onDown = (event: ReactPointerEvent): void => {
    const svg = svgRef.current;
    if (!svg) return;
    const point = unitFromPointer(svg, event);
    // Grab the nearest existing point, or drop a new one.
    let best = -1;
    let bestDistance = 0.05;
    design.points.forEach((p, index) => {
      const distance = Math.hypot(p.x - point.x, p.y - point.y);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = index;
      }
    });
    if (best >= 0) {
      dragging.current = best;
    } else if (design.points.length < 64) {
      dragging.current = design.points.length;
      commit({ points: [...design.points, point] });
    }
    svg.setPointerCapture(event.pointerId);
  };
  const onMove = (event: ReactPointerEvent): void => {
    const index = dragging.current;
    if (index === null || !svgRef.current) return;
    const point = unitFromPointer(svgRef.current, event);
    commit({ points: design.points.map((p, i) => (i === index ? point : p)) });
  };
  const onUp = (): void => {
    dragging.current = null;
  };

  const d =
    design.points
      .map((p, i) => `${i === 0 ? 'M' : 'L'}${String(cc(p.x))} ${String(cc(p.y))}`)
      .join(' ') + (design.closed ? ' Z' : '');

  return (
    <>
      <CanvasFrame svgRef={svgRef} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp}>
        {design.closed ? (
          <path d={d} fill={color} />
        ) : (
          <path d={d} fill="none" stroke={color} strokeWidth={4} strokeLinecap="round" />
        )}
        {design.points.map((p, index) => (
          <circle
            key={index}
            cx={cc(p.x)}
            cy={cc(p.y)}
            r={2.4}
            className="symbol-designer__handle"
          />
        ))}
      </CanvasFrame>
      <div className="symbol-designer__row">
        <label className="symbol-designer__toggle">
          <input
            type="checkbox"
            checked={design.closed}
            onChange={(event) => commit({ closed: event.target.checked })}
          />
          Closed
        </label>
        <button
          type="button"
          disabled={design.points.length <= 2}
          onClick={() => commit({ points: design.points.slice(0, -1) })}
        >
          Undo point
        </button>
        <button type="button" onClick={() => onChange(defaultCustomDesign('path'))}>
          Reset
        </button>
      </div>
      <p className="symbol-designer__hint">
        Click to add a point, drag a point to move it. {design.points.length} of 64 points.
      </p>
    </>
  );
}

/* ------------------------------------------------------------------- Slider */

function Slider({
  label,
  min,
  max,
  value,
  onChange,
}: {
  label: string;
  min: number;
  max: number;
  value: number;
  onChange: (next: number) => void;
}): ReactNode {
  return (
    <label className="symbol-designer__slider">
      <span>{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={max - min > 10 ? 1 : 0.01}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </label>
  );
}

/* ------------------------------------------------------------------- Parent */

const MODES: { design: AirlineLogoCustomDesign['design']; label: string }[] = [
  { design: 'grid', label: 'Grid' },
  { design: 'shapes', label: 'Shapes' },
  { design: 'path', label: 'Path' },
];

export function CustomSymbolDesigner({
  value,
  onChange,
  color,
}: {
  value: AirlineLogoCustomDesign;
  onChange: (next: AirlineLogoCustomDesign) => void;
  color: string;
}): ReactNode {
  // Remember the last design of each tool, so switching tools and back does not
  // discard work — the same idea as the initials/symbol memory in the logo editor.
  const remembered = useRef<Record<string, AirlineLogoCustomDesign>>({});
  remembered.current[value.design] = value;

  const switchTo = (design: AirlineLogoCustomDesign['design']): void => {
    if (design === value.design) return;
    onChange(remembered.current[design] ?? defaultCustomDesign(design));
  };

  return (
    <div className="symbol-designer">
      <div className="symbol-designer__modes" role="group" aria-label="Design tool">
        {MODES.map((mode) => (
          <button
            key={mode.design}
            type="button"
            aria-pressed={value.design === mode.design}
            onClick={() => switchTo(mode.design)}
          >
            {mode.label}
          </button>
        ))}
      </div>

      {value.design === 'grid' && <GridDesigner design={value} onChange={onChange} color={color} />}
      {value.design === 'shapes' && (
        <ShapesDesigner design={value} onChange={onChange} color={color} />
      )}
      {value.design === 'path' && <PathDesigner design={value} onChange={onChange} color={color} />}
    </div>
  );
}
