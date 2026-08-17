import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * Enforces M0-09's acceptance criterion: **no colour values hardcoded outside
 * the theme token file.**
 *
 * That criterion is worth more than a code-review convention, because a single
 * stray `#1a1a1a` is exactly the thing that survives a review and then only
 * shows up as an unreadable element in the light theme. So this scans the
 * package and fails on a colour literal anywhere but tokens.css.
 */

const webSrc = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TOKEN_FILE = join(webSrc, 'theme', 'tokens.css');

/**
 * Hex colours, rgb()/rgba()/hsl()/hsla() functions, and the CSS named colours
 * most likely to be typed by accident. Deliberately not the full 148-name list:
 * this is a guard against carelessness, not an adversary.
 */
const COLOUR_PATTERNS: readonly { name: string; re: RegExp }[] = [
  { name: 'hex colour', re: /#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b/ },
  { name: 'rgb()/rgba()', re: /\brgba?\s*\(/ },
  { name: 'hsl()/hsla()', re: /\bhsla?\s*\(/ },
  { name: 'oklch()/lab()', re: /\b(?:oklch|oklab|lab|lch)\s*\(/ },
  {
    name: 'named colour',
    re: /(?:^|[\s:,;([])(?:white|black|red|green|blue|yellow|orange|purple|pink|grey|gray|silver|navy|teal|cyan|magenta|lime)(?=[\s;,)\]}'"]|$)/,
  },
];

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return walk(full);
    return /\.(css|tsx?|ts)$/.test(entry) ? [full] : [];
  });
}

/** Strips comments so prose about colour does not trip the scan. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

describe('colour literals', () => {
  const files = walk(webSrc).filter((file) => file !== TOKEN_FILE && !/\.test\.tsx?$/.test(file));

  it('scans a non-trivial number of files, so a passing result means something', () => {
    // Guards against the walk silently matching nothing and the suite passing
    // vacuously.
    expect(files.length).toBeGreaterThanOrEqual(5);
  });

  it.each(files.map((f) => [relative(webSrc, f), f]))(
    '%s contains no hardcoded colour',
    (label, file) => {
      const source = stripComments(readFileSync(file, 'utf8'));
      const offenders: string[] = [];

      source.split('\n').forEach((line, index) => {
        // Data URIs legitimately carry colours; the favicon in index.html is
        // one. They are markup, not theme, and cannot be tokenised.
        if (line.includes('data:image/svg+xml')) return;

        for (const { name, re } of COLOUR_PATTERNS) {
          const match = re.exec(line);
          if (match) {
            offenders.push(`line ${index + 1}: ${name} — ${match[0].trim()}`);
          }
        }
      });

      expect(
        offenders,
        `${label} must reference var(--…) from theme/tokens.css instead:\n  ${offenders.join('\n  ')}`,
      ).toEqual([]);
    },
  );

  it('does define colours in the token file', () => {
    const tokens = readFileSync(TOKEN_FILE, 'utf8');
    expect(/#[0-9a-fA-F]{6}\b/.test(tokens)).toBe(true);
  });

  it('defines every token for both themes', () => {
    // A token defined only under one theme renders as an invalid value in the
    // other, which usually looks like an invisible element rather than an error.
    const tokens = readFileSync(TOKEN_FILE, 'utf8');
    const namesIn = (selector: string): Set<string> => {
      const block = tokens.slice(tokens.indexOf(selector));
      const body = block.slice(block.indexOf('{'), block.indexOf('}'));
      return new Set([...body.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]!));
    };

    const dark = namesIn(':root,');
    const light = namesIn("[data-theme='light']");

    expect([...dark].filter((n) => !light.has(n))).toEqual([]);
    expect([...light].filter((n) => !dark.has(n))).toEqual([]);
  });
});
