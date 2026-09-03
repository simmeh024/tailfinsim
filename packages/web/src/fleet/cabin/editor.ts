/**
 * The cabin editor's state and history (M6-08).
 *
 * A single reducer owns the config, the current selection, and undo/redo — the
 * same past/present/future shape the livery editor uses, so Undo and Redo in the
 * toolbar are the reducer's `undo`/`redo` and nothing else. Selection is part of
 * the snapshot but a bare `select` does **not** push history: choosing a row is
 * not an edit, and burying real edits under a pile of selections would make Undo
 * useless. Structural and value edits do push, and they carry the new selection
 * so the inspector follows the row that was just added or changed.
 */

import { productsForClass, seatProduct } from './catalogue';
import { isSeatRow } from './types';

import type { CabinClass, CabinConfig, MonumentKind, SeatRow } from './types';

export interface CabinSnapshot {
  config: CabinConfig;
  selectedId: string | null;
}

export interface CabinHistory {
  past: readonly CabinSnapshot[];
  present: CabinSnapshot;
  future: readonly CabinSnapshot[];
}

export type CabinAction =
  | { type: 'undo' }
  | { type: 'redo' }
  | { type: 'reset'; config: CabinConfig }
  | { type: 'select'; id: string | null }
  | { type: 'insertRow'; afterId: string | null }
  | { type: 'insertMonument'; afterId: string | null; kind: MonumentKind }
  | { type: 'duplicate'; id: string }
  | { type: 'delete'; id: string }
  | { type: 'move'; id: string; dir: 'up' | 'down' }
  | { type: 'setClass'; id: string; cabinClass: CabinClass }
  | { type: 'setProduct'; id: string; productId: string }
  | { type: 'setLayout'; id: string; layout: string }
  | { type: 'setPitch'; id: string; pitchIn: number }
  | { type: 'toggleExit'; id: string };

const HISTORY_LIMIT = 60;
export const MIN_PITCH_IN = 20;
export const MAX_PITCH_IN = 130;

let idCounter = 0;
/** A fresh element id that cannot collide with a preset's `<type>-rN` ids. */
function nextId(): string {
  idCounter += 1;
  return `new-${String(idCounter)}`;
}

export function createHistory(config: CabinConfig, selectedId: string | null = null): CabinHistory {
  return { past: [], present: { config, selectedId }, future: [] };
}

function withElements(config: CabinConfig, elements: CabinConfig['elements']): CabinConfig {
  return { ...config, elements };
}

/** A coherent row for a class: its first product, that product's first layout. */
function rowForClass(cabinClass: CabinClass): SeatRow {
  const product = productsForClass(cabinClass)[0];
  return {
    kind: 'seats',
    id: nextId(),
    cabinClass,
    productId: product?.id ?? 'eco-standard',
    seatLayout: product?.layouts[0] ?? '3-3',
    pitchIn: product?.pitchIn ?? 31,
    isExitRow: false,
  };
}

function indexOf(config: CabinConfig, id: string | null): number {
  if (id === null) return -1;
  return config.elements.findIndex((element) => element.id === id);
}

/** Apply one structural/value edit, returning the new snapshot (or null = no-op). */
function edit(present: CabinSnapshot, action: CabinAction): CabinSnapshot | null {
  const { config } = present;
  const elements = config.elements;

  switch (action.type) {
    case 'insertRow': {
      const at = indexOf(config, action.afterId);
      const anchor = at >= 0 ? elements[at] : undefined;
      const clone: SeatRow =
        anchor !== undefined && isSeatRow(anchor)
          ? { ...anchor, id: nextId(), isExitRow: false }
          : rowForClass('economy');
      const insertAt = at >= 0 ? at + 1 : elements.length;
      const next = [...elements.slice(0, insertAt), clone, ...elements.slice(insertAt)];
      return { config: withElements(config, next), selectedId: clone.id };
    }
    case 'insertMonument': {
      const at = indexOf(config, action.afterId);
      const monument = { kind: action.kind, id: nextId() };
      const insertAt = at >= 0 ? at + 1 : elements.length;
      const next = [...elements.slice(0, insertAt), monument, ...elements.slice(insertAt)];
      return { config: withElements(config, next), selectedId: monument.id };
    }
    case 'duplicate': {
      const at = indexOf(config, action.id);
      if (at < 0) return null;
      const source = elements[at]!;
      const clone = { ...source, id: nextId() };
      const next = [...elements.slice(0, at + 1), clone, ...elements.slice(at + 1)];
      return { config: withElements(config, next), selectedId: clone.id };
    }
    case 'delete': {
      const at = indexOf(config, action.id);
      if (at < 0) return null;
      const next = elements.filter((element) => element.id !== action.id);
      const neighbour = next[at] ?? next[at - 1] ?? null;
      return { config: withElements(config, next), selectedId: neighbour?.id ?? null };
    }
    case 'move': {
      const at = indexOf(config, action.id);
      if (at < 0) return null;
      const swap = action.dir === 'up' ? at - 1 : at + 1;
      if (swap < 0 || swap >= elements.length) return null;
      const next = [...elements];
      [next[at], next[swap]] = [next[swap]!, next[at]!];
      return { config: withElements(config, next), selectedId: action.id };
    }
    case 'setClass': {
      const at = indexOf(config, action.id);
      const source = at >= 0 ? elements[at] : undefined;
      if (source === undefined || !isSeatRow(source)) return null;
      const fresh = rowForClass(action.cabinClass);
      const updated: SeatRow = { ...fresh, id: source.id, isExitRow: source.isExitRow };
      const next = elements.map((element) => (element.id === action.id ? updated : element));
      return { config: withElements(config, next), selectedId: action.id };
    }
    case 'setProduct': {
      const at = indexOf(config, action.id);
      const source = at >= 0 ? elements[at] : undefined;
      if (source === undefined || !isSeatRow(source)) return null;
      const product = seatProduct(action.productId);
      const layout = product?.layouts.includes(source.seatLayout)
        ? source.seatLayout
        : (product?.layouts[0] ?? source.seatLayout);
      const updated: SeatRow = { ...source, productId: action.productId, seatLayout: layout };
      const next = elements.map((element) => (element.id === action.id ? updated : element));
      return { config: withElements(config, next), selectedId: action.id };
    }
    case 'setLayout': {
      const at = indexOf(config, action.id);
      const source = at >= 0 ? elements[at] : undefined;
      if (source === undefined || !isSeatRow(source)) return null;
      const updated: SeatRow = { ...source, seatLayout: action.layout };
      const next = elements.map((element) => (element.id === action.id ? updated : element));
      return { config: withElements(config, next), selectedId: action.id };
    }
    case 'setPitch': {
      const at = indexOf(config, action.id);
      const source = at >= 0 ? elements[at] : undefined;
      if (source === undefined || !isSeatRow(source)) return null;
      const pitchIn = Math.max(MIN_PITCH_IN, Math.min(MAX_PITCH_IN, Math.round(action.pitchIn)));
      const updated: SeatRow = { ...source, pitchIn };
      const next = elements.map((element) => (element.id === action.id ? updated : element));
      return { config: withElements(config, next), selectedId: action.id };
    }
    case 'toggleExit': {
      const at = indexOf(config, action.id);
      const source = at >= 0 ? elements[at] : undefined;
      if (source === undefined || !isSeatRow(source)) return null;
      const updated: SeatRow = { ...source, isExitRow: !source.isExitRow };
      const next = elements.map((element) => (element.id === action.id ? updated : element));
      return { config: withElements(config, next), selectedId: action.id };
    }
    default:
      return null;
  }
}

export function cabinReducer(state: CabinHistory, action: CabinAction): CabinHistory {
  if (action.type === 'undo') {
    const previous = state.past.at(-1);
    if (previous === undefined) return state;
    return {
      past: state.past.slice(0, -1),
      present: previous,
      future: [state.present, ...state.future],
    };
  }
  if (action.type === 'redo') {
    const next = state.future[0];
    if (next === undefined) return state;
    return {
      past: [...state.past, state.present].slice(-HISTORY_LIMIT),
      present: next,
      future: state.future.slice(1),
    };
  }
  if (action.type === 'reset') {
    return createHistory(action.config, null);
  }
  if (action.type === 'select') {
    // Not an edit — replace the selection in place, keep the redo stack.
    if (state.present.selectedId === action.id) return state;
    return { ...state, present: { ...state.present, selectedId: action.id } };
  }

  const nextPresent = edit(state.present, action);
  if (nextPresent === null) return state;
  return {
    past: [...state.past, state.present].slice(-HISTORY_LIMIT),
    present: nextPresent,
    future: [],
  };
}

export function canUndo(state: CabinHistory): boolean {
  return state.past.length > 0;
}

export function canRedo(state: CabinHistory): boolean {
  return state.future.length > 0;
}
