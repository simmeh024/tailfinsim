import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useReducer,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { useOutletContext } from 'react-router';

import { LiveryBlendMode, LiveryZone, type LiveryLayer } from '@tailfin/shared';

import { useContextSelection } from '../shell/context-selection';
import { useBuildInfo } from '../version/BuildBadge';

import { DevelopmentAircraftPreview } from './DevelopmentAircraftPreview';
import {
  DEFAULT_PRIMARY_COLOR,
  DEFAULT_SECONDARY_COLOR,
  baseFillMode,
  createEditorHistory,
  layerPrimaryColor,
  layerSecondaryColor,
  layerSplit,
  liveryColorToRgb,
  liveryDraftStorageKey,
  liveryEditorReducer,
  loadLiveryDraft,
  nextBaseLayerId,
  normalizeHexColor,
  rgbToLiveryColor,
  saveLiveryDraft,
  type BaseFillMode,
  type DraftStorage,
  type LiveryEditorAction,
  type LiveryEditorHistory,
} from './editor-model';
import {
  fleetPreviewBlendMode,
  fleetPreviewPaint,
  fleetPreviewZoneShapes,
  liveryFamilyVisual,
} from './fleet-preview';
import { renderLiverySvg } from './render';
import { AIRCRAFT_LIVERY_TEMPLATES, aircraftLiveryTemplate } from './templates';

import type { OwnAirlineShellContext } from '../shell/AppShell';
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react';

import './livery.css';

interface EyeDropperResult {
  sRGBHex: string;
}

interface EyeDropperInstance {
  open: () => Promise<EyeDropperResult>;
}

interface EyeDropperWindow extends Window {
  EyeDropper?: new () => EyeDropperInstance;
}

type AutosaveState = 'saving' | 'saved' | 'failed';
type PreviewMode = 'fleet' | 'paint-map';

function formatZone(zone: string): string {
  return zone
    .split('_')
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(' ');
}

function modeLabel(mode: BaseFillMode): string {
  if (mode === 'linear') return 'Linear gradient';
  if (mode === 'radial') return 'Radial gradient';
  if (mode === 'split') return 'Split';
  return 'Solid';
}

const BASE_FILL_MODES: readonly BaseFillMode[] = ['solid', 'linear', 'radial', 'split'];

function browserStorage(): DraftStorage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function initiallyShowTools(): boolean {
  return (
    typeof window.matchMedia !== 'function' || !window.matchMedia('(max-width: 92rem)').matches
  );
}

function ColorEditor({
  label,
  color,
  disabled,
  paletteFull,
  onChange,
  onAddPalette,
  onNotice,
}: {
  label: string;
  color: string;
  disabled: boolean;
  paletteFull: boolean;
  onChange: (color: string) => void;
  onAddPalette: (color: string) => void;
  onNotice: (message: string) => void;
}): ReactNode {
  const [hexInput, setHexInput] = useState(color);
  const [invalidHex, setInvalidHex] = useState(false);
  const [channelR, channelG, channelB] = liveryColorToRgb(color);

  useEffect(() => {
    setHexInput(color);
    setInvalidHex(false);
  }, [color]);

  const commitHex = () => {
    const normalized = normalizeHexColor(hexInput);
    if (normalized === null) {
      setInvalidHex(true);
      return;
    }
    setInvalidHex(false);
    onChange(normalized);
  };

  const commitChannel = (index: number, value: string) => {
    const channels = [channelR, channelG, channelB];
    channels[index] = Number(value);
    const next = rgbToLiveryColor(channels[0]!, channels[1]!, channels[2]!);
    if (next !== null) onChange(next);
  };

  const pickFromScreen = async () => {
    const EyeDropper = (window as EyeDropperWindow).EyeDropper;
    if (EyeDropper === undefined) {
      onNotice('Eyedropper is not available in this browser.');
      return;
    }
    try {
      const result = await new EyeDropper().open();
      const normalized = normalizeHexColor(result.sRGBHex);
      if (normalized !== null) onChange(normalized);
    } catch {
      onNotice('Eyedropper closed without changing the colour.');
    }
  };

  return (
    <fieldset className="livery-colour" disabled={disabled}>
      <legend>{label}</legend>
      <div className="livery-colour__main">
        <input
          type="color"
          value={color.slice(0, 7)}
          onChange={(event) => {
            const normalized = normalizeHexColor(event.target.value);
            if (normalized !== null) onChange(normalized);
          }}
          aria-label={`${label} picker`}
        />
        <label>
          <span>HEX</span>
          <input
            value={hexInput}
            onChange={(event) => setHexInput(event.target.value)}
            onBlur={commitHex}
            onKeyDown={(event: ReactKeyboardEvent<HTMLInputElement>) => {
              if (event.key === 'Enter') event.currentTarget.blur();
            }}
            aria-invalid={invalidHex}
            aria-label={`${label} hex`}
            spellCheck={false}
          />
        </label>
      </div>
      <div className="livery-colour__rgb" aria-label={`${label} RGB`}>
        {[channelR, channelG, channelB].map((channel, index) => (
          <label key={index}>
            <span>{['R', 'G', 'B'][index]}</span>
            <input
              type="number"
              min="0"
              max="255"
              value={channel}
              onChange={(event) => commitChannel(index, event.target.value)}
              aria-label={`${label} ${['R', 'G', 'B'][index]}`}
            />
          </label>
        ))}
      </div>
      {invalidHex && (
        <p className="livery-colour__error" role="alert">
          Use #RRGGBB or #RRGGBBAA.
        </p>
      )}
      <div className="livery-colour__actions">
        <button type="button" onClick={() => void pickFromScreen()}>
          Eyedropper
        </button>
        <button
          type="button"
          onClick={() => onAddPalette(color)}
          disabled={disabled || paletteFull}
        >
          Add to palette
        </button>
      </div>
    </fieldset>
  );
}

function LayerName({
  layer,
  onRename,
}: {
  layer: LiveryLayer;
  onRename: (name: string) => void;
}): ReactNode {
  const [name, setName] = useState(layer.name);

  useEffect(() => setName(layer.name), [layer.name]);

  const commit = () => {
    const trimmed = name.trim();
    if (trimmed.length === 0) setName(layer.name);
    else if (trimmed !== layer.name) onRename(trimmed);
  };

  return (
    <input
      className="livery-layer__name"
      value={name}
      disabled={layer.locked}
      maxLength={80}
      onChange={(event) => setName(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') event.currentTarget.blur();
        if (event.key === 'Escape') {
          setName(layer.name);
          event.currentTarget.blur();
        }
      }}
      aria-label={`Rename ${layer.name}`}
    />
  );
}

function LayerPanel({
  layers,
  selectedLayerId,
  dispatch,
  onSelect,
}: {
  layers: readonly LiveryLayer[];
  selectedLayerId: string | null;
  dispatch: (action: LiveryEditorAction) => void;
  onSelect: (id: string) => void;
}): ReactNode {
  return (
    <section className="livery-layers" aria-label="Livery layers">
      <div className="livery-layers__summary">
        <span>Back → front</span>
        <strong className="figure">{layers.length} / 100</strong>
      </div>
      {layers.length === 0 ? (
        <p className="livery-layers__empty">Add a base fill to start the livery.</p>
      ) : (
        <ol className="livery-layers__list">
          {[...layers].reverse().map((layer) => {
            const index = layers.findIndex((candidate) => candidate.id === layer.id);
            const mode = baseFillMode(layer);
            return (
              <li
                key={layer.id}
                className="livery-layer"
                data-selected={selectedLayerId === layer.id ? 'yes' : 'no'}
                data-visible={layer.visible ? 'yes' : 'no'}
              >
                <div className="livery-layer__topline">
                  <button
                    type="button"
                    className="livery-layer__select"
                    onClick={() => onSelect(layer.id)}
                    aria-pressed={selectedLayerId === layer.id}
                    aria-label={`Select ${layer.name}`}
                  >
                    <span aria-hidden="true">{selectedLayerId === layer.id ? '◆' : '◇'}</span>
                  </button>
                  <LayerName
                    layer={layer}
                    onRename={(name) => dispatch({ type: 'layer.rename', id: layer.id, name })}
                  />
                  <button
                    type="button"
                    onClick={() =>
                      dispatch({ type: 'layer.visibility', id: layer.id, visible: !layer.visible })
                    }
                    aria-label={`${layer.visible ? 'Hide' : 'Show'} ${layer.name}`}
                    aria-pressed={layer.visible}
                  >
                    {layer.visible ? '◉' : '○'}
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      dispatch({ type: 'layer.lock', id: layer.id, locked: !layer.locked })
                    }
                    aria-label={`${layer.locked ? 'Unlock' : 'Lock'} ${layer.name}`}
                    aria-pressed={layer.locked}
                  >
                    {layer.locked ? '▣' : '□'}
                  </button>
                </div>
                <button
                  type="button"
                  className="livery-layer__zone"
                  onClick={() => onSelect(layer.id)}
                >
                  {formatZone(layer.zone)} · {mode === null ? layer.type : modeLabel(mode)}
                </button>
                <div className="livery-layer__order">
                  <button
                    type="button"
                    disabled={layer.locked || index >= layers.length - 1}
                    onClick={() =>
                      dispatch({ type: 'layer.reorder', id: layer.id, direction: 'front' })
                    }
                    aria-label={`Move ${layer.name} toward front`}
                  >
                    ↑ Front
                  </button>
                  <button
                    type="button"
                    disabled={layer.locked || index <= 0}
                    onClick={() =>
                      dispatch({ type: 'layer.reorder', id: layer.id, direction: 'back' })
                    }
                    aria-label={`Move ${layer.name} toward back`}
                  >
                    ↓ Back
                  </button>
                  <button
                    type="button"
                    disabled={layer.locked}
                    onClick={() => dispatch({ type: 'layer.remove', id: layer.id })}
                    aria-label={`Delete ${layer.name}`}
                  >
                    Delete
                  </button>
                </div>
                <label className="livery-layer__opacity">
                  <span>Opacity</span>
                  <input
                    type="range"
                    min="0"
                    max="1"
                    step="0.01"
                    value={layer.opacity}
                    disabled={layer.locked}
                    onChange={(event) =>
                      dispatch({
                        type: 'layer.opacity',
                        id: layer.id,
                        opacity: Number(event.target.value),
                      })
                    }
                    aria-label={`${layer.name} opacity`}
                  />
                  <output className="figure">{Math.round(layer.opacity * 100)}%</output>
                </label>
                <label className="livery-layer__blend">
                  <span>Blend</span>
                  <select
                    value={layer.blendMode}
                    disabled={layer.locked}
                    onChange={(event) =>
                      dispatch({
                        type: 'layer.blend',
                        id: layer.id,
                        blendMode: LiveryBlendMode.parse(event.target.value),
                      })
                    }
                    aria-label={`${layer.name} blend mode`}
                  >
                    {LiveryBlendMode.options.map((blendMode) => (
                      <option key={blendMode} value={blendMode}>
                        {blendMode}
                      </option>
                    ))}
                  </select>
                </label>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

function FleetAircraftPreview({
  family,
  layers,
}: {
  family: string;
  layers: readonly LiveryLayer[];
}): ReactNode {
  const visual = liveryFamilyVisual(family);
  const idPrefix = `livery-fleet-${useId().replaceAll(':', '')}`;
  if (visual === null) {
    return <p role="alert">No fleet render exists for this family.</p>;
  }

  const bodyLayers = layers.filter(
    (layer) =>
      layer.zone !== 'wings' && layer.zone !== 'winglets' && layer.zone !== 'engine_nacelles',
  );
  const wingLayers = layers.filter((layer) => layer.zone === 'wings' || layer.zone === 'winglets');
  const engineLayers = layers.filter((layer) => layer.zone === 'engine_nacelles');

  const renderPaintLayer = (layer: LiveryLayer): ReactNode => {
    const paint = fleetPreviewPaint(layer);
    if (!layer.visible || paint === null) return null;
    return (
      <rect
        key={layer.id}
        className="livery-fleet-preview__coat"
        data-zone={layer.zone}
        width={visual.width}
        height={visual.height}
        fill={layer.type === 'gradient' ? `url(#${idPrefix}-paint-${layer.id})` : paint}
        clipPath={`url(#${idPrefix}-zone-${layer.zone})`}
        opacity={layer.opacity}
        style={{
          mixBlendMode: fleetPreviewBlendMode(layer) as CSSProperties['mixBlendMode'],
        }}
      />
    );
  };

  return (
    <div
      className="livery-fleet-preview"
      role="img"
      aria-label={`${family} three-dimensional livery preview`}
    >
      <picture>
        <source srcSet={visual.srcSet} sizes="(max-width: 768px) 100vw, 70vw" />
        <img
          src={visual.src}
          width={visual.width}
          height={visual.height}
          alt=""
          draggable={false}
        />
      </picture>
      <svg
        className="livery-fleet-preview__paint"
        viewBox={`0 0 ${String(visual.width)} ${String(visual.height)}`}
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        <defs>
          <filter
            id={`${idPrefix}-threshold`}
            x="0"
            y="0"
            width={visual.width}
            height={visual.height}
            filterUnits="userSpaceOnUse"
            colorInterpolationFilters="sRGB"
          >
            <feColorMatrix type="luminanceToAlpha" />
            <feComponentTransfer>
              <feFuncA type="linear" slope="3" intercept="-0.45" />
            </feComponentTransfer>
          </filter>
          <mask
            className="livery-fleet-preview__mask"
            id={`${idPrefix}-aircraft`}
            x="0"
            y="0"
            width={visual.width}
            height={visual.height}
            maskUnits="userSpaceOnUse"
            maskContentUnits="userSpaceOnUse"
          >
            <image
              href={visual.src}
              width={visual.width}
              height={visual.height}
              filter={`url(#${idPrefix}-threshold)`}
            />
          </mask>
          {LiveryZone.options.map((zone) => (
            <clipPath key={zone} id={`${idPrefix}-zone-${zone}`} clipPathUnits="objectBoundingBox">
              {fleetPreviewZoneShapes(family, zone).map((shape, index) =>
                shape.kind === 'ellipse' ? (
                  <ellipse key={index} cx={shape.cx} cy={shape.cy} rx={shape.rx} ry={shape.ry} />
                ) : (
                  <polygon key={index} points={shape.points} />
                ),
              )}
            </clipPath>
          ))}
          <clipPath id={`${idPrefix}-surface-guard`} clipPathUnits="objectBoundingBox">
            {(['wings', 'winglets', 'engine_nacelles'] as const).flatMap((zone) =>
              fleetPreviewZoneShapes(family, zone).map((shape, index) =>
                shape.kind === 'ellipse' ? (
                  <ellipse
                    key={`${zone}-${String(index)}`}
                    cx={shape.cx}
                    cy={shape.cy}
                    rx={shape.rx}
                    ry={shape.ry}
                  />
                ) : (
                  <polygon key={`${zone}-${String(index)}`} points={shape.points} />
                ),
              ),
            )}
          </clipPath>
          <clipPath id={`${idPrefix}-engine-guard`} clipPathUnits="objectBoundingBox">
            {fleetPreviewZoneShapes(family, 'engine_nacelles').map((shape, index) =>
              shape.kind === 'ellipse' ? (
                <ellipse key={index} cx={shape.cx} cy={shape.cy} rx={shape.rx} ry={shape.ry} />
              ) : (
                <polygon key={index} points={shape.points} />
              ),
            )}
          </clipPath>
          {layers.map((layer) => {
            if (!layer.visible || layer.type !== 'gradient') return null;
            const gradientId = `${idPrefix}-paint-${layer.id}`;
            const stops = layer.gradient.stops.map((stop) => (
              <stop
                key={`${String(stop.offset)}-${stop.color}`}
                offset={stop.offset}
                stopColor={stop.color}
              />
            ));
            return layer.gradient.kind === 'radial' ? (
              <radialGradient
                key={layer.id}
                id={gradientId}
                cx={layer.gradient.center.x}
                cy={layer.gradient.center.y}
                fx={layer.gradient.focal.x}
                fy={layer.gradient.focal.y}
                r={layer.gradient.radius}
              >
                {stops}
              </radialGradient>
            ) : (
              <linearGradient
                key={layer.id}
                id={gradientId}
                x1={layer.gradient.from.x}
                y1={layer.gradient.from.y}
                x2={layer.gradient.to.x}
                y2={layer.gradient.to.y}
              >
                {stops}
              </linearGradient>
            );
          })}
        </defs>
        <g mask={`url(#${idPrefix}-aircraft)`}>
          {bodyLayers.map(renderPaintLayer)}
          <image
            className="livery-fleet-preview__surface-guard"
            data-surface-guard="wings"
            href={visual.src}
            width={visual.width}
            height={visual.height}
            clipPath={`url(#${idPrefix}-surface-guard)`}
          />
          {wingLayers.map(renderPaintLayer)}
          <image
            className="livery-fleet-preview__surface-guard"
            data-surface-guard="engines"
            href={visual.src}
            width={visual.width}
            height={visual.height}
            clipPath={`url(#${idPrefix}-engine-guard)`}
          />
          {engineLayers.map(renderPaintLayer)}
        </g>
      </svg>
      <span className="livery-fleet-preview__specular" aria-hidden="true" />
      <span className="livery-fleet-preview__asset-label">Fleet render · {visual.version}</span>
    </div>
  );
}

export function LiveryBuilder({
  storageKey,
  airlineName,
  storage = browserStorage(),
  developmentPreview = false,
}: {
  storageKey: string;
  airlineName: string;
  storage?: DraftStorage | null;
  developmentPreview?: boolean;
}): ReactNode {
  const [history, dispatch] = useReducer(liveryEditorReducer, undefined, (): LiveryEditorHistory =>
    createEditorHistory(storage === null ? undefined : loadLiveryDraft(storage, storageKey)),
  );
  const [selectedLayerId, setSelectedLayerId] = useState<string | null>(
    history.present.document.layers.at(-1)?.id ?? null,
  );
  const [previewMode, setPreviewMode] = useState<PreviewMode>('fleet');
  const [toolsOpen, setToolsOpen] = useState(initiallyShowTools);
  const [newZone, setNewZone] = useState<LiveryZone>('fuselage');
  const [newMode, setNewMode] = useState<BaseFillMode>('solid');
  const [autosave, setAutosave] = useState<AutosaveState>('saving');
  const [notice, setNotice] = useState('');
  const { selection, select, clear, panelBody } = useContextSelection();
  const snapshot = history.present;

  const selectedLayer =
    snapshot.document.layers.find((layer) => layer.id === selectedLayerId) ?? null;
  const selectedMode = selectedLayer === null ? null : baseFillMode(selectedLayer);
  const template = aircraftLiveryTemplate(snapshot.family, 'side');
  const renderedSvg = useMemo(() => {
    if (template === null) return null;
    return renderLiverySvg(template.source, snapshot.document);
  }, [snapshot.document, template]);

  useLayoutEffect(() => {
    if (storage === null) {
      setAutosave('failed');
      return;
    }
    try {
      saveLiveryDraft(storage, storageKey, snapshot);
      setAutosave('saved');
    } catch {
      setAutosave('failed');
    }
  }, [snapshot, storage, storageKey]);

  useEffect(() => {
    if (
      selectedLayerId !== null &&
      snapshot.document.layers.some((layer) => layer.id === selectedLayerId)
    ) {
      return;
    }
    setSelectedLayerId(snapshot.document.layers.at(-1)?.id ?? null);
  }, [selectedLayerId, snapshot.document.layers]);

  useEffect(() => {
    const handleHistoryShortcut = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey)) return;
      const key = event.key.toLowerCase();
      if (key === 'z' && event.shiftKey) {
        event.preventDefault();
        dispatch({ type: 'redo' });
      } else if (key === 'z') {
        event.preventDefault();
        dispatch({ type: 'undo' });
      } else if (key === 'y') {
        event.preventDefault();
        dispatch({ type: 'redo' });
      }
    };
    window.addEventListener('keydown', handleHistoryShortcut);
    return () => window.removeEventListener('keydown', handleHistoryShortcut);
  }, []);

  const openLayerPanel = useCallback(() => {
    select({
      kind: 'livery-draft',
      id: storageKey,
      title: 'Livery layers',
      subtitle: 'Autosaved local draft',
      body: null,
    });
  }, [select, storageKey]);

  useEffect(() => {
    openLayerPanel();
    return clear;
  }, [clear, openLayerPanel]);

  const addLayer = () => {
    const id = nextBaseLayerId(snapshot.document);
    dispatch({
      type: 'layer.add',
      id,
      name: `${formatZone(newZone)} base`,
      zone: newZone,
      mode: newMode,
      primary: DEFAULT_PRIMARY_COLOR,
      secondary: DEFAULT_SECONDARY_COLOR,
    });
    setSelectedLayerId(id);
  };

  const layerPanel = (
    <LayerPanel
      layers={snapshot.document.layers}
      selectedLayerId={selectedLayerId}
      dispatch={dispatch}
      onSelect={setSelectedLayerId}
    />
  );
  const panelIsOurs = selection?.kind === 'livery-draft' && selection.id === storageKey;

  return (
    <section className="livery-builder" aria-label="Livery builder">
      <header className="livery-builder__header">
        <div className="livery-builder__identity">
          <span className="livery-builder__eyebrow">Design studio</span>
          <h1>{airlineName}</h1>
        </div>
        <label className="livery-builder__family">
          <span>Aircraft family</span>
          <select
            value={snapshot.family}
            onChange={(event) => dispatch({ type: 'family.set', family: event.target.value })}
          >
            {AIRCRAFT_LIVERY_TEMPLATES.map((pair) => (
              <option key={pair.family} value={pair.family}>
                {pair.family}
              </option>
            ))}
          </select>
        </label>
        <div className="livery-builder__preview-switch" aria-label="Aircraft preview mode">
          <button
            type="button"
            aria-pressed={previewMode === 'fleet'}
            onClick={() => setPreviewMode('fleet')}
          >
            3D preview
          </button>
          <button
            type="button"
            aria-pressed={previewMode === 'paint-map'}
            onClick={() => setPreviewMode('paint-map')}
          >
            Paint map
          </button>
        </div>
        <div className="livery-builder__history" aria-label="Edit history">
          <button
            type="button"
            onClick={() => dispatch({ type: 'undo' })}
            disabled={history.past.length === 0}
            aria-label="Undo"
          >
            ↶ Undo
          </button>
          <button
            type="button"
            onClick={() => dispatch({ type: 'redo' })}
            disabled={history.future.length === 0}
            aria-label="Redo"
          >
            ↷ Redo
          </button>
        </div>
        <button type="button" className="livery-builder__layers" onClick={openLayerPanel}>
          Layers <span className="figure">{snapshot.document.layers.length}</span>
        </button>
        <p className="livery-builder__autosave" data-state={autosave} aria-live="polite">
          {autosave === 'saved'
            ? 'Saved locally'
            : autosave === 'failed'
              ? 'Autosave unavailable'
              : 'Saving…'}
        </p>
      </header>

      <div className="livery-builder__workspace" data-tools={toolsOpen ? 'open' : 'closed'}>
        <aside className="livery-tools" aria-label="Base fill tools">
          <button
            type="button"
            className="livery-tools__toggle"
            onClick={() => setToolsOpen((open) => !open)}
            aria-expanded={toolsOpen}
          >
            <span aria-hidden="true">{toolsOpen ? '‹' : '›'}</span>
            <span>{toolsOpen ? 'Hide tools' : 'Show tools'}</span>
          </button>
          {toolsOpen && (
            <div className="livery-tools__body">
              <section className="livery-tool-section">
                <div className="livery-tool-section__heading">
                  <h2>Add base fill</h2>
                  <span>Zone paint</span>
                </div>
                <label>
                  <span>Zone</span>
                  <select
                    value={newZone}
                    onChange={(event) => setNewZone(LiveryZone.parse(event.target.value))}
                  >
                    {LiveryZone.options.map((zone) => (
                      <option key={zone} value={zone}>
                        {formatZone(zone)}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>Fill</span>
                  <select
                    value={newMode}
                    onChange={(event) => setNewMode(event.target.value as BaseFillMode)}
                  >
                    {BASE_FILL_MODES.map((mode) => (
                      <option key={mode} value={mode}>
                        {modeLabel(mode)}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  type="button"
                  className="livery-tools__add"
                  onClick={addLayer}
                  disabled={snapshot.document.layers.length >= 100}
                >
                  + Add fill layer
                </button>
              </section>

              <section className="livery-tool-section">
                <div className="livery-tool-section__heading">
                  <h2>Selected fill</h2>
                  <span>{selectedLayer?.name ?? 'None'}</span>
                </div>
                {selectedLayer === null || selectedMode === null ? (
                  <p className="livery-tools__empty">Select a base-fill layer from Layers.</p>
                ) : (
                  <>
                    <label>
                      <span>Mode</span>
                      <select
                        value={selectedMode}
                        disabled={selectedLayer.locked}
                        onChange={(event) =>
                          dispatch({
                            type: 'layer.mode',
                            id: selectedLayer.id,
                            mode: event.target.value as BaseFillMode,
                          })
                        }
                        aria-label="Selected fill mode"
                      >
                        {BASE_FILL_MODES.map((mode) => (
                          <option key={mode} value={mode}>
                            {modeLabel(mode)}
                          </option>
                        ))}
                      </select>
                    </label>
                    <ColorEditor
                      label="Primary colour"
                      color={layerPrimaryColor(selectedLayer)}
                      disabled={selectedLayer.locked}
                      paletteFull={snapshot.document.palette.length >= 16}
                      onChange={(color) =>
                        dispatch({ type: 'layer.primary', id: selectedLayer.id, color })
                      }
                      onAddPalette={(color) => dispatch({ type: 'palette.add', color })}
                      onNotice={setNotice}
                    />
                    {selectedMode !== 'solid' && (
                      <ColorEditor
                        label="Secondary colour"
                        color={layerSecondaryColor(selectedLayer)}
                        disabled={selectedLayer.locked}
                        paletteFull={snapshot.document.palette.length >= 16}
                        onChange={(color) =>
                          dispatch({ type: 'layer.secondary', id: selectedLayer.id, color })
                        }
                        onAddPalette={(color) => dispatch({ type: 'palette.add', color })}
                        onNotice={setNotice}
                      />
                    )}
                    {selectedMode === 'split' && (
                      <label className="livery-tools__split">
                        <span>Split position</span>
                        <input
                          type="range"
                          min="0.05"
                          max="0.95"
                          step="0.01"
                          value={layerSplit(selectedLayer)}
                          disabled={selectedLayer.locked}
                          onChange={(event) =>
                            dispatch({
                              type: 'layer.split',
                              id: selectedLayer.id,
                              split: Number(event.target.value),
                            })
                          }
                        />
                        <output className="figure">
                          {Math.round(layerSplit(selectedLayer) * 100)}%
                        </output>
                      </label>
                    )}
                  </>
                )}
              </section>

              <section className="livery-tool-section">
                <div className="livery-tool-section__heading">
                  <h2>Brand palette</h2>
                  <span>{snapshot.document.palette.length} / 16</span>
                </div>
                <div className="livery-palette" aria-label="Saved brand palette">
                  {snapshot.document.palette.map((color) => (
                    <button
                      key={color}
                      type="button"
                      style={{ '--livery-swatch': color.slice(0, 7) } as CSSProperties}
                      onClick={() => {
                        if (selectedLayer !== null) {
                          dispatch({ type: 'layer.primary', id: selectedLayer.id, color });
                        }
                      }}
                      disabled={selectedLayer === null || selectedLayer.locked}
                      aria-label={`Use ${color}`}
                      title={color}
                    />
                  ))}
                </div>
                <p className="livery-tools__notice" aria-live="polite">
                  {notice}
                </p>
              </section>

              <p className="livery-tools__boundary">
                M6-03 is base paint. Text, logos and vector shapes arrive in the next tools.
              </p>
            </div>
          )}
        </aside>

        <div className="livery-canvas" data-family={snapshot.family} data-view={previewMode}>
          <div className="livery-canvas__measure">
            <span>{snapshot.family}</span>
            <span className="figure">
              {previewMode === 'fleet'
                ? developmentPreview && snapshot.family === 'A320neo'
                  ? 'True 3D dev review'
                  : 'Material preview'
                : '1200 × 400 paint map'}
            </span>
          </div>
          {previewMode === 'fleet' ? (
            developmentPreview && snapshot.family === 'A320neo' ? (
              <DevelopmentAircraftPreview
                layers={snapshot.document.layers}
                source="quarantine-recovery"
                fallback={
                  <FleetAircraftPreview
                    family={snapshot.family}
                    layers={snapshot.document.layers}
                  />
                }
              />
            ) : (
              <FleetAircraftPreview family={snapshot.family} layers={snapshot.document.layers} />
            )
          ) : renderedSvg === null ? (
            <p role="alert">No side-profile paint map exists for this family.</p>
          ) : (
            <div
              className="livery-canvas__aircraft"
              aria-label={`${snapshot.family} livery preview`}
              dangerouslySetInnerHTML={{ __html: renderedSvg }}
            />
          )}
          <p className="livery-canvas__caption">
            {previewMode === 'fleet'
              ? developmentPreview && snapshot.family === 'A320neo'
                ? 'Recovered source PBR · quarantine review only · no fleet binding or livery paint application'
                : 'Fleet render · illustrative material preview · paint map remains canonical'
              : 'Exact zone clipping · canonical side-profile authoring'}
          </p>
        </div>

        {(!panelIsOurs || panelBody === null) && (
          <aside className="livery-layers-inline">{layerPanel}</aside>
        )}
      </div>

      {panelIsOurs && panelBody !== null && createPortal(layerPanel, panelBody)}
    </section>
  );
}

export function LiveryBuilderPage(): ReactNode {
  const { ownAirline, ownAirlineLoading, ownAirlineError, reloadOwnAirline } =
    useOutletContext<OwnAirlineShellContext>();
  const build = useBuildInfo();

  if (ownAirlineLoading) {
    return (
      <section className="livery-builder-gate" aria-live="polite">
        <h1>Opening design studio</h1>
        <p>Loading your airline identity…</p>
      </section>
    );
  }
  if (ownAirlineError) {
    return (
      <section className="livery-builder-gate" role="alert">
        <h1>Design studio unavailable</h1>
        <p>Tailfin could not load the airline that owns this draft.</p>
        <button type="button" onClick={() => void reloadOwnAirline()}>
          Try again
        </button>
      </section>
    );
  }
  if (ownAirline?.airline === null || ownAirline === null) {
    return (
      <section className="livery-builder-gate">
        <h1>Found an airline first</h1>
        <p>A livery draft belongs to an airline identity, not a player account by itself.</p>
      </section>
    );
  }

  return (
    <LiveryBuilder
      storageKey={liveryDraftStorageKey(ownAirline.airline.id)}
      airlineName={ownAirline.airline.name}
      developmentPreview={build?.environment === 'dev'}
    />
  );
}
