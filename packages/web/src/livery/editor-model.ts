import {
  LIVERY_DOCUMENT_FORMAT,
  LIVERY_DOCUMENT_FORMAT_VERSION,
  LiveryColor,
  LiveryDocument,
  LiveryDocumentV1,
  migrateLiveryDocumentV1ToV2,
  type LiveryBlendMode,
  type LiveryLayer,
  type LiveryZone,
} from '@tailfin/shared';

import defaults from './defaults.json';
import { AIRCRAFT_LIVERY_TEMPLATES } from './templates';

export const LIVERY_DRAFT_VERSION = 1 as const;
export const LIVERY_HISTORY_LIMIT = 100;
export const DEFAULT_BASE_FILL_OPACITY = 0.72;

export type BaseFillMode = 'solid' | 'linear' | 'radial' | 'split';

export interface LiveryEditorSnapshot {
  family: string;
  document: LiveryDocument;
}

export interface LiveryEditorHistory {
  past: readonly LiveryEditorSnapshot[];
  present: LiveryEditorSnapshot;
  future: readonly LiveryEditorSnapshot[];
}

export type LiveryEditorAction =
  | { type: 'undo' }
  | { type: 'redo' }
  | { type: 'family.set'; family: string }
  | {
      type: 'layer.add';
      id: string;
      name: string;
      zone: LiveryZone;
      mode: BaseFillMode;
      primary: string;
      secondary: string;
    }
  | { type: 'layer.remove'; id: string }
  | { type: 'layer.rename'; id: string; name: string }
  | { type: 'layer.visibility'; id: string; visible: boolean }
  | { type: 'layer.lock'; id: string; locked: boolean }
  | { type: 'layer.opacity'; id: string; opacity: number }
  | { type: 'layer.blend'; id: string; blendMode: LiveryBlendMode }
  | { type: 'layer.reorder'; id: string; direction: 'back' | 'front' }
  | { type: 'layer.mode'; id: string; mode: BaseFillMode }
  | { type: 'layer.primary'; id: string; color: string }
  | { type: 'layer.secondary'; id: string; color: string }
  | { type: 'layer.split'; id: string; split: number }
  | { type: 'palette.add'; color: string };

export interface DraftStorage {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
}

const DEFAULT_PALETTE = defaults.palette.map((color) => LiveryColor.parse(color));
export const DEFAULT_PRIMARY_COLOR = LiveryColor.parse(defaults.primary);
export const DEFAULT_SECONDARY_COLOR = LiveryColor.parse(defaults.secondary);

const IDENTITY_TRANSFORM = {
  translate: { x: 0, y: 0 },
  scale: { x: 1, y: 1 },
  rotationDeg: 0,
  skewDeg: { x: 0, y: 0 },
} as const;

function style(fill: string | null) {
  return {
    fill: fill === null ? null : LiveryColor.parse(fill),
    stroke: null,
    strokeWidth: 0,
    lineCap: 'round' as const,
    lineJoin: 'round' as const,
    shadow: null,
  };
}

function splitStops(primary: string, secondary: string, split = 0.5) {
  const safeSplit = Math.min(0.95, Math.max(0.05, split));
  // M6-01 requires strictly increasing gradient stops, so a mathematical hard stop with two
  // identical offsets would make the saved document invalid. One ten-thousandth of the zone is
  // visually hard at template resolution while preserving the canonical schema.
  return [
    { offset: 0, color: LiveryColor.parse(primary) },
    { offset: safeSplit, color: LiveryColor.parse(primary) },
    { offset: safeSplit + 0.0001, color: LiveryColor.parse(secondary) },
    { offset: 1, color: LiveryColor.parse(secondary) },
  ];
}

export function createBaseFillLayer(
  id: string,
  name: string,
  zone: LiveryZone,
  mode: BaseFillMode,
  primary: string,
  secondary: string,
): LiveryLayer {
  const base = {
    id,
    name,
    zone,
    visible: true,
    locked: false,
    transform: IDENTITY_TRANSFORM,
    opacity: DEFAULT_BASE_FILL_OPACITY,
    blendMode: 'normal' as const,
    mask: null,
    placement: { side: 'both', symmetry: 'repeat', anchorId: null } as const,
  };

  if (mode === 'solid') {
    return { ...base, type: 'fill', style: style(primary) };
  }

  const gradient =
    mode === 'radial'
      ? {
          kind: 'radial' as const,
          center: { x: 0.5, y: 0.5 },
          focal: { x: 0.38, y: 0.38 },
          radius: 0.72,
          stops: [
            { offset: 0, color: LiveryColor.parse(primary) },
            { offset: 1, color: LiveryColor.parse(secondary) },
          ],
        }
      : {
          kind: 'linear' as const,
          from: { x: 0, y: 0.5 },
          to: { x: 1, y: 0.5 },
          stops:
            mode === 'split'
              ? splitStops(primary, secondary)
              : [
                  { offset: 0, color: LiveryColor.parse(primary) },
                  { offset: 1, color: LiveryColor.parse(secondary) },
                ],
        };

  return { ...base, type: 'gradient', style: style(null), gradient };
}

export function baseFillMode(layer: LiveryLayer): BaseFillMode | null {
  if (layer.type === 'fill') return 'solid';
  if (layer.type !== 'gradient') return null;
  if (layer.gradient.kind === 'radial') return 'radial';
  return layer.gradient.stops.length === 4 ? 'split' : 'linear';
}

export function layerPrimaryColor(layer: LiveryLayer): string {
  if (layer.type === 'fill') return layer.style.fill ?? DEFAULT_PRIMARY_COLOR;
  if (layer.type === 'gradient') return layer.gradient.stops[0]?.color ?? DEFAULT_PRIMARY_COLOR;
  return layer.style.fill ?? DEFAULT_PRIMARY_COLOR;
}

export function layerSecondaryColor(layer: LiveryLayer): string {
  if (layer.type !== 'gradient') return DEFAULT_SECONDARY_COLOR;
  return layer.gradient.stops.at(-1)?.color ?? DEFAULT_SECONDARY_COLOR;
}

export function layerSplit(layer: LiveryLayer): number {
  if (layer.type !== 'gradient' || layer.gradient.kind !== 'linear') return 0.5;
  if (baseFillMode(layer) !== 'split') return 0.5;
  return layer.gradient.stops[1]?.offset ?? 0.5;
}

export function createDefaultLiverySnapshot(): LiveryEditorSnapshot {
  const document = LiveryDocument.parse({
    format: LIVERY_DOCUMENT_FORMAT,
    formatVersion: LIVERY_DOCUMENT_FORMAT_VERSION,
    artwork: {
      coordinateSpace: 'tailfin-aircraft-artwork',
      coordinateSpaceVersion: 1,
      viewBox: { x: 0, y: 0, width: 1, height: 1 },
      sideMode: 'mirrored',
    },
    renderMode: 'legacy_svg',
    assetBindings: [],
    familyOverrides: [],
    palette: DEFAULT_PALETTE,
    layers: [
      createBaseFillLayer(
        'base-fuselage',
        'Fuselage base',
        'fuselage',
        'solid',
        defaults.primary,
        defaults.secondary,
      ),
      createBaseFillLayer(
        'base-belly',
        'Belly',
        'belly',
        'solid',
        defaults.belly,
        defaults.secondary,
      ),
      createBaseFillLayer(
        'base-tail',
        'Tail gradient',
        'tail_fin',
        'linear',
        defaults.tail,
        defaults.secondary,
      ),
    ],
  });
  return { family: 'A320neo', document };
}

export function createEditorHistory(snapshot = createDefaultLiverySnapshot()): LiveryEditorHistory {
  return { past: [], present: snapshot, future: [] };
}

export function nextBaseLayerId(document: LiveryDocument): string {
  const ids = new Set(document.layers.map((layer) => layer.id));
  let sequence = document.layers.length + 1;
  while (ids.has(`base-${String(sequence)}`)) sequence += 1;
  return `base-${String(sequence)}`;
}

function updateLayer(
  document: LiveryDocument,
  id: string,
  update: (layer: LiveryLayer) => LiveryLayer,
  options: { allowLocked?: boolean } = {},
): LiveryDocument {
  let changed = false;
  const layers = document.layers.map((layer) => {
    if (layer.id !== id || (layer.locked && options.allowLocked !== true)) return layer;
    const next = update(layer);
    changed = next !== layer;
    return next;
  });
  return changed ? LiveryDocument.parse({ ...document, layers }) : document;
}

function recolorGradient(layer: LiveryLayer, color: string, end: 'primary' | 'secondary') {
  if (layer.type !== 'gradient') return layer;
  const parsed = LiveryColor.parse(color);
  const isSplit = baseFillMode(layer) === 'split';
  const stops = layer.gradient.stops.map((stop, index, all) => {
    const replace =
      end === 'primary'
        ? index === 0 || (isSplit && index === 1)
        : index === all.length - 1 || (isSplit && index === all.length - 2);
    return replace ? { ...stop, color: parsed } : stop;
  });
  return { ...layer, gradient: { ...layer.gradient, stops } };
}

function mutateSnapshot(
  snapshot: LiveryEditorSnapshot,
  action: Exclude<LiveryEditorAction, { type: 'undo' } | { type: 'redo' }>,
): LiveryEditorSnapshot {
  const { document } = snapshot;
  switch (action.type) {
    case 'family.set':
      return AIRCRAFT_LIVERY_TEMPLATES.some((pair) => pair.family === action.family)
        ? { ...snapshot, family: action.family }
        : snapshot;
    case 'layer.add': {
      if (document.layers.some((layer) => layer.id === action.id)) return snapshot;
      const layer = createBaseFillLayer(
        action.id,
        action.name,
        action.zone,
        action.mode,
        action.primary,
        action.secondary,
      );
      return {
        ...snapshot,
        document: LiveryDocument.parse({ ...document, layers: [...document.layers, layer] }),
      };
    }
    case 'layer.remove': {
      const target = document.layers.find((layer) => layer.id === action.id);
      if (!target || target.locked) return snapshot;
      return {
        ...snapshot,
        document: LiveryDocument.parse({
          ...document,
          layers: document.layers.filter((layer) => layer.id !== action.id),
        }),
      };
    }
    case 'layer.rename': {
      const name = action.name.trim();
      if (name.length === 0 || name.length > 80) return snapshot;
      return {
        ...snapshot,
        document: updateLayer(document, action.id, (layer) => ({ ...layer, name })),
      };
    }
    case 'layer.visibility':
      return {
        ...snapshot,
        document: updateLayer(
          document,
          action.id,
          (layer) => ({ ...layer, visible: action.visible }),
          { allowLocked: true },
        ),
      };
    case 'layer.lock':
      return {
        ...snapshot,
        document: updateLayer(
          document,
          action.id,
          (layer) => ({ ...layer, locked: action.locked }),
          { allowLocked: true },
        ),
      };
    case 'layer.opacity':
      if (!Number.isFinite(action.opacity) || action.opacity < 0 || action.opacity > 1)
        return snapshot;
      return {
        ...snapshot,
        document: updateLayer(document, action.id, (layer) => ({
          ...layer,
          opacity: action.opacity,
        })),
      };
    case 'layer.blend':
      return {
        ...snapshot,
        document: updateLayer(document, action.id, (layer) => ({
          ...layer,
          blendMode: action.blendMode,
        })),
      };
    case 'layer.reorder': {
      const index = document.layers.findIndex((layer) => layer.id === action.id);
      const target = document.layers[index];
      if (!target || target.locked) return snapshot;
      const destination = action.direction === 'front' ? index + 1 : index - 1;
      if (destination < 0 || destination >= document.layers.length) return snapshot;
      const layers = [...document.layers];
      [layers[index], layers[destination]] = [layers[destination]!, layers[index]!];
      return { ...snapshot, document: LiveryDocument.parse({ ...document, layers }) };
    }
    case 'layer.mode': {
      const current = document.layers.find((layer) => layer.id === action.id);
      if (!current || current.locked || baseFillMode(current) === null) return snapshot;
      const replacement = createBaseFillLayer(
        current.id,
        current.name,
        current.zone,
        action.mode,
        layerPrimaryColor(current),
        layerSecondaryColor(current),
      );
      return {
        ...snapshot,
        document: updateLayer(document, action.id, () => ({
          ...replacement,
          visible: current.visible,
          locked: current.locked,
          opacity: current.opacity,
          blendMode: current.blendMode,
          mask: current.mask,
          placement: current.placement,
        })),
      };
    }
    case 'layer.primary':
      return {
        ...snapshot,
        document: updateLayer(document, action.id, (layer) =>
          layer.type === 'fill'
            ? { ...layer, style: { ...layer.style, fill: LiveryColor.parse(action.color) } }
            : recolorGradient(layer, action.color, 'primary'),
        ),
      };
    case 'layer.secondary':
      return {
        ...snapshot,
        document: updateLayer(document, action.id, (layer) =>
          recolorGradient(layer, action.color, 'secondary'),
        ),
      };
    case 'layer.split':
      return {
        ...snapshot,
        document: updateLayer(document, action.id, (layer) => {
          if (
            layer.type !== 'gradient' ||
            layer.gradient.kind !== 'linear' ||
            baseFillMode(layer) !== 'split'
          ) {
            return layer;
          }
          return {
            ...layer,
            gradient: {
              ...layer.gradient,
              stops: splitStops(layerPrimaryColor(layer), layerSecondaryColor(layer), action.split),
            },
          };
        }),
      };
    case 'palette.add': {
      const color = LiveryColor.parse(action.color);
      if (document.palette.includes(color) || document.palette.length >= 16) return snapshot;
      return {
        ...snapshot,
        document: LiveryDocument.parse({ ...document, palette: [...document.palette, color] }),
      };
    }
  }
}

function sameSnapshot(left: LiveryEditorSnapshot, right: LiveryEditorSnapshot): boolean {
  return left === right || JSON.stringify(left) === JSON.stringify(right);
}

export function liveryEditorReducer(
  state: LiveryEditorHistory,
  action: LiveryEditorAction,
): LiveryEditorHistory {
  if (action.type === 'undo') {
    const previous = state.past.at(-1);
    if (!previous) return state;
    return {
      past: state.past.slice(0, -1),
      present: previous,
      future: [state.present, ...state.future],
    };
  }
  if (action.type === 'redo') {
    const next = state.future[0];
    if (!next) return state;
    return {
      past: [...state.past, state.present].slice(-LIVERY_HISTORY_LIMIT),
      present: next,
      future: state.future.slice(1),
    };
  }

  const present = mutateSnapshot(state.present, action);
  if (sameSnapshot(present, state.present)) return state;
  return {
    past: [...state.past, state.present].slice(-LIVERY_HISTORY_LIMIT),
    present,
    future: [],
  };
}

export function liveryDraftStorageKey(airlineId: string): string {
  return `tailfin:livery-draft:v${String(LIVERY_DRAFT_VERSION)}:${airlineId}`;
}

export function loadLiveryDraft(
  storage: Pick<DraftStorage, 'getItem'>,
  key: string,
): LiveryEditorSnapshot {
  const fallback = createDefaultLiverySnapshot();
  try {
    const raw = storage.getItem(key);
    if (raw === null) return fallback;
    const value: unknown = JSON.parse(raw);
    if (typeof value !== 'object' || value === null) return fallback;
    const envelope = value as Record<string, unknown>;
    if (envelope.version !== LIVERY_DRAFT_VERSION || typeof envelope.family !== 'string') {
      return fallback;
    }
    if (!AIRCRAFT_LIVERY_TEMPLATES.some((pair) => pair.family === envelope.family)) return fallback;
    const currentDocument = LiveryDocument.safeParse(envelope.document);
    if (currentDocument.success) {
      return { family: envelope.family, document: currentDocument.data };
    }
    const legacyDocument = LiveryDocumentV1.safeParse(envelope.document);
    if (!legacyDocument.success) return fallback;
    return {
      family: envelope.family,
      document: migrateLiveryDocumentV1ToV2(legacyDocument.data),
    };
  } catch {
    return fallback;
  }
}

export function saveLiveryDraft(
  storage: Pick<DraftStorage, 'setItem'>,
  key: string,
  snapshot: LiveryEditorSnapshot,
): void {
  const document = LiveryDocument.parse(snapshot.document);
  storage.setItem(
    key,
    JSON.stringify({ version: LIVERY_DRAFT_VERSION, family: snapshot.family, document }),
  );
}

export function normalizeHexColor(value: string): string | null {
  const normalized = value.trim().toUpperCase();
  if (!/^#[0-9A-F]{6}(?:[0-9A-F]{2})?$/.test(normalized)) return null;
  return normalized.length === 7 ? `${normalized}FF` : normalized;
}

export function liveryColorToRgb(color: string): readonly [number, number, number] {
  const parsed = LiveryColor.parse(color);
  return [
    Number.parseInt(parsed.slice(1, 3), 16),
    Number.parseInt(parsed.slice(3, 5), 16),
    Number.parseInt(parsed.slice(5, 7), 16),
  ];
}

export function rgbToLiveryColor(
  channelR: number,
  channelG: number,
  channelB: number,
): string | null {
  const channels = [channelR, channelG, channelB];
  if (channels.some((channel) => !Number.isInteger(channel) || channel < 0 || channel > 255)) {
    return null;
  }
  return LiveryColor.parse(
    `#${channels
      .map((channel) => channel.toString(16).padStart(2, '0'))
      .join('')
      .toUpperCase()}FF`,
  );
}
