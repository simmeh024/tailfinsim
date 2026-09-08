import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * The landing page's artwork, held to its shape (LANDING-03).
 *
 * Beside `landing-tokens.test.ts` because that is where the checks on
 * `packages/web/landing` already live — this directory is outside the Vite
 * client, so nothing in it has a natural test home of its own.
 *
 * What this file is **not** is a budget. `app.test.ts` asserts the byte ceilings
 * on the *served* responses, which is where a budget belongs — it is the
 * transfer that costs a visitor something, and LANDING-11 owns the number. Two
 * copies of one ceiling is one copy too many. What is asserted here is what a
 * byte count cannot see: format, dimensions, embedded metadata, and whether the
 * document and the directory still agree about which files exist.
 *
 * The dimensions are pinned because a regenerated asset that silently ships at
 * the wrong size is not a broken build — it is a slightly blurry hero nobody
 * files a bug about.
 */

const landingDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'landing');

/** Canvas size and container chunks, read straight out of the RIFF container. */
function webp(file: string): {
  bytes: number;
  riff: boolean;
  codec: string;
  width: number;
  height: number;
  chunks: string[];
} {
  const b = readFileSync(join(landingDir, file));
  const codec = b.toString('ascii', 12, 16);
  let width = 0;
  let height = 0;
  if (codec === 'VP8X') {
    width = b.readUIntLE(24, 3) + 1;
    height = b.readUIntLE(27, 3) + 1;
  } else if (codec === 'VP8L') {
    const bits = b.readUInt32LE(21);
    width = (bits & 0x3fff) + 1;
    height = ((bits >> 14) & 0x3fff) + 1;
  } else if (codec === 'VP8 ') {
    width = b.readUInt16LE(26) & 0x3fff;
    height = b.readUInt16LE(28) & 0x3fff;
  }
  return {
    bytes: b.length,
    riff: b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP',
    codec,
    width,
    height,
    // The optional chunks that carry metadata rather than pixels.
    chunks: ['EXIF', 'XMP ', 'ICCP'].filter((name) => b.includes(Buffer.from(name, 'ascii'))),
  };
}

const HERO = 'landing-hero.webp';
const FLEET = [
  'fleet-atr72.webp',
  'fleet-e190.webp',
  'fleet-a321neo.webp',
  'fleet-777.webp',
  'fleet-747.webp',
] as const;

describe('the landing artwork', () => {
  const images = readdirSync(landingDir).filter(
    (entry) =>
      statSync(join(landingDir, entry)).isFile() && /\.(webp|png|jpe?g|gif|avif)$/.test(entry),
  );

  it('is the set the page expects, with no orphans', () => {
    /*
     * Both directions. A missing file is a broken image on the most-viewed page
     * in the product; an orphan is dead weight served from an origin that has
     * exactly one job, and the kind of thing that survives three redesigns.
     */
    expect(images.sort()).toEqual([HERO, ...FLEET].sort());

    const html = readFileSync(join(landingDir, 'index.html'), 'utf8');
    const css = readFileSync(join(landingDir, 'landing.css'), 'utf8');
    for (const file of FLEET) {
      expect(html, `${file} is on disk but nothing renders it`).toContain(`src="/${file}"`);
    }
    expect(css, 'the hero is on disk but no rule paints it').toContain(`url('/${HERO}')`);
  });

  it('ships WebP, and only WebP', () => {
    // `img-src 'self'` and one origin: every byte here is served by Fastify, so
    // the format is a decision this repository makes rather than a CDN's.
    for (const file of images) {
      const image = webp(file);
      expect(image.riff, `${file} is not a WebP container`).toBe(true);
      expect(['VP8 ', 'VP8L', 'VP8X'], `${file} has codec ${image.codec}`).toContain(image.codec);
    }
  });

  it('carries no EXIF, XMP or colour-profile payload', () => {
    /*
     * LANDING-03's security note: generated media is untrusted input until it has
     * been looked at. EXIF from a generation tool can carry prompts, model names,
     * software versions and occasionally a path from somebody's machine — none of
     * which belongs on a public origin, and all of which is invisible in a diff
     * because the file is binary.
     */
    for (const file of images) {
      expect(webp(file).chunks, `${file} carries metadata chunks`).toEqual([]);
    }
  });

  it('keeps the hero at its generated-then-downscaled size', () => {
    /*
     * Generated large and scaled down, never up (LANDING-03). 2400 wide covers a
     * 1200px CSS hero at 2× without resampling, and the 16:9 shape is what the
     * `background-size: 100% auto` rule letterboxes rather than crops — change
     * the ratio and the mask in `landing.css` stops hiding the seam it was
     * measured against.
     */
    const hero = webp(HERO);
    expect(hero.width).toBe(2400);
    expect(hero.height).toBe(1351);
  });

  it('keeps every aircraft at one size, because they share a track', () => {
    /*
     * The carousel translates a flex track by exactly 100% per slide. A single
     * aircraft at a different aspect ratio does not merely look wrong — it
     * changes the slide height, so the card resizes as the carousel advances and
     * the section below it moves on a five-second timer.
     */
    for (const file of FLEET) {
      const image = webp(file);
      expect(image.width, file).toBe(1400);
      expect(image.height, file).toBe(467);
    }
  });

  it('states the aircraft art is provisional, naming its successor', () => {
    /*
     * LANDING-03: mark the stand-in in code with an obvious replacement path.
     * VIS-05 (#376) renders a real Tailfin aircraft from a livery document; when
     * it exists it replaces these, and the next person should not need an
     * archaeology session to discover that.
     */
    const html = readFileSync(join(landingDir, 'index.html'), 'utf8');
    expect(html).toContain('VIS-05');
    expect(html).toContain('#376');
  });
});
