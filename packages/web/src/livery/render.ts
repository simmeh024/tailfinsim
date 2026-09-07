import type { LiveryDocument, LiveryGradient, LiveryLayer } from '@tailfin/shared';

interface ZoneBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface CompiledZone {
  box: ZoneBox;
  geometry: string;
}

interface CompiledTemplate {
  source: string;
  zones: ReadonlyMap<string, CompiledZone>;
}

interface RenderedPaintLayer {
  readonly geometry: string;
  readonly opacity: number;
}

const templateCache = new Map<string, CompiledTemplate>();

function readZoneBox(zone: Element): ZoneBox | null {
  const values = (zone.getAttribute('data-zone-viewbox') ?? '').split(/\s+/).map(Number);
  const [x, y, width, height] = values;
  if (
    values.length !== 4 ||
    x === undefined ||
    y === undefined ||
    width === undefined ||
    height === undefined ||
    !values.every(Number.isFinite) ||
    width <= 0 ||
    height <= 0
  ) {
    return null;
  }
  return { x, y, width, height };
}

function compileTemplate(source: string): CompiledTemplate {
  const cached = templateCache.get(source);
  if (cached !== undefined) return cached;

  const document = new DOMParser().parseFromString(source, 'image/svg+xml');
  if (document.querySelector('parsererror') !== null) {
    throw new Error('The aircraft livery template is not valid SVG.');
  }
  const zones = new Map<string, CompiledZone>();
  for (const zone of document.querySelectorAll('[data-livery-zone]')) {
    const name = zone.getAttribute('data-livery-zone');
    const box = readZoneBox(zone);
    if (name !== null && box !== null) zones.set(name, { box, geometry: zone.innerHTML });
  }
  const compiled = { source, zones };
  templateCache.set(source, compiled);
  return compiled;
}

/**
 * Escapes a string on its way into an SVG attribute value.
 *
 * ## Why, when the schema already forbids this
 *
 * Every string this module interpolates is constrained by `@tailfin/shared`:
 * `LiveryColor` is `^#[0-9A-F]{6}([0-9A-F]{2})?$`, `LiveryLayerId` is
 * `^[A-Za-z0-9][A-Za-z0-9_-]*$`, zones and blend modes are enums, and every
 * number is `z.number().finite()`. None of them can carry a quote or an angle
 * bracket, so with a validated document this function is the identity.
 *
 * It exists because the result of {@link renderLiverySvg} goes to
 * `dangerouslySetInnerHTML`, and the guarantee that made that safe lived in
 * three places away from here: the schema, the draft loader's `safeParse`, and
 * the fact that the only caller renders the player's *own* document. All three
 * hold today. The third stops holding the moment a livery arrives from the
 * server — a public airline profile (M12-02), a public airframe (HIST-13), a
 * map sprite, or persisted artwork — and at that point an unescaped
 * concatenation is cross-player scripting rather than a private oddity.
 *
 * So the escape is here, next to the concatenation, where a reader can see that
 * the composition is safe without having to go and confirm what validated the
 * input. Defence in depth: the schema stays the control, this stays the floor.
 */
function attr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function coordinate(origin: number, extent: number, normalized: number): string {
  return String(origin + extent * normalized);
}

function stops(definition: LiveryGradient): string {
  return definition.stops
    .map((stop) => `<stop offset="${String(stop.offset)}" stop-color="${attr(stop.color)}"/>`)
    .join('');
}

function gradientMarkup(
  layer: Extract<LiveryLayer, { type: 'gradient' }>,
  box: ZoneBox,
  id: string,
): string {
  if (layer.gradient.kind === 'linear') {
    return `<linearGradient id="${attr(id)}" gradientUnits="userSpaceOnUse" x1="${coordinate(box.x, box.width, layer.gradient.from.x)}" y1="${coordinate(box.y, box.height, layer.gradient.from.y)}" x2="${coordinate(box.x, box.width, layer.gradient.to.x)}" y2="${coordinate(box.y, box.height, layer.gradient.to.y)}">${stops(layer.gradient)}</linearGradient>`;
  }

  return `<radialGradient id="${attr(id)}" gradientUnits="userSpaceOnUse" cx="${coordinate(box.x, box.width, layer.gradient.center.x)}" cy="${coordinate(box.y, box.height, layer.gradient.center.y)}" fx="${coordinate(box.x, box.width, layer.gradient.focal.x)}" fy="${coordinate(box.y, box.height, layer.gradient.focal.y)}" r="${String(Math.max(box.width, box.height) * layer.gradient.radius)}">${stops(layer.gradient)}</radialGradient>`;
}

function zoneClipMarkup(id: string, geometry: string): string {
  return `<clipPath id="${attr(id)}">${geometry}</clipPath>`;
}

function layerAlphaMaskMarkup(id: string, source: RenderedPaintLayer, inverse: boolean): string {
  const background = inverse ? 'white' : 'black';
  const foreground = inverse ? 'black' : 'white';
  return `<mask id="${attr(id)}" maskUnits="userSpaceOnUse" maskContentUnits="userSpaceOnUse"><rect width="100%" height="100%" fill="${background}"/><g fill="${foreground}" opacity="${String(source.opacity)}">${source.geometry}</g></mask>`;
}

function maskAttributes(
  layer: LiveryLayer,
  template: CompiledTemplate,
  rendered: ReadonlyMap<string, RenderedPaintLayer>,
  definitions: string[],
): { readonly markup: string; readonly data: string } | null {
  if (layer.mask === null) return { markup: '', data: '' };
  if (layer.mask.kind === 'zone') {
    const maskZone = template.zones.get(layer.mask.zone);
    if (maskZone === undefined) return null;
    const id = `paint-mask-zone-${layer.id}`;
    definitions.push(zoneClipMarkup(id, maskZone.geometry));
    return {
      markup: ` clip-path="url(#${attr(id)})"`,
      data: ` data-livery-mask="zone:${attr(layer.mask.zone)}"`,
    };
  }

  // Layer masks deliberately resolve only against preceding, rendered paint.
  // This matches the document contract and prevents a cyclic or invisible mask
  // from producing an accidental unmasked layer.
  const source = rendered.get(layer.mask.layerId);
  if (source === undefined) return null;
  const id = `paint-mask-layer-${layer.id}`;
  definitions.push(layerAlphaMaskMarkup(id, source, layer.mask.mode === 'inverse_alpha'));
  return {
    markup: ` mask="url(#${attr(id)})"`,
    data: ` data-livery-mask="layer:${attr(layer.mask.mode)}:${attr(layer.mask.layerId)}"`,
  };
}

/**
 * Projects M6-03's base-fill layers onto one trusted M6-02 template source.
 *
 * A source is parsed once to compile its zone geometry. Mutations then perform only bounded
 * string composition, keeping a 30-layer slider interaction inside one 60 fps frame. Every
 * interpolated value is constrained by the shared schema: ids, zones, colours, blend modes and
 * finite numbers cannot inject markup — and every one of them goes through {@link attr} anyway,
 * so the composition is safe whether or not the caller validated the document. The result is
 * rendered with `dangerouslySetInnerHTML`; that read the schema for its safety, and now reads
 * this function instead.
 *
 * Only **attribute values** are escaped. `zone.geometry`, `source.geometry` and the template
 * source are markup by construction — they come from a bundled, DOM-parsed M6-02 template, never
 * from a document — and escaping them would render the aircraft as text.
 *
 * The template's zone geometry remains the clipping geometry: each paint layer repeats only the
 * children of its target zone. Text, logos, shapes and paths are intentionally ignored until
 * their owning milestones add renderers.
 */
export function renderLiverySvg(templateSource: string, livery: LiveryDocument): string {
  const template = compileTemplate(templateSource);
  const definitions: string[] = [];
  const paint: string[] = [];
  const rendered = new Map<string, RenderedPaintLayer>();

  for (const layer of livery.layers) {
    if (!layer.visible || (layer.type !== 'fill' && layer.type !== 'gradient')) continue;
    const zone = template.zones.get(layer.zone);
    if (zone === undefined) continue;
    const mask = maskAttributes(layer, template, rendered, definitions);
    if (mask === null) continue;

    let fill: string;
    if (layer.type === 'fill') {
      if (layer.style.fill === null) continue;
      fill = layer.style.fill;
    } else {
      const gradientId = `paint-gradient-${layer.id}`;
      definitions.push(gradientMarkup(layer, zone.box, gradientId));
      fill = `url(#${gradientId})`;
    }
    paint.push(
      `<g data-painted-layer="${attr(layer.id)}" data-painted-zone="${attr(layer.zone)}"${mask.data}${mask.markup} opacity="${String(layer.opacity)}" style="mix-blend-mode:${attr(layer.blendMode)}" pointer-events="none" fill="${attr(fill)}">${zone.geometry}</g>`,
    );
    rendered.set(layer.id, { geometry: zone.geometry, opacity: layer.opacity });
  }

  const decoration = `${definitions.length === 0 ? '' : `<defs>${definitions.join('')}</defs>`}<g data-livery-paint="true">${paint.join('')}</g>`;
  const root = template.source.replace(
    '<svg ',
    `<svg role="img" data-rendered-layers="${String(paint.length)}" `,
  );
  const closingTag = root.lastIndexOf('</svg>');
  if (closingTag < 0) throw new Error('The aircraft livery template has no closing SVG tag.');
  return `${root.slice(0, closingTag)}${decoration}${root.slice(closingTag)}`;
}
