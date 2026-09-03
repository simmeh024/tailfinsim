import { describe, expect, it } from 'vitest';

import {
  MAX_PITCH_IN,
  MIN_PITCH_IN,
  cabinReducer,
  canRedo,
  canUndo,
  createHistory,
} from './editor';
import { isSeatRow } from './types';

import type { CabinConfig, SeatRow } from './types';

/**
 * The editor's reducer and its undo/redo. Selection is not an edit, so it must
 * not enter history; every structural or value change must, and must be exactly
 * reversible. These are the guarantees Undo/Redo in the toolbar depend on.
 */

function row(id: string): SeatRow {
  return {
    kind: 'seats',
    id,
    cabinClass: 'economy',
    productId: 'eco-standard',
    seatLayout: '3-3',
    pitchIn: 31,
    isExitRow: false,
  };
}

function base(): CabinConfig {
  return { typeDesignation: 'T', version: 1, elements: [row('a'), row('b')] };
}

describe('history', () => {
  it('starts with nothing to undo or redo', () => {
    const history = createHistory(base());
    expect(canUndo(history)).toBe(false);
    expect(canRedo(history)).toBe(false);
  });

  it('does not push history for a bare selection', () => {
    let history = createHistory(base());
    history = cabinReducer(history, { type: 'select', id: 'a' });
    expect(history.present.selectedId).toBe('a');
    expect(canUndo(history)).toBe(false);
  });

  it('undoes and redoes a structural edit', () => {
    let history = createHistory(base());
    history = cabinReducer(history, { type: 'insertRow', afterId: 'a' });
    expect(history.present.config.elements).toHaveLength(3);
    const newId = history.present.selectedId;
    expect(newId).not.toBeNull();

    history = cabinReducer(history, { type: 'undo' });
    expect(history.present.config.elements).toHaveLength(2);
    expect(canRedo(history)).toBe(true);

    history = cabinReducer(history, { type: 'redo' });
    expect(history.present.config.elements).toHaveLength(3);
    expect(history.present.selectedId).toBe(newId);
  });

  it('clears the redo stack on a fresh edit', () => {
    let history = createHistory(base());
    history = cabinReducer(history, { type: 'insertRow', afterId: 'a' });
    history = cabinReducer(history, { type: 'undo' });
    expect(canRedo(history)).toBe(true);
    history = cabinReducer(history, { type: 'insertMonument', afterId: 'a', kind: 'galley' });
    expect(canRedo(history)).toBe(false);
  });
});

describe('edits', () => {
  it('inserts a monument after the anchor and selects it', () => {
    let history = createHistory(base());
    history = cabinReducer(history, { type: 'insertMonument', afterId: 'a', kind: 'lavatory' });
    const elements = history.present.config.elements;
    expect(elements[1]!.kind).toBe('lavatory');
    expect(history.present.selectedId).toBe(elements[1]!.id);
  });

  it('deletes an element and selects a neighbour', () => {
    let history = createHistory(base(), 'a');
    history = cabinReducer(history, { type: 'delete', id: 'a' });
    expect(history.present.config.elements.map((e) => e.id)).toEqual(['b']);
    expect(history.present.selectedId).toBe('b');
  });

  it('clamps seat pitch to the allowed band', () => {
    let history = createHistory(base());
    history = cabinReducer(history, { type: 'setPitch', id: 'a', pitchIn: 999 });
    const a = history.present.config.elements.find((e) => e.id === 'a')!;
    expect(isSeatRow(a) && a.pitchIn).toBe(MAX_PITCH_IN);

    history = cabinReducer(history, { type: 'setPitch', id: 'a', pitchIn: 1 });
    const a2 = history.present.config.elements.find((e) => e.id === 'a')!;
    expect(isSeatRow(a2) && a2.pitchIn).toBe(MIN_PITCH_IN);
  });

  it('picks a coherent product when the class changes', () => {
    let history = createHistory(base());
    history = cabinReducer(history, { type: 'setClass', id: 'a', cabinClass: 'business' });
    const a = history.present.config.elements.find((e) => e.id === 'a')!;
    expect(isSeatRow(a) && a.cabinClass).toBe('business');
    // The economy product must not survive onto a business row.
    expect(isSeatRow(a) && a.productId).not.toBe('eco-standard');
  });

  it('reorders with move', () => {
    let history = createHistory(base());
    history = cabinReducer(history, { type: 'move', id: 'b', dir: 'up' });
    expect(history.present.config.elements.map((e) => e.id)).toEqual(['b', 'a']);
  });

  it('ignores a move off the end', () => {
    const history = createHistory(base());
    const after = cabinReducer(history, { type: 'move', id: 'a', dir: 'up' });
    expect(after).toBe(history);
  });

  it('duplicates an element after itself with a new id', () => {
    let history = createHistory(base());
    history = cabinReducer(history, { type: 'duplicate', id: 'a' });
    const elements = history.present.config.elements;
    expect(elements).toHaveLength(3);
    expect(elements[1]!.id).not.toBe('a');
    expect(elements[0]!.id).toBe('a');
  });
});
