import { describe, expect, it } from 'vitest';

import { LiveryDocument } from '@tailfin/shared';

import {
  DEFAULT_BASE_FILL_OPACITY,
  DEFAULT_PRIMARY_COLOR,
  DEFAULT_SECONDARY_COLOR,
  createEditorHistory,
  liveryColorToRgb,
  liveryEditorReducer,
  loadLiveryDraft,
  nextBaseLayerId,
  normalizeHexColor,
  rgbToLiveryColor,
  saveLiveryDraft,
  type DraftStorage,
  type LiveryEditorAction,
  type LiveryEditorHistory,
} from './editor-model';

class MemoryStorage implements DraftStorage {
  readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

function expectUndoable(state: LiveryEditorHistory, action: LiveryEditorAction) {
  const before = state.present;
  const mutated = liveryEditorReducer(state, action);
  expect(mutated.present).not.toEqual(before);

  const undone = liveryEditorReducer(mutated, { type: 'undo' });
  expect(undone.present).toEqual(before);

  const redone = liveryEditorReducer(undone, { type: 'redo' });
  expect(redone.present).toEqual(mutated.present);
  return mutated;
}

describe('M6-03 livery editor history', () => {
  it('creates a valid, projection-independent base-fill document', () => {
    const history = createEditorHistory();
    expect(LiveryDocument.safeParse(history.present.document).success).toBe(true);
    expect(history.present.family).toBe('A320neo');
    expect(history.present.document.layers.map((layer) => layer.zone)).toEqual([
      'fuselage',
      'belly',
      'tail_fin',
    ]);
    expect(
      history.present.document.layers.every((layer) => layer.opacity === DEFAULT_BASE_FILL_OPACITY),
    ).toBe(true);
  });

  it('undoes and redoes every document mutation, including reorder', () => {
    let state = createEditorHistory();
    const tailId = 'base-tail';

    state = expectUndoable(state, {
      type: 'layer.rename',
      id: tailId,
      name: 'Signature tail',
    });
    state = expectUndoable(state, {
      type: 'layer.visibility',
      id: tailId,
      visible: false,
    });
    state = expectUndoable(state, { type: 'layer.lock', id: tailId, locked: true });
    state = expectUndoable(state, { type: 'layer.lock', id: tailId, locked: false });
    state = expectUndoable(state, { type: 'layer.opacity', id: tailId, opacity: 0.61 });
    state = expectUndoable(state, { type: 'layer.blend', id: tailId, blendMode: 'multiply' });

    const beforeReorder = state.present.document.layers.map((layer) => layer.id);
    state = expectUndoable(state, {
      type: 'layer.reorder',
      id: tailId,
      direction: 'back',
    });
    expect(state.present.document.layers.map((layer) => layer.id)).not.toEqual(beforeReorder);

    state = expectUndoable(state, { type: 'layer.mode', id: tailId, mode: 'split' });
    state = expectUndoable(state, {
      type: 'layer.primary',
      id: tailId,
      color: '#223344FF',
    });
    state = expectUndoable(state, {
      type: 'layer.secondary',
      id: tailId,
      color: '#CCDDEEFF',
    });
    state = expectUndoable(state, { type: 'layer.split', id: tailId, split: 0.37 });
    state = expectUndoable(state, { type: 'palette.add', color: '#113355FF' });
    state = expectUndoable(state, { type: 'family.set', family: 'A380' });

    const addedId = nextBaseLayerId(state.present.document);
    state = expectUndoable(state, {
      type: 'layer.add',
      id: addedId,
      name: 'Nacelle base',
      zone: 'engine_nacelles',
      mode: 'radial',
      primary: DEFAULT_PRIMARY_COLOR,
      secondary: DEFAULT_SECONDARY_COLOR,
    });
    expectUndoable(state, { type: 'layer.remove', id: addedId });
  });

  it('invalidates redo after a new mutation and caps retained history', () => {
    let state = createEditorHistory();
    for (let index = 0; index < 120; index += 1) {
      state = liveryEditorReducer(state, {
        type: 'layer.opacity',
        id: 'base-tail',
        opacity: index % 2 === 0 ? 0.4 : 0.8,
      });
    }
    expect(state.past).toHaveLength(100);

    state = liveryEditorReducer(state, { type: 'undo' });
    expect(state.future).toHaveLength(1);
    state = liveryEditorReducer(state, {
      type: 'layer.rename',
      id: 'base-tail',
      name: 'New branch',
    });
    expect(state.future).toHaveLength(0);
  });

  it('keeps 30-layer mutations below one 60fps frame on average', () => {
    let state = createEditorHistory();
    while (state.present.document.layers.length < 30) {
      const id = nextBaseLayerId(state.present.document);
      state = liveryEditorReducer(state, {
        type: 'layer.add',
        id,
        name: `Benchmark ${String(state.present.document.layers.length + 1)}`,
        zone: 'fuselage',
        mode: 'solid',
        primary: DEFAULT_PRIMARY_COLOR,
        secondary: DEFAULT_SECONDARY_COLOR,
      });
    }
    state = createEditorHistory(state.present);
    const ids = state.present.document.layers.map((layer) => layer.id);
    const mutationCount = 240;
    const startedAt = performance.now();
    for (let index = 0; index < mutationCount; index += 1) {
      state = liveryEditorReducer(state, {
        type: 'layer.opacity',
        id: ids[index % ids.length]!,
        opacity: index % 2 === 0 ? 0.45 : 0.85,
      });
    }
    const averageMilliseconds = (performance.now() - startedAt) / mutationCount;

    expect(state.present.document.layers).toHaveLength(30);
    expect(averageMilliseconds).toBeLessThan(1000 / 60);
  });
});

describe('M6-03 draft persistence and colour entry', () => {
  it('round-trips a validated airline-scoped draft and ignores corrupt storage', () => {
    const storage = new MemoryStorage();
    const snapshot = liveryEditorReducer(createEditorHistory(), {
      type: 'family.set',
      family: 'ATR 72',
    }).present;

    saveLiveryDraft(storage, 'airline-a', snapshot);
    expect(loadLiveryDraft(storage, 'airline-a')).toEqual(snapshot);

    storage.setItem('broken-json', '{');
    storage.setItem('invalid-document', JSON.stringify({ version: 1, family: 'A320neo' }));
    expect(loadLiveryDraft(storage, 'broken-json').family).toBe('A320neo');
    expect(loadLiveryDraft(storage, 'invalid-document').document.layers).toHaveLength(3);
  });

  it('canonicalizes HEX and RGB input without losing alpha', () => {
    expect(normalizeHexColor('#a1b2c3')).toBe('#A1B2C3FF');
    expect(normalizeHexColor('#A1B2C344')).toBe('#A1B2C344');
    expect(normalizeHexColor('not-a-colour')).toBeNull();
    expect(rgbToLiveryColor(17, 34, 51)).toBe('#112233FF');
    expect(rgbToLiveryColor(256, 0, 0)).toBeNull();
    expect(liveryColorToRgb('#11223388')).toEqual([17, 34, 51]);
  });
});
