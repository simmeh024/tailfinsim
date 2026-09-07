import { readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * What the client's images are allowed to weigh (PERF-01).
 *
 * Eleven executive floorplans shipped as PNG for two milestones — **25.17 MB**,
 * in a directory whose other floorplans were already webp at 71–123 kB — and
 * nothing noticed, because an image import is only a URL string until something
 * renders it. Bundle size did not move, no test failed, and the cost landed on
 * whoever opened the executive floor: ~2.4 MB for a single background image.
 *
 * A convention would not have caught that; the convention was already webp and
 * the PNGs sat beside it. So this is the structural version — a size ceiling,
 * and a format rule for the one directory that has both kinds of consumer.
 */

const WEB_SRC = join(dirname(fileURLToPath(import.meta.url)));

/**
 * The ceiling for one image, in bytes.
 *
 * 600 kB. The largest asset in the tree is the world's 4096px equirectangular
 * terrain at 501 kB, which is loaded lazily with the renderer and earns its
 * size; this sits far enough above it to leave room for a re-export and far
 * enough below a megabyte to catch the next accident.
 *
 * An asset that genuinely needs more should raise this **with its reason
 * written here**, which is the whole point of the number living in a file
 * somebody has to edit.
 */
const MAX_IMAGE_BYTES = 600 * 1024;

const IMAGE = /\.(png|jpe?g|gif|webp|avif)$/i;

function images(dir: string): { path: string; bytes: number }[] {
  const out: { path: string; bytes: number }[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...images(path));
    else if (IMAGE.test(entry.name)) out.push({ path, bytes: statSync(path).size });
  }
  return out;
}

describe('the client’s image budget', () => {
  it('ships no single image above the ceiling', () => {
    const over = images(WEB_SRC)
      .filter((image) => image.bytes > MAX_IMAGE_BYTES)
      .map((image) => `${relative(WEB_SRC, image.path)} — ${(image.bytes / 1024).toFixed(0)} kB`);

    expect(
      over,
      'These images are over the per-file ceiling. Re-encode them (webp, quality 80, ' +
        'effort 6, smartSubsample is what the floorplans use) or raise MAX_IMAGE_BYTES ' +
        'in this file with the reason written beside it:\n  ' +
        over.join('\n  '),
    ).toEqual([]);
  });

  /**
   * The floorplans specifically, because that is where it went wrong.
   *
   * Both the Headquarters panel and the C-Suite floor draw from this one
   * directory, so a new render dropped in as a PNG is invisible to a reviewer
   * reading a diff of TypeScript — the import line looks identical either way.
   */
  it('keeps every floorplan in webp', () => {
    const dir = join(WEB_SRC, 'hq', 'assets', 'floorplan');
    const wrong = readdirSync(dir).filter((name) => IMAGE.test(name) && !name.endsWith('.webp'));

    expect(
      wrong,
      'Floorplans are webp. These are not, and a PNG render here has cost this ' +
        'project 25 MB once already:\n  ' +
        wrong.join('\n  '),
    ).toEqual([]);
  });

  /** A cheap total, so a hundred small additions cannot do what eleven large ones did. */
  it('keeps the whole image tree inside a total budget', () => {
    const all = images(WEB_SRC);
    const totalMb = all.reduce((n, image) => n + image.bytes, 0) / 1024 / 1024;

    // 10 MB against 7.3 MB today. The headroom is for art the game still wants,
    // not for a format regression: 25 MB of PNG would have failed this outright.
    expect(totalMb, `${all.length} images totalling ${totalMb.toFixed(2)} MB`).toBeLessThan(10);
  });
});
