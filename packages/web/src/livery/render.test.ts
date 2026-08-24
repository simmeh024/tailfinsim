import { describe, expect, it } from 'vitest';

import {
  DEFAULT_PRIMARY_COLOR,
  DEFAULT_SECONDARY_COLOR,
  createEditorHistory,
  liveryEditorReducer,
  nextBaseLayerId,
  type LiveryEditorHistory,
} from './editor-model';
import { renderLiverySvg } from './render';
import { AIRCRAFT_LIVERY_TEMPLATES, aircraftLiveryTemplate } from './templates';

function parse(source: string): SVGSVGElement {
  const document = new DOMParser().parseFromString(source, 'image/svg+xml');
  expect(document.querySelector('parsererror')).toBeNull();
  return document.documentElement as unknown as SVGSVGElement;
}

function render(state: LiveryEditorHistory) {
  const template = aircraftLiveryTemplate(state.present.family, 'side');
  if (template === null) throw new Error('missing test template');
  return parse(renderLiverySvg(template.source, state.present.document));
}

describe('M6-03 side-profile livery renderer', () => {
  it('paints base-fill layers in document order with opacity and blend mode', () => {
    let state = createEditorHistory();
    state = liveryEditorReducer(state, {
      type: 'layer.opacity',
      id: 'base-tail',
      opacity: 0.54,
    });
    state = liveryEditorReducer(state, {
      type: 'layer.blend',
      id: 'base-tail',
      blendMode: 'multiply',
    });
    const svg = render(state);
    const painted = [...svg.querySelectorAll('[data-painted-layer]')];

    expect(painted.map((layer) => layer.getAttribute('data-painted-layer'))).toEqual(
      state.present.document.layers.map((layer) => layer.id),
    );
    expect(svg.getAttribute('data-rendered-layers')).toBe('3');
    expect(svg.querySelector('[data-painted-layer="base-tail"]')?.getAttribute('opacity')).toBe(
      '0.54',
    );
    expect(svg.querySelector('[data-painted-layer="base-tail"]')?.getAttribute('style')).toContain(
      'multiply',
    );
  });

  it('renders solid, linear, radial and split fills from the canonical layer schema', () => {
    let state = createEditorHistory();
    state = liveryEditorReducer(state, {
      type: 'layer.mode',
      id: 'base-fuselage',
      mode: 'radial',
    });
    state = liveryEditorReducer(state, {
      type: 'layer.mode',
      id: 'base-tail',
      mode: 'split',
    });
    const svg = render(state);

    expect(svg.querySelectorAll('radialGradient')).toHaveLength(1);
    expect(svg.querySelectorAll('linearGradient')).toHaveLength(1);
    expect(svg.querySelector('linearGradient')?.querySelectorAll('stop')).toHaveLength(4);
    expect(svg.querySelector('[data-painted-layer="base-belly"]')?.getAttribute('fill')).toMatch(
      /^#[0-9A-F]{8}$/,
    );
  });

  it('omits hidden paint while retaining the neutral template geometry', () => {
    const state = liveryEditorReducer(createEditorHistory(), {
      type: 'layer.visibility',
      id: 'base-belly',
      visible: false,
    });
    const svg = render(state);

    expect(svg.querySelector('[data-painted-layer="base-belly"]')).toBeNull();
    expect(svg.querySelector('[data-livery-zone="belly"]')).not.toBeNull();
    expect(svg.getAttribute('data-rendered-layers')).toBe('2');
  });

  it('projects the same document over every launch-family side template', () => {
    const document = createEditorHistory().present.document;
    for (const pair of AIRCRAFT_LIVERY_TEMPLATES) {
      const svg = parse(renderLiverySvg(pair.side.source, document));
      expect(svg.getAttribute('data-aircraft-family')).toBe(pair.family);
      expect(svg.querySelectorAll('[data-painted-layer]')).toHaveLength(document.layers.length);
    }
  });

  it('renders a 30-layer side profile within one 60fps frame on average', () => {
    let state = createEditorHistory();
    while (state.present.document.layers.length < 30) {
      const id = nextBaseLayerId(state.present.document);
      state = liveryEditorReducer(state, {
        type: 'layer.add',
        id,
        name: `Paint ${String(state.present.document.layers.length + 1)}`,
        zone: state.present.document.layers.length % 2 === 0 ? 'fuselage' : 'wings',
        mode: state.present.document.layers.length % 3 === 0 ? 'radial' : 'solid',
        primary: DEFAULT_PRIMARY_COLOR,
        secondary: DEFAULT_SECONDARY_COLOR,
      });
    }
    const template = aircraftLiveryTemplate('A320neo', 'side');
    if (template === null) throw new Error('missing benchmark template');
    const sampleCount = 30;
    const startedAt = performance.now();
    for (let index = 0; index < sampleCount; index += 1) {
      renderLiverySvg(template.source, state.present.document);
    }
    const averageMilliseconds = (performance.now() - startedAt) / sampleCount;

    expect(averageMilliseconds).toBeLessThan(1000 / 60);
  });
});
