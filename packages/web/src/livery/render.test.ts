import { describe, expect, it } from 'vitest';

import type { LiveryDocument, LiveryMask } from '@tailfin/shared';

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

function withLayerMask(
  state: LiveryEditorHistory,
  id: string,
  mask: LiveryMask,
): LiveryEditorHistory {
  return {
    ...state,
    present: {
      ...state.present,
      document: {
        ...state.present.document,
        layers: state.present.document.layers.map((layer) =>
          layer.id === id ? { ...layer, mask } : layer,
        ),
      },
    },
  };
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

  it('clips paint to a canonical zone mask and records the binding', () => {
    const state = withLayerMask(createEditorHistory(), 'base-fuselage', {
      kind: 'zone',
      zone: 'belly',
    });
    const svg = render(state);
    const layer = svg.querySelector('[data-painted-layer="base-fuselage"]');

    expect(layer?.getAttribute('data-livery-mask')).toBe('zone:belly');
    expect(layer?.getAttribute('clip-path')).toMatch(/^url\(#paint-mask-zone-base-fuselage\)$/);
    expect(svg.querySelector('#paint-mask-zone-base-fuselage')?.childElementCount).toBeGreaterThan(
      0,
    );
  });

  it('uses a preceding paint layer for alpha and inverse-alpha masks', () => {
    let state = withLayerMask(createEditorHistory(), 'base-belly', {
      kind: 'layer',
      layerId: 'base-fuselage',
      mode: 'alpha',
    });
    state = withLayerMask(state, 'base-tail', {
      kind: 'layer',
      layerId: 'base-belly',
      mode: 'inverse_alpha',
    });
    const svg = render(state);

    expect(
      svg.querySelector('[data-painted-layer="base-belly"]')?.getAttribute('data-livery-mask'),
    ).toBe('layer:alpha:base-fuselage');
    expect(svg.querySelector('#paint-mask-layer-base-belly rect')?.getAttribute('fill')).toBe(
      'black',
    );
    expect(svg.querySelector('#paint-mask-layer-base-tail rect')?.getAttribute('fill')).toBe(
      'white',
    );
  });

  it('fails closed when a layer mask references hidden or later paint', () => {
    const state = withLayerMask(createEditorHistory(), 'base-fuselage', {
      kind: 'layer',
      layerId: 'base-tail',
      mode: 'alpha',
    });
    const svg = render(state);

    expect(svg.querySelector('[data-painted-layer="base-fuselage"]')).toBeNull();
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

/**
 * The composition is safe on its own, not because of what validated the input.
 *
 * `renderLiverySvg`'s output goes to `dangerouslySetInnerHTML`. The schema makes
 * every interpolated value harmless — colours are hex, ids are alphanumeric,
 * zones and blend modes are enums — so with a validated document these
 * assertions are indistinguishable from the ones above.
 *
 * They exist for the day the document is *not* the player's own validated draft.
 * A public airline profile (M12-02), a public airframe (HIST-13), a map sprite
 * or persisted artwork all put someone else's livery through this function, and
 * an unescaped attribute would be cross-player scripting rather than a private
 * oddity. So the hostile values here are cast past the schema deliberately: the
 * point is that the renderer refuses them, whatever the caller did.
 */
describe('renderLiverySvg escapes attribute values regardless of the schema', () => {
  const pair = AIRCRAFT_LIVERY_TEMPLATES[0];
  if (pair === undefined) throw new Error('missing test template');
  const template = pair.side;

  /** A minimal document whose fill layer carries a hostile string. */
  function documentWith(overrides: Record<string, unknown>): LiveryDocument {
    return {
      version: 2,
      palette: [],
      layers: [
        {
          id: 'base',
          type: 'fill',
          zone: 'fuselage',
          visible: true,
          opacity: 1,
          blendMode: 'normal',
          mask: null,
          style: { fill: '#0B1F3AFF' },
          ...overrides,
        },
      ],
    } as unknown as LiveryDocument;
  }

  const BREAKOUT = '"><script>alert(1)</script><g id="';

  it('does not let a hostile fill close the attribute', () => {
    const svg = renderLiverySvg(template.source, documentWith({ style: { fill: BREAKOUT } }));

    expect(svg).not.toContain('<script>');
    expect(svg).toContain('&quot;');
    // Parses as one document with no injected element, rather than markup that
    // happens to look wrong.
    expect(parse(svg).querySelector('script')).toBeNull();
  });

  it('does not let a hostile layer id escape into markup', () => {
    const svg = renderLiverySvg(template.source, documentWith({ id: BREAKOUT }));

    expect(svg).not.toContain('<script>');
    expect(parse(svg).querySelector('script')).toBeNull();
  });

  it('does not let a hostile blend mode escape the style attribute', () => {
    const svg = renderLiverySvg(template.source, documentWith({ blendMode: BREAKOUT }));

    expect(svg).not.toContain('<script>');
    expect(parse(svg).querySelector('script')).toBeNull();
  });

  it('leaves a valid document byte-identical, so the escape costs nothing', () => {
    // The escape must be the identity for everything the schema permits —
    // otherwise it is a rendering change dressed as a security fix.
    const valid = documentWith({});
    const svg = renderLiverySvg(template.source, valid);

    expect(svg).toContain('data-painted-layer="base"');
    expect(svg).toContain('fill="#0B1F3AFF"');
    expect(svg).toContain('mix-blend-mode:normal');
    expect(svg).not.toContain('&amp;');
    expect(svg).not.toContain('&quot;');
  });
});
