import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  AIRCRAFT_CATALOGUE_V1,
  LIVERY_DOCUMENT_FORMAT,
  LIVERY_DOCUMENT_FORMAT_VERSION,
  LiveryDocument,
  LiveryZone,
} from '@tailfin/shared';

import {
  AIRCRAFT_LIVERY_TEMPLATES,
  LIVERY_TEMPLATE_HEIGHT,
  LIVERY_TEMPLATE_VERSION,
  LIVERY_TEMPLATE_WIDTH,
  aircraftLiveryTemplate,
  type AircraftLiveryTemplatePair,
  type LiveryTemplateProjection,
} from './templates';

const TEMPLATE_DIRECTORY = resolve(process.cwd(), 'packages/shared/assets/livery/templates/v1');
const PROJECTIONS: readonly LiveryTemplateProjection[] = ['side', 'top'];
const EXPECTED_ZONES = [...LiveryZone.options].sort();

function sourcePath(pair: AircraftLiveryTemplatePair, projection: LiveryTemplateProjection) {
  return join(TEMPLATE_DIRECTORY, `${pair.slug}-${projection}.svg`);
}

function parseSvg(source: string): SVGSVGElement {
  const document = new DOMParser().parseFromString(source, 'image/svg+xml');
  expect(document.querySelector('parsererror')).toBeNull();
  return document.documentElement as unknown as SVGSVGElement;
}

function zoneViewBox(zone: Element): readonly [number, number, number, number] {
  const values = (zone.getAttribute('data-zone-viewbox') ?? '').split(/\s+/).map(Number);
  expect(values).toHaveLength(4);
  expect(values.every(Number.isFinite)).toBe(true);
  const [x, y, width, height] = values;
  expect(width).toBeGreaterThan(0);
  expect(height).toBeGreaterThan(0);
  if (x === undefined || y === undefined || width === undefined || height === undefined) {
    throw new Error('invalid zone viewBox fixture');
  }
  return [x, y, width, height];
}

describe('M6-02 aircraft livery templates', () => {
  it('covers every unique launch-catalogue family with side and top assets', async () => {
    const catalogueFamilies = [...new Set(AIRCRAFT_CATALOGUE_V1.types.map((type) => type.family))];
    expect(AIRCRAFT_LIVERY_TEMPLATES.map((pair) => pair.family)).toEqual(catalogueFamilies);

    const files = (await readdir(TEMPLATE_DIRECTORY)).filter((file) => file.endsWith('.svg'));
    const expectedFiles = AIRCRAFT_LIVERY_TEMPLATES.flatMap((pair) =>
      PROJECTIONS.map((projection) => `${pair.slug}-${projection}.svg`),
    );
    expect(files.sort()).toEqual(expectedFiles.sort());
    expect(files).toHaveLength(catalogueFamilies.length * PROJECTIONS.length);
  });

  it('keeps every source a safe plain SVG with complete self-describing metadata', async () => {
    for (const pair of AIRCRAFT_LIVERY_TEMPLATES) {
      for (const projection of PROJECTIONS) {
        const source = await readFile(sourcePath(pair, projection), 'utf8');
        const svg = parseSvg(source);

        expect(svg.tagName.toLowerCase()).toBe('svg');
        expect(svg.getAttribute('viewBox')).toBe(
          `0 0 ${String(LIVERY_TEMPLATE_WIDTH)} ${String(LIVERY_TEMPLATE_HEIGHT)}`,
        );
        expect(svg.getAttribute('data-template-version')).toBe(LIVERY_TEMPLATE_VERSION);
        expect(svg.getAttribute('data-aircraft-family')).toBe(pair.family);
        expect(svg.getAttribute('data-projection')).toBe(projection);
        expect(svg.querySelector('title')?.textContent).toContain(pair.family);
        expect(svg.querySelector('desc')?.textContent).toMatch(/livery zones/i);

        expect(svg.querySelector('script, image, foreignObject, style')).toBeNull();
        expect(svg.querySelector('[href^="http:"], [href^="https:"]')).toBeNull();
        expect(source).not.toMatch(/\bon[a-z]+\s*=|javascript:/i);

        const ids = [...svg.querySelectorAll('[id]')].map((element) => element.id);
        expect(new Set(ids).size).toBe(ids.length);
      }
    }
  });

  it('uses the exact M6-01 zones and normalized coordinate map in every family and projection', async () => {
    for (const pair of AIRCRAFT_LIVERY_TEMPLATES) {
      for (const projection of PROJECTIONS) {
        const svg = parseSvg(await readFile(sourcePath(pair, projection), 'utf8'));
        const zones = [...svg.querySelectorAll('[data-livery-zone]')];
        expect(
          zones.map((zone) => zone.getAttribute('data-livery-zone')).sort(),
          `${pair.family} ${projection}`,
        ).toEqual(EXPECTED_ZONES);

        for (const zone of zones) {
          const name = zone.getAttribute('data-livery-zone');
          expect(zone.id).toBe(`zone-${name}`);
          expect(zone.childElementCount).toBeGreaterThan(0);
          const [x, y, width, height] = zoneViewBox(zone);

          // The two corners a renderer gets from normalized (0,0) and (1,1).
          expect([x, y, x + width, y + height].every(Number.isFinite)).toBe(true);
        }
      }
    }
  });

  it('lets one valid livery document address every zone in both projections', async () => {
    const livery = LiveryDocument.parse({
      format: LIVERY_DOCUMENT_FORMAT,
      formatVersion: LIVERY_DOCUMENT_FORMAT_VERSION,
      palette: ['#10233FFF'],
      layers: LiveryZone.options.map((zone, index) => ({
        id: `zone-paint-${String(index)}`,
        name: `Paint ${zone}`,
        type: 'fill',
        zone,
        visible: true,
        locked: false,
        transform: {
          translate: { x: 0, y: 0 },
          scale: { x: 1, y: 1 },
          rotationDeg: 0,
          skewDeg: { x: 0, y: 0 },
        },
        style: {
          fill: '#10233FFF',
          stroke: null,
          strokeWidth: 0,
          lineCap: 'round',
          lineJoin: 'round',
          shadow: null,
        },
        opacity: 1,
        blendMode: 'normal',
        mask: null,
      })),
    });

    for (const pair of AIRCRAFT_LIVERY_TEMPLATES) {
      const geometryByProjection: string[] = [];
      for (const projection of PROJECTIONS) {
        const svg = parseSvg(await readFile(sourcePath(pair, projection), 'utf8'));
        for (const layer of livery.layers) {
          const target = svg.querySelector(`[data-livery-zone="${layer.zone}"]`);
          expect(target, `${pair.family} ${projection} ${layer.zone}`).not.toBeNull();
        }
        geometryByProjection.push(
          [...svg.querySelectorAll('[data-livery-zone]')].map((zone) => zone.innerHTML).join(''),
        );
      }
      expect(geometryByProjection[0]).not.toBe(geometryByProjection[1]);
    }
  });

  it('resolves templates without inventing a fallback for unknown future families', () => {
    for (const pair of AIRCRAFT_LIVERY_TEMPLATES) {
      expect(aircraftLiveryTemplate(pair.family, 'side')).toBe(pair.side);
      expect(aircraftLiveryTemplate(pair.family, 'top')).toBe(pair.top);
      expect(pair.side.src).toBeTruthy();
      expect(pair.top.src).toBeTruthy();
    }
    expect(aircraftLiveryTemplate('Future family', 'side')).toBeNull();
  });
});
