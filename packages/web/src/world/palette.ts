export type RgbaColor = [red: number, green: number, blue: number, alpha: number];

export interface WorldPalette {
  ocean: RgbaColor;
  land: RgbaColor;
  landLine: RgbaColor;
  grid: RgbaColor;
  night: RgbaColor;
  route: RgbaColor;
}

const FALLBACK_PALETTE: WorldPalette = {
  ocean: [6, 15, 27, 255],
  land: [31, 52, 65, 255],
  landLine: [87, 112, 129, 180],
  grid: [110, 139, 157, 80],
  night: [3, 7, 14, 215],
  route: [94, 184, 255, 230],
};

export function parseHexColor(value: string, fallback: RgbaColor, alpha = fallback[3]): RgbaColor {
  const match = /^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(value.trim());
  if (!match) return [...fallback];
  return [
    Number.parseInt(match[1]!, 16),
    Number.parseInt(match[2]!, 16),
    Number.parseInt(match[3]!, 16),
    alpha,
  ];
}

export function readWorldPalette(): WorldPalette {
  const styles = globalThis.getComputedStyle?.(document.documentElement);
  const read = (property: string, fallback: RgbaColor, alpha = fallback[3]) =>
    parseHexColor(styles?.getPropertyValue(property) ?? '', fallback, alpha);

  return {
    ocean: read('--world-ocean', FALLBACK_PALETTE.ocean),
    land: read('--world-land', FALLBACK_PALETTE.land),
    landLine: read('--world-land-line', FALLBACK_PALETTE.landLine, 180),
    grid: read('--world-grid', FALLBACK_PALETTE.grid, 80),
    night: read('--world-night', FALLBACK_PALETTE.night, 215),
    route: read('--world-route', FALLBACK_PALETTE.route, 230),
  };
}
