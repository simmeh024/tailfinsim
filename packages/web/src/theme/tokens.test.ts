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

  it('never gives an environment the interaction accent', () => {
    /*
     * The bug this exists to stop, which shipped once: `--env-dev` was set to
     * the same #5eb8ff as `--accent`, so the DEV chip was exactly the blue of
     * every link and of the active nav underline. It rendered perfectly and
     * meant nothing — an environment marker indistinguishable from ordinary
     * chrome is not a marker.
     *
     * Environments must also differ from *each other*: telling production from
     * dev at a glance is the entire job, and this console can archive a world
     * and revoke the last admin.
     */
    const tokens = readFileSync(TOKEN_FILE, 'utf8');

    const valuesIn = (selector: string): Record<string, string> => {
      const block = tokens.slice(tokens.indexOf(selector));
      const body = block.slice(block.indexOf('{'), block.indexOf('}'));
      return Object.fromEntries(
        [...body.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)].map((m) => [
          m[1]!,
          m[2]!.trim().toLowerCase(),
        ]),
      );
    };

    for (const selector of [':root,', "[data-theme='light']"]) {
      const v = valuesIn(selector);
      const envs = ['--env-production', '--env-dev', '--env-local'];

      for (const env of envs) {
        expect(v[env], `${env} is missing in ${selector}`).toBeDefined();
        expect(v[env], `${env} must not be the interaction accent (${selector})`).not.toBe(
          v['--accent'],
        );
      }

      const distinct = new Set(envs.map((e) => v[e]));
      expect(distinct.size, `environments must be distinguishable (${selector})`).toBe(envs.length);
    }
  });

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

/**
 * Every `var(--…)` must resolve to a token that exists.
 *
 * Added after a real failure. The console's stylesheet referenced `--space-5`,
 * `--surface` and `--text` — none of which exist. CSS does not complain about an
 * undefined custom property; the declaration is simply dropped, so the admin
 * console shipped with **no gaps, no padding and transparent panels**, and it
 * looked like a layout bug rather than three typos.
 *
 * The colour-literal guard above could not catch it: nothing was hardcoded. The
 * property that was missing is that a reference resolves at all.
 *
 * A fallback is honoured — `var(--maybe, 1rem)` is a deliberate choice and a
 * working declaration, so it is exempt.
 */
describe('token references', () => {
  const defined = new Set(
    (readFileSync(TOKEN_FILE, 'utf8').match(/--[a-z0-9-]+(?=\s*:)/g) ?? []).map((name) => name),
  );

  it('knows about the tokens it is checking against', () => {
    // Guards the guard: a regex that matched nothing would make every assertion
    // below pass vacuously.
    expect(defined.size).toBeGreaterThan(20);
    expect(defined.has('--space-4')).toBe(true);
  });

  it('resolves every token referenced without a fallback', () => {
    const offences: string[] = [];
    const stylesheets = walk(webSrc).filter((file) => file !== TOKEN_FILE && file.endsWith('.css'));
    expect(stylesheets.length).toBeGreaterThan(0);

    for (const file of stylesheets) {
      const source = readFileSync(file, 'utf8');
      source.split('\n').forEach((line, index) => {
        // `var(--name)` only — `var(--name, fallback)` is a working declaration
        // whether or not the token exists, and sometimes deliberately so.
        for (const match of line.matchAll(/var\(\s*(--[a-z0-9-]+)\s*\)/g)) {
          const token = match[1];
          if (token !== undefined && !defined.has(token)) {
            offences.push(`${relative(webSrc, file)}:${String(index + 1)}  ${token}`);
          }
        }
      });
    }

    expect(offences, `undefined custom properties:\n${offences.join('\n')}`).toEqual([]);
  });
});
