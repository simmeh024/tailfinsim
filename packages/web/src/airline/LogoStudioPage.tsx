import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';

import {
  AIRLINE_LOGO_LAYER_TYPES,
  AIRLINE_LOGO_PALETTE_SLOTS,
  AIRLINE_LOGO_SHAPES,
  AIRLINE_LOGO_SYMBOLS,
  defaultAirlineLogo,
  isComposedLogo,
  legacyToComposed,
  MAX_LOGO_LAYERS,
  newLayer,
  type AirlineLogoLayer,
  type AirlineLogoLayerContent,
  type AirlineLogoLayerType,
  type AirlineLogoPaint,
  type AirlineLogoPaletteSlot,
  type AirlineLogoShape,
  type AirlineLogoSymbol,
  type ComposedAirlineLogo,
  type OwnAirlineResponse,
} from '@tailfin/shared';

import { AirlineLogoEmblem } from './AirlineLogoEmblem';
import { fetchOwnAirline, formatMinorUnits, patchOwnAirline } from './api';
import { drawLayer, framePath, layerCenter, moveLayerContent, resolvePaint } from './logo-draw';

import type { PointerEvent as ReactPointerEvent, ReactNode } from 'react';

/**
 * The full-screen brand-logo studio (§15/§16).
 *
 * A dedicated page rather than an inline form: the airline page shows the current
 * emblem with an "Edit logo" button, and this is where the design actually
 * happens — a frame, a four-slot brand palette, and a stack of layers, each drawn
 * by the same {@link drawLayer} the viewer uses, so the canvas is the save.
 *
 * The studio owns a working copy of a {@link ComposedAirlineLogo} plus an undo
 * history. Saving is the paid rebrand (AIR-08): it PATCHes the logo while carrying
 * the airline's current name/callsign/country unchanged, then returns to the
 * airline page. Nothing here moves money until the player presses Rebrand.
 */

/* --------------------------------------------------------------- history hook */

interface History<T> {
  present: T;
  /** Commit one atomic change as a new undo step. */
  commit: (next: T) => void;
  /** Update the working value without a new step (during a drag or slider). */
  live: (next: T) => void;
  /** Close a gesture: record the pre-gesture value as the undo step. */
  seal: (base: T) => void;
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  reset: (value: T) => void;
}

const UNDO_DEPTH = 60;

function useHistory<T>(initial: T): History<T> {
  const [past, setPast] = useState<T[]>([]);
  const [present, setPresent] = useState<T>(initial);
  const [future, setFuture] = useState<T[]>([]);

  const commit = useCallback(
    (next: T) => {
      setPast((p) => [...p, present].slice(-UNDO_DEPTH));
      setPresent(next);
      setFuture([]);
      // `present` is intentionally captured; each commit reads the latest via closure refresh.
    },
    [present],
  );

  const live = useCallback((next: T) => {
    setPresent(next);
    setFuture([]);
  }, []);

  const seal = useCallback((base: T) => {
    setPast((p) => [...p, base].slice(-UNDO_DEPTH));
    setFuture([]);
  }, []);

  const undo = useCallback(() => {
    setPast((p) => {
      if (p.length === 0) return p;
      const previous = p[p.length - 1]!;
      setFuture((f) => [present, ...f]);
      setPresent(previous);
      return p.slice(0, -1);
    });
  }, [present]);

  const redo = useCallback(() => {
    setFuture((f) => {
      if (f.length === 0) return f;
      const next = f[0]!;
      setPast((p) => [...p, present].slice(-UNDO_DEPTH));
      setPresent(next);
      return f.slice(1);
    });
  }, [present]);

  const reset = useCallback((value: T) => {
    setPast([]);
    setFuture([]);
    setPresent(value);
  }, []);

  return {
    present,
    commit,
    live,
    seal,
    undo,
    redo,
    canUndo: past.length > 0,
    canRedo: future.length > 0,
    reset,
  };
}

/* ---------------------------------------------------------------- geometry -- */

const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));

/** The axis-aligned bounds of a layer's content, in 0..1 space. */
function layerBounds(content: AirlineLogoLayerContent): {
  x: number;
  y: number;
  w: number;
  h: number;
} {
  switch (content.type) {
    case 'circle':
      return {
        x: content.cx - content.r,
        y: content.cy - content.r,
        w: content.r * 2,
        h: content.r * 2,
      };
    case 'rect':
      return {
        x: content.cx - content.w / 2,
        y: content.cy - content.h / 2,
        w: content.w,
        h: content.h,
      };
    case 'triangle':
    case 'text':
    case 'symbol':
      return {
        x: content.cx - content.size / 2,
        y: content.cy - content.size / 2,
        w: content.size,
        h: content.size,
      };
    case 'line': {
      const x = Math.min(content.x1, content.x2);
      const y = Math.min(content.y1, content.y2);
      return { x, y, w: Math.abs(content.x2 - content.x1), h: Math.abs(content.y2 - content.y1) };
    }
    case 'path': {
      const xs = content.points.map((p) => p.x);
      const ys = content.points.map((p) => p.y);
      const x = Math.min(...xs);
      const y = Math.min(...ys);
      return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
    }
  }
}

/* ------------------------------------------------------------------ labels -- */

const SHAPE_LABELS: Record<AirlineLogoShape, string> = {
  roundel: 'Rounded',
  shield: 'Shield',
  square: 'Square',
  hexagon: 'Hexagon',
};

const TYPE_LABELS: Record<AirlineLogoLayerType, string> = {
  circle: 'Circle',
  rect: 'Square',
  triangle: 'Triangle',
  line: 'Line',
  text: 'Initials',
  symbol: 'Symbol',
  path: 'Path',
};

const TYPE_GLYPH: Record<AirlineLogoLayerType, string> = {
  circle: '○',
  rect: '□',
  triangle: '△',
  line: '─',
  text: 'A',
  symbol: '☆',
  path: '⌇',
};

const SLOT_LABELS: Record<AirlineLogoPaletteSlot, string> = {
  background: 'Background',
  mark: 'Mark',
  ring: 'Ring',
  accent: 'Accent',
};

const SYMBOL_LABELS: Record<AirlineLogoSymbol, string> = {
  wings: 'Wings',
  star: 'Star',
  globe: 'Globe',
  mountain: 'Mountain',
  bird: 'Bird',
};

/* --------------------------------------------------------------- small parts */

function Field({
  label,
  value,
  min,
  max,
  onChange,
  onCommit,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (v: number) => void;
  onCommit: () => void;
}): ReactNode {
  return (
    <label className="logo-studio__number">
      <span>{label}</span>
      <input
        type="number"
        min={min}
        max={max}
        value={Math.round(value)}
        onChange={(e) => onChange(Number(e.target.value))}
        onBlur={onCommit}
      />
    </label>
  );
}

function Slider({
  label,
  min,
  max,
  step,
  value,
  suffix,
  onInput,
  onStart,
  onEnd,
}: {
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  suffix?: string;
  onInput: (v: number) => void;
  onStart: () => void;
  onEnd: () => void;
}): ReactNode {
  return (
    <div className="logo-studio__slider">
      <div className="logo-studio__slider-head">
        <span>{label}</span>
        <span className="figure">
          {Math.round(value)}
          {suffix}
        </span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onPointerDown={onStart}
        onKeyDown={onStart}
        onPointerUp={onEnd}
        onBlur={onEnd}
        onChange={(e) => onInput(Number(e.target.value))}
      />
    </div>
  );
}

/* ------------------------------------------------------------------- canvas */

function StudioCanvas({
  logo,
  selectedId,
  showGuides,
  onSelect,
  onMoveLive,
  onMoveStart,
  onMoveEnd,
}: {
  logo: ComposedAirlineLogo;
  selectedId: string | null;
  showGuides: boolean;
  onSelect: (id: string) => void;
  onMoveLive: (id: string, nx: number, ny: number) => void;
  onMoveStart: () => void;
  onMoveEnd: () => void;
}): ReactNode {
  const svgRef = useRef<SVGSVGElement>(null);
  const dragging = useRef<string | null>(null);

  const pointerUnit = (event: ReactPointerEvent): { x: number; y: number } => {
    const svg = svgRef.current!;
    const rect = svg.getBoundingClientRect();
    return {
      x: clamp01((event.clientX - rect.left) / rect.width),
      y: clamp01((event.clientY - rect.top) / rect.height),
    };
  };

  const onDown = (event: ReactPointerEvent): void => {
    const point = pointerUnit(event);
    // Select the nearest visible, unlocked layer centre within reach and drag it.
    let best: string | null = null;
    let bestDistance = 0.28;
    for (const layer of logo.layers) {
      if (layer.hidden || layer.locked) continue;
      const c = layerCenter(layer.content);
      const distance = Math.hypot(c.x - point.x, c.y - point.y);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = layer.id;
      }
    }
    if (best === null) return;
    onSelect(best);
    dragging.current = best;
    onMoveStart();
    svgRef.current?.setPointerCapture(event.pointerId);
  };

  const onMove = (event: ReactPointerEvent): void => {
    if (dragging.current === null) return;
    const point = pointerUnit(event);
    onMoveLive(dragging.current, point.x, point.y);
  };

  const onUp = (): void => {
    if (dragging.current === null) return;
    dragging.current = null;
    onMoveEnd();
  };

  const frame = framePath(logo.shape);
  const FrameTag = frame.tag;
  const frameFill = resolvePaint(logo.palette, logo.frameFill) ?? 'none';
  const frameStroke = resolvePaint(logo.palette, logo.frameStroke);
  const selected = logo.layers.find((l) => l.id === selectedId) ?? null;
  const box = selected ? layerBounds(selected.content) : null;

  return (
    <svg
      ref={svgRef}
      className="logo-studio__canvas"
      viewBox="0 0 100 100"
      role="img"
      aria-label="Logo canvas"
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerLeave={onUp}
    >
      <rect x={0} y={0} width={100} height={100} className="logo-studio__bed" />
      {showGuides && (
        <g className="logo-studio__guides">
          <line x1={50} y1={0} x2={50} y2={100} />
          <line x1={0} y1={50} x2={100} y2={50} />
          <line x1={33.3} y1={0} x2={33.3} y2={100} />
          <line x1={66.6} y1={0} x2={66.6} y2={100} />
          <line x1={0} y1={33.3} x2={100} y2={33.3} />
          <line x1={0} y1={66.6} x2={100} y2={66.6} />
        </g>
      )}
      <FrameTag
        {...frame.attrs}
        fill={frameFill}
        stroke={frameStroke ?? 'none'}
        strokeWidth={frameStroke !== undefined ? 5 : 0}
      />
      {logo.layers.map((layer) => (
        <g key={layer.id}>{drawLayer(layer, logo.palette)}</g>
      ))}
      {box && (
        <g className="logo-studio__selection">
          <rect x={box.x * 100} y={box.y * 100} width={box.w * 100} height={box.h * 100} />
          {[
            [box.x, box.y],
            [box.x + box.w, box.y],
            [box.x, box.y + box.h],
            [box.x + box.w, box.y + box.h],
          ].map(([hx, hy], i) => (
            <rect
              key={i}
              className="logo-studio__handle"
              x={hx! * 100 - 1.6}
              y={hy! * 100 - 1.6}
              width={3.2}
              height={3.2}
            />
          ))}
        </g>
      )}
    </svg>
  );
}

/* -------------------------------------------------------------------- page -- */

type Load =
  | { kind: 'loading' }
  | { kind: 'error' }
  | { kind: 'nope'; reason: string }
  | {
      kind: 'ready';
      own: OwnAirlineResponse & { rebrand: NonNullable<OwnAirlineResponse['rebrand']> };
    };

export function LogoStudioPage(): ReactNode {
  const navigate = useNavigate();
  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showGuides, setShowGuides] = useState(true);
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const history = useHistory<ComposedAirlineLogo>(defaultAirlineLogo('AIR'));
  const gestureBase = useRef<ComposedAirlineLogo | null>(null);
  const logo = history.present;

  useEffect(() => {
    let live = true;
    void fetchOwnAirline()
      .then((own) => {
        if (!live) return;
        if (!own.airline) {
          setLoad({ kind: 'nope', reason: 'There is no airline in the active world yet.' });
          return;
        }
        if (!own.rebrand) {
          setLoad({
            kind: 'nope',
            reason: 'This airline cannot be rebranded right now — it is not active.',
          });
          return;
        }
        const code = own.airline.iataCode;
        const existing = own.airline.logo;
        const seed = existing
          ? isComposedLogo(existing)
            ? existing
            : legacyToComposed(existing, code)
          : defaultAirlineLogo(code);
        history.reset(seed);
        setSelectedId(seed.layers[0]?.id ?? null);
        setLoad({ kind: 'ready', own: { ...own, rebrand: own.rebrand } });
      })
      .catch(() => {
        if (live) setLoad({ kind: 'error' });
      });
    return () => {
      live = false;
    };
    // history is stable; running once on mount is deliberate.
  }, []);

  const selected = logo.layers.find((l) => l.id === selectedId) ?? null;

  /* ---- layer mutation helpers (all go through history) ---- */

  const patchSelected = (
    fn: (layer: AirlineLogoLayer) => AirlineLogoLayer,
    transient = false,
  ): void => {
    if (!selected) return;
    const next: ComposedAirlineLogo = {
      ...logo,
      layers: logo.layers.map((l) => (l.id === selected.id ? fn(l) : l)),
    };
    if (transient) history.live(next);
    else history.commit(next);
  };

  const patchContent = (
    fn: (content: AirlineLogoLayerContent) => AirlineLogoLayerContent,
    transient = false,
  ): void => patchSelected((l) => ({ ...l, content: fn(l.content) }), transient);

  const startGesture = (): void => {
    gestureBase.current = logo;
  };
  const endGesture = (): void => {
    if (gestureBase.current) history.seal(gestureBase.current);
    gestureBase.current = null;
  };

  const addLayer = (type: AirlineLogoLayerType): void => {
    if (logo.layers.length >= MAX_LOGO_LAYERS) return;
    const code = load.kind === 'ready' ? (load.own.airline?.iataCode ?? 'AIR') : 'AIR';
    const layer = newLayer(type, code);
    history.commit({ ...logo, layers: [...logo.layers, layer] });
    setSelectedId(layer.id);
  };

  const removeSelected = (): void => {
    if (!selected || logo.layers.length <= 1) return;
    const remaining = logo.layers.filter((l) => l.id !== selected.id);
    history.commit({ ...logo, layers: remaining });
    setSelectedId(remaining[remaining.length - 1]?.id ?? null);
  };

  const duplicateSelected = (): void => {
    if (!selected || logo.layers.length >= MAX_LOGO_LAYERS) return;
    const copy: AirlineLogoLayer = {
      ...selected,
      id: newLayer(selected.content.type).id,
      name: `${selected.name} copy`,
      content: moveLayerContent(
        selected.content,
        clamp01(layerCenter(selected.content).x + 0.06),
        clamp01(layerCenter(selected.content).y + 0.06),
      ),
    };
    const index = logo.layers.findIndex((l) => l.id === selected.id);
    const layers = [...logo.layers];
    layers.splice(index + 1, 0, copy);
    history.commit({ ...logo, layers });
    setSelectedId(copy.id);
  };

  const reorder = (id: string, direction: -1 | 1): void => {
    const index = logo.layers.findIndex((l) => l.id === id);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= logo.layers.length) return;
    const layers = [...logo.layers];
    [layers[index], layers[target]] = [layers[target]!, layers[index]!];
    history.commit({ ...logo, layers });
  };

  const sendTo = (edge: 'front' | 'back'): void => {
    if (!selected) return;
    const rest = logo.layers.filter((l) => l.id !== selected.id);
    const layers = edge === 'front' ? [...rest, selected] : [selected, ...rest];
    history.commit({ ...logo, layers });
  };

  const setPalette = (slot: AirlineLogoPaletteSlot, color: string, transient = false): void => {
    const next = { ...logo, palette: { ...logo.palette, [slot]: color } };
    if (transient) history.live(next);
    else history.commit(next);
  };

  /* ---- render gates ---- */

  if (load.kind === 'loading') {
    return (
      <div className="logo-studio logo-studio--message">
        <p aria-live="polite">Opening the logo studio…</p>
      </div>
    );
  }
  if (load.kind === 'error') {
    return (
      <div className="logo-studio logo-studio--message">
        <p role="alert">The airline could not be read. Reload to try again.</p>
        <button type="button" onClick={() => void navigate('/airline')}>
          Back to airline
        </button>
      </div>
    );
  }
  if (load.kind === 'nope') {
    return (
      <div className="logo-studio logo-studio--message">
        <p>{load.reason}</p>
        <button type="button" onClick={() => void navigate('/airline')}>
          Back to airline
        </button>
      </div>
    );
  }

  const { own } = load;
  const cost = own.rebrand.costMinor;

  const save = async (): Promise<void> => {
    if (!own.airline) return;
    setBusy(true);
    setSaveError(null);
    try {
      const outcome = await patchOwnAirline({
        name: own.airline.name,
        callsign: own.airline.callsign,
        baseCountry: own.airline.baseCountry,
        logo,
      });
      if (!outcome.ok) {
        setSaveError(outcome.refusal.message);
        return;
      }
      await navigate('/airline');
    } catch {
      setSaveError('Tailfin could not reach the airline service. Nothing was changed; try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="logo-studio">
      <header className="logo-studio__header">
        <div className="logo-studio__title">
          <span className="logo-studio__mark" aria-hidden="true">
            ◤
          </span>
          <div>
            <h1>Brand logo editor</h1>
            <p>
              Design a unique emblem for your airline. It represents your brand across the world.
            </p>
          </div>
        </div>
        <div className="logo-studio__header-actions">
          <button type="button" onClick={history.undo} disabled={!history.canUndo}>
            ↶ Undo
          </button>
          <button type="button" onClick={history.redo} disabled={!history.canRedo}>
            ↷ Redo
          </button>
          <button
            type="button"
            className="logo-studio__close"
            aria-label="Close editor"
            onClick={() => void navigate('/airline')}
          >
            ×
          </button>
        </div>
      </header>

      <div className="logo-studio__body">
        {/* ---- left: elements ---- */}
        <aside className="logo-studio__panel logo-studio__elements" aria-label="Elements">
          <div className="logo-studio__panel-head">
            <h2>Elements</h2>
            <span className="figure">
              {logo.layers.length} / {MAX_LOGO_LAYERS}
            </span>
          </div>
          <ul className="logo-studio__layers">
            {[...logo.layers].reverse().map((layer) => (
              <li key={layer.id} className={layer.id === selectedId ? 'is-selected' : undefined}>
                <button
                  type="button"
                  className="logo-studio__layer-name"
                  onClick={() => setSelectedId(layer.id)}
                >
                  <span className="logo-studio__layer-glyph" aria-hidden="true">
                    {TYPE_GLYPH[layer.content.type]}
                  </span>
                  <span className={layer.hidden ? 'is-dim' : undefined}>{layer.name}</span>
                </button>
                <button
                  type="button"
                  className="logo-studio__layer-toggle"
                  aria-pressed={!layer.hidden}
                  aria-label={layer.hidden ? `Show ${layer.name}` : `Hide ${layer.name}`}
                  onClick={() =>
                    history.commit({
                      ...logo,
                      layers: logo.layers.map((l) =>
                        l.id === layer.id ? { ...l, hidden: !l.hidden } : l,
                      ),
                    })
                  }
                >
                  {layer.hidden ? '⦰' : '👁'}
                </button>
                <button
                  type="button"
                  className="logo-studio__layer-toggle"
                  aria-pressed={layer.locked}
                  aria-label={layer.locked ? `Unlock ${layer.name}` : `Lock ${layer.name}`}
                  onClick={() =>
                    history.commit({
                      ...logo,
                      layers: logo.layers.map((l) =>
                        l.id === layer.id ? { ...l, locked: !l.locked } : l,
                      ),
                    })
                  }
                >
                  {layer.locked ? '🔒' : '🔓'}
                </button>
              </li>
            ))}
          </ul>
          <label className="logo-studio__guides-toggle">
            <input
              type="checkbox"
              checked={showGuides}
              onChange={(e) => setShowGuides(e.target.checked)}
            />
            Guides
          </label>
        </aside>

        {/* ---- centre: shape, add, canvas ---- */}
        <main className="logo-studio__stage">
          <div className="logo-studio__toolbar">
            <div className="logo-studio__tool-group" role="group" aria-label="Frame shape">
              <span className="logo-studio__tool-label">Shape</span>
              <div className="logo-studio__segmented">
                {AIRLINE_LOGO_SHAPES.map((shape) => (
                  <button
                    key={shape}
                    type="button"
                    aria-pressed={logo.shape === shape}
                    onClick={() => history.commit({ ...logo, shape })}
                  >
                    {SHAPE_LABELS[shape]}
                  </button>
                ))}
              </div>
            </div>
            <div className="logo-studio__tool-group" role="group" aria-label="Add element">
              <span className="logo-studio__tool-label">Add element</span>
              <div className="logo-studio__add">
                {AIRLINE_LOGO_LAYER_TYPES.map((type) => (
                  <button
                    key={type}
                    type="button"
                    disabled={logo.layers.length >= MAX_LOGO_LAYERS}
                    onClick={() => addLayer(type)}
                    title={TYPE_LABELS[type]}
                  >
                    <span aria-hidden="true">{TYPE_GLYPH[type]}</span>
                    {TYPE_LABELS[type]}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="logo-studio__canvas-wrap">
            <StudioCanvas
              logo={logo}
              selectedId={selectedId}
              showGuides={showGuides}
              onSelect={setSelectedId}
              onMoveStart={startGesture}
              onMoveEnd={endGesture}
              onMoveLive={(id, nx, ny) =>
                history.live({
                  ...logo,
                  layers: logo.layers.map((l) =>
                    l.id === id ? { ...l, content: moveLayerContent(l.content, nx, ny) } : l,
                  ),
                })
              }
            />
          </div>
        </main>

        {/* ---- right: properties ---- */}
        <aside className="logo-studio__panel logo-studio__properties" aria-label="Properties">
          <div className="logo-studio__panel-head">
            <h2>Properties</h2>
          </div>
          {selected ? (
            <PropertiesPanel
              key={selected.id}
              layer={selected}
              onName={(name) => patchSelected((l) => ({ ...l, name }))}
              onPatchContent={patchContent}
              onPatchLayer={patchSelected}
              onStartGesture={startGesture}
              onEndGesture={endGesture}
              onDuplicate={duplicateSelected}
              onDelete={removeSelected}
              onSendTo={sendTo}
              onNudgeOrder={(dir) => reorder(selected.id, dir)}
              canDelete={logo.layers.length > 1}
            />
          ) : (
            <p className="logo-studio__empty">Select an element to edit it.</p>
          )}
        </aside>
      </div>

      {/* ---- bottom: palette, preview, rebrand ---- */}
      <footer className="logo-studio__footer">
        <section className="logo-studio__palette" aria-label="Brand palette">
          <h2>Brand palette</h2>
          <div className="logo-studio__swatches">
            {AIRLINE_LOGO_PALETTE_SLOTS.map((slot) => (
              <label key={slot} className="logo-studio__swatch">
                <span>{SLOT_LABELS[slot]}</span>
                <input
                  type="color"
                  aria-label={SLOT_LABELS[slot]}
                  value={logo.palette[slot]}
                  onChange={(e) => setPalette(slot, e.target.value, true)}
                  onBlur={() => history.commit(logo)}
                />
                <span className="figure logo-studio__swatch-hex">{logo.palette[slot]}</span>
              </label>
            ))}
          </div>
        </section>

        <section className="logo-studio__preview" aria-label="Live preview">
          <h2>Live preview</h2>
          <div className="logo-studio__preview-row">
            <PreviewTail logo={logo} />
            <PreviewTicket logo={logo} name={own.airline?.name ?? 'Airline'} />
            <PreviewAppIcon logo={logo} />
          </div>
        </section>

        <section className="logo-studio__commit">
          {saveError && (
            <p className="logo-studio__save-error" role="alert">
              {saveError}
            </p>
          )}
          <div className="logo-studio__cost">
            <span>Cost to rebrand</span>
            <strong className="figure">{formatMinorUnits(cost)}</strong>
          </div>
          <div className="logo-studio__commit-actions">
            <button type="button" onClick={() => void navigate('/airline')}>
              Cancel
            </button>
            <button
              type="button"
              className="logo-studio__rebrand"
              disabled={busy}
              aria-busy={busy}
              onClick={() => void save()}
            >
              {busy ? 'Recording rebrand…' : `Rebrand for ${formatMinorUnits(cost)}`}
            </button>
          </div>
        </section>
      </footer>
    </div>
  );
}

/* --------------------------------------------------------- properties panel */

function PropertiesPanel({
  layer,
  onName,
  onPatchContent,
  onPatchLayer,
  onStartGesture,
  onEndGesture,
  onDuplicate,
  onDelete,
  onSendTo,
  onNudgeOrder,
  canDelete,
}: {
  layer: AirlineLogoLayer;
  onName: (name: string) => void;
  onPatchContent: (
    fn: (c: AirlineLogoLayerContent) => AirlineLogoLayerContent,
    transient?: boolean,
  ) => void;
  onPatchLayer: (fn: (l: AirlineLogoLayer) => AirlineLogoLayer, transient?: boolean) => void;
  onStartGesture: () => void;
  onEndGesture: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onSendTo: (edge: 'front' | 'back') => void;
  onNudgeOrder: (dir: -1 | 1) => void;
  canDelete: boolean;
}): ReactNode {
  const c = layer.content;
  const centre = layerCenter(c);
  const disabled = layer.locked;

  const moveTo = (nx: number, ny: number): void =>
    onPatchContent((content) => moveLayerContent(content, nx, ny));

  const hasRotation =
    c.type === 'rect' || c.type === 'triangle' || c.type === 'text' || c.type === 'symbol';

  return (
    <div className="logo-studio__props">
      <label className="logo-studio__prop-name">
        <span>Name</span>
        <input value={layer.name} maxLength={40} onChange={(e) => onName(e.target.value)} />
      </label>

      <fieldset disabled={disabled} className="logo-studio__prop-group">
        <legend>Position</legend>
        <div className="logo-studio__prop-row">
          <Field
            label="X"
            value={centre.x * 1000}
            min={0}
            max={1000}
            onChange={(v) => moveTo(v / 1000, centre.y)}
            onCommit={onEndGesture}
          />
          <Field
            label="Y"
            value={centre.y * 1000}
            min={0}
            max={1000}
            onChange={(v) => moveTo(centre.x, v / 1000)}
            onCommit={onEndGesture}
          />
        </div>
      </fieldset>

      {c.type !== 'line' && c.type !== 'path' && (
        <fieldset disabled={disabled} className="logo-studio__prop-group">
          <legend>Size</legend>
          {c.type === 'circle' && (
            <Slider
              label="Radius"
              min={10}
              max={600}
              step={1}
              value={c.r * 1000}
              onStart={onStartGesture}
              onEnd={onEndGesture}
              onInput={(v) =>
                onPatchContent((x) => (x.type === 'circle' ? { ...x, r: v / 1000 } : x), true)
              }
            />
          )}
          {c.type === 'rect' && (
            <>
              <Slider
                label="Width"
                min={10}
                max={1000}
                step={1}
                value={c.w * 1000}
                onStart={onStartGesture}
                onEnd={onEndGesture}
                onInput={(v) =>
                  onPatchContent((x) => (x.type === 'rect' ? { ...x, w: v / 1000 } : x), true)
                }
              />
              <Slider
                label="Height"
                min={10}
                max={1000}
                step={1}
                value={c.h * 1000}
                onStart={onStartGesture}
                onEnd={onEndGesture}
                onInput={(v) =>
                  onPatchContent((x) => (x.type === 'rect' ? { ...x, h: v / 1000 } : x), true)
                }
              />
            </>
          )}
          {(c.type === 'triangle' || c.type === 'text' || c.type === 'symbol') && (
            <Slider
              label="Size"
              min={c.type === 'triangle' ? 20 : 50}
              max={1000}
              step={1}
              value={c.size * 1000}
              onStart={onStartGesture}
              onEnd={onEndGesture}
              onInput={(v) =>
                onPatchContent(
                  (x) =>
                    x.type === 'triangle' || x.type === 'text' || x.type === 'symbol'
                      ? { ...x, size: v / 1000 }
                      : x,
                  true,
                )
              }
            />
          )}
        </fieldset>
      )}

      {hasRotation && (
        <fieldset disabled={disabled} className="logo-studio__prop-group">
          <Slider
            label="Rotation"
            min={-180}
            max={180}
            step={1}
            value={'rot' in c ? c.rot : 0}
            suffix="°"
            onStart={onStartGesture}
            onEnd={onEndGesture}
            onInput={(v) => onPatchContent((x) => ('rot' in x ? { ...x, rot: v } : x), true)}
          />
        </fieldset>
      )}

      {c.type === 'text' && (
        <label className="logo-studio__prop-name">
          <span>Initials</span>
          <input
            className="figure"
            value={c.text}
            maxLength={3}
            onChange={(e) => {
              const text = e.target.value
                .toUpperCase()
                .replace(/[^A-Z0-9]/g, '')
                .slice(0, 3);
              if (text.length === 0) return;
              onPatchContent((x) => (x.type === 'text' ? { ...x, text } : x));
            }}
          />
        </label>
      )}

      {c.type === 'symbol' && (
        <label className="logo-studio__prop-name">
          <span>Symbol</span>
          <select
            value={c.symbol}
            onChange={(e) =>
              onPatchContent((x) =>
                x.type === 'symbol' ? { ...x, symbol: e.target.value as AirlineLogoSymbol } : x,
              )
            }
          >
            {AIRLINE_LOGO_SYMBOLS.map((s) => (
              <option key={s} value={s}>
                {SYMBOL_LABELS[s]}
              </option>
            ))}
          </select>
        </label>
      )}

      {c.type === 'path' && (
        <label className="logo-studio__prop-check">
          <input
            type="checkbox"
            disabled={disabled}
            checked={c.closed}
            onChange={(e) =>
              onPatchContent((x) => (x.type === 'path' ? { ...x, closed: e.target.checked } : x))
            }
          />
          Closed shape
        </label>
      )}

      <fieldset disabled={disabled} className="logo-studio__prop-group">
        <Slider
          label="Opacity"
          min={0}
          max={100}
          step={1}
          value={layer.opacity * 100}
          suffix="%"
          onStart={onStartGesture}
          onEnd={onEndGesture}
          onInput={(v) => onPatchLayer((l) => ({ ...l, opacity: v / 100 }), true)}
        />
      </fieldset>

      <fieldset disabled={disabled} className="logo-studio__prop-group">
        <legend>Fill</legend>
        <PaintPicker
          value={layer.fill}
          onChange={(fill) => onPatchLayer((l) => ({ ...l, fill }))}
        />
      </fieldset>

      <fieldset disabled={disabled} className="logo-studio__prop-group">
        <legend>Stroke</legend>
        <PaintPicker
          value={layer.stroke}
          onChange={(stroke) => onPatchLayer((l) => ({ ...l, stroke }))}
        />
        <Slider
          label="Stroke width"
          min={0}
          max={500}
          step={1}
          value={layer.strokeWidth * 1000}
          onStart={onStartGesture}
          onEnd={onEndGesture}
          onInput={(v) => onPatchLayer((l) => ({ ...l, strokeWidth: v / 1000 }), true)}
        />
      </fieldset>

      <fieldset disabled={disabled} className="logo-studio__prop-group">
        <legend>Layer order</legend>
        <div className="logo-studio__order">
          <button type="button" onClick={() => onSendTo('front')}>
            Front
          </button>
          <button type="button" onClick={() => onNudgeOrder(1)}>
            Forward
          </button>
          <button type="button" onClick={() => onNudgeOrder(-1)}>
            Backward
          </button>
          <button type="button" onClick={() => onSendTo('back')}>
            Back
          </button>
        </div>
      </fieldset>

      <div className="logo-studio__prop-actions">
        <button type="button" onClick={onDuplicate}>
          Duplicate
        </button>
        <button
          type="button"
          className="logo-studio__delete"
          onClick={onDelete}
          disabled={!canDelete}
        >
          Delete
        </button>
      </div>
    </div>
  );
}

function PaintPicker({
  value,
  onChange,
}: {
  value: AirlineLogoPaint;
  onChange: (paint: AirlineLogoPaint) => void;
}): ReactNode {
  return (
    <div className="logo-studio__paints" role="group">
      {(['none', ...AIRLINE_LOGO_PALETTE_SLOTS] as const).map((paint) => (
        <button
          key={paint}
          type="button"
          className="logo-studio__paint"
          aria-pressed={value === paint}
          onClick={() => onChange(paint)}
        >
          {paint === 'none' ? 'None' : SLOT_LABELS[paint]}
        </button>
      ))}
    </div>
  );
}

/* --------------------------------------------------------------- previews -- */

function PreviewTail({ logo }: { logo: ComposedAirlineLogo }): ReactNode {
  return (
    <figure className="logo-studio__preview-item">
      <div className="logo-studio__preview-tail">
        <AirlineLogoEmblem logo={logo} size={56} label="Logo on a tail" />
      </div>
      <figcaption>Aircraft tail</figcaption>
    </figure>
  );
}

function PreviewTicket({ logo, name }: { logo: ComposedAirlineLogo; name: string }): ReactNode {
  return (
    <figure className="logo-studio__preview-item">
      <div className="logo-studio__preview-ticket">
        <AirlineLogoEmblem logo={logo} size={28} label="Logo on a ticket" />
        <span className="logo-studio__preview-ticket-name">{name}</span>
      </div>
      <figcaption>Ticket</figcaption>
    </figure>
  );
}

function PreviewAppIcon({ logo }: { logo: ComposedAirlineLogo }): ReactNode {
  return (
    <figure className="logo-studio__preview-item">
      <div className="logo-studio__preview-appicon">
        <AirlineLogoEmblem logo={logo} size={52} label="Logo as an app icon" />
      </div>
      <figcaption>App icon</figcaption>
    </figure>
  );
}
