import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * The landing page's design language, held to its own rules (LANDING-02).
 *
 * `tokens.test.ts` beside this one scans `packages/web/src`. The landing page is
 * **not** in it: ADR-0028 makes it a static document served straight off disk,
 * outside the Vite client, so it can neither import `theme/tokens.css` nor be
 * reached by that file's guard. Its palette is therefore a second copy of a
 * shared identity — and a second copy with nothing holding it in place is a fork
 * with a delay on it.
 *
 * So this file does four jobs the client's guard does for the client:
 *
 *   1. no colour literal in the landing directory outside its token block;
 *   2. every `var(--…)` resolves;
 *   3. the values that carry identity equal `tokens.css`'s dark theme;
 *   4. the rules LANDING-02 decided — the orange qualification, one root-level
 *      reduced-motion block, media queries only at declared breakpoints — hold.
 */

const webSrc = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const landingDir = resolve(webSrc, '..', 'landing');
const LANDING_CSS = join(landingDir, 'landing.css');
const CLIENT_TOKENS = join(webSrc, 'theme', 'tokens.css');

const landingCss = readFileSync(LANDING_CSS, 'utf8');

/**
 * Blanks comments while preserving every line and column.
 *
 * Not `stripComments`, which deletes them: half of these assertions report a
 * line number, and every one of them reads *structure* — selectors, media
 * widths, declarations. This file's own comments discuss `.card`, `.panel`,
 * `--accent` and `@media (min-width: var(--lp-bp-laptop))` by name, and the
 * first draft of this guard failed on all four of them. Prose about the rule is
 * not a violation of it.
 */
function blank(source: string, open: string, close: string): string {
  const pattern = new RegExp(`${open}[\\s\\S]*?${close}`, 'g');
  return source.replace(pattern, (match) => match.replace(/[^\n]/g, ' '));
}

const css = blank(landingCss, '/\\*', '\\*/');

/** The `:root { … }` block at the top of landing.css — the only place a colour may live. */
const tokenBlock = ((): string => {
  const start = css.indexOf(':root {');
  expect(start, 'landing.css has no :root token block').toBeGreaterThanOrEqual(0);
  const end = css.indexOf('\n}', start);
  expect(end, 'landing.css :root block is unterminated').toBeGreaterThan(start);
  return css.slice(start, end);
})();

function declarations(source: string): Record<string, string> {
  return Object.fromEntries(
    [...source.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)].map((m) => [
      m[1]!,
      m[2]!.trim().replace(/\s+/g, ' ').toLowerCase(),
    ]),
  );
}

const landingTokens = declarations(tokenBlock);

function clientDarkTokens(): Record<string, string> {
  const source = blank(readFileSync(CLIENT_TOKENS, 'utf8'), '/\\*', '\\*/');
  const start = source.indexOf(':root,');
  return declarations(source.slice(start, source.indexOf("[data-theme='light']")));
}

/**
 * A file with everything that is allowed to mention a colour blanked out:
 * comments of all three syntaxes, and — in the stylesheet — the token block
 * itself. Line numbers survive, so an offence reports where it actually is.
 */
function scannable(file: string): string {
  let source = blank(readFileSync(file, 'utf8'), '/\\*', '\\*/');
  source = blank(source, '<!--', '-->');
  // `[^:]` so a `https://` in a URL is not read as the start of a comment.
  source = source.replace(/(^|[^:])(\/\/.*)$/gm, (_m, before: string, comment: string) =>
    before.concat(' '.repeat(comment.length)),
  );
  if (file === LANDING_CSS) {
    const start = source.indexOf(':root {');
    const end = source.indexOf('\n}', start);
    source =
      source.slice(0, start) + source.slice(start, end).replace(/[^\n]/g, ' ') + source.slice(end);
  }
  return source;
}

const COLOUR_PATTERNS: readonly { name: string; re: RegExp }[] = [
  { name: 'hex colour', re: /#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b/ },
  { name: 'rgb()/rgba()', re: /\brgba?\s*\(/ },
  { name: 'hsl()/hsla()', re: /\bhsla?\s*\(/ },
  { name: 'oklch()/lab()', re: /\b(?:oklch|oklab|lab|lch)\s*\(/ },
];

describe('the landing page carries no colour outside its token block', () => {
  const files = readdirSync(landingDir)
    .map((entry) => join(landingDir, entry))
    .filter((full) => statSync(full).isFile() && /\.(css|html|js)$/.test(full));

  it('scans the whole directory, so a pass means something', () => {
    // The HTML and the script are in scope on purpose: the first draft of this
    // page painted the tail fin with `fill="#ffb84d"` in markup, which no
    // stylesheet guard would ever have seen.
    expect(files.map((f) => relative(landingDir, f)).sort()).toEqual(
      expect.arrayContaining(['index.html', 'landing.css', 'landing.js']),
    );
  });

  it.each(files.map((f) => [relative(landingDir, f), f]))('%s', (label, file) => {
    const offenders: string[] = [];

    scannable(file)
      .split('\n')
      .forEach((line, index) => {
        // The favicon is a data URI: markup, not theme, and not tokenisable. The
        // `theme-color` meta is checked separately below, against the ground token.
        if (line.includes('data:image/svg+xml')) return;
        if (line.includes('name="theme-color"')) return;
        // Google's mark is four registered brand colours. Recolouring it is
        // exactly what their guidelines forbid, and those guidelines are what
        // ADR-0028 leans on to justify showing the mark at all.
        if (/fill="#(?:4285F4|34A853|FBBC05|EA4335)"/i.test(line)) return;
        // A mask is a luminance stencil, not a colour: `#000` there means
        // "opaque", and a token would make it look like a theme decision.
        if (line.includes('mask-image')) return;

        for (const { name, re } of COLOUR_PATTERNS) {
          const match = re.exec(line);
          if (match) offenders.push(`line ${String(index + 1)}: ${name} — ${match[0].trim()}`);
        }
      });

    expect(
      offenders,
      `${label} must reference var(--lp-…) from landing.css's :root block instead:\n  ${offenders.join('\n  ')}`,
    ).toEqual([]);
  });

  it('keeps the browser chrome the same navy as the page', () => {
    /*
     * `<meta name="theme-color">` cannot hold a custom property, so it is the one
     * colour outside the token block. Left unchecked it drifts, and the symptom
     * is a phone painting its address bar a different navy from the page under
     * it — which reads as a rendering artefact rather than as a stale literal.
     */
    const html = blank(readFileSync(join(landingDir, 'index.html'), 'utf8'), '<!--', '-->');
    const themeColour = /name="theme-color"\s+content="(#[0-9a-fA-F]{6})"/.exec(html)?.[1];
    expect(themeColour?.toLowerCase()).toBe(landingTokens['--lp-bg']);
  });
});

describe('the landing tokens and the client tokens say the same thing', () => {
  /*
   * The values that carry identity. A visitor signs in on the landing page and
   * arrives in the client a second later; if these drift, the transition is a
   * visible seam between the advertisement and the product.
   *
   * Deliberately *not* every token. The display scale, the hero wash and the
   * provider colours are this surface's alone, and pinning them to a client that
   * has no equivalent would be pinning them to nothing.
   */
  const SHARED: readonly (readonly [string, string])[] = [
    ['--lp-bg', '--bg-base'],
    ['--lp-surface', '--bg-raised'],
    ['--lp-border', '--border-subtle'],
    ['--lp-border-strong', '--border-strong'],
    ['--lp-text', '--text-primary'],
    ['--lp-text-secondary', '--text-secondary'],
    ['--lp-ink-on-accent', '--text-on-accent'],
    ['--lp-accent', '--accent'],
    ['--lp-accent-hover', '--accent-hover'],
    ['--lp-brand', '--brand'],
  ];

  const client = clientDarkTokens();

  it('reads both files', () => {
    expect(Object.keys(landingTokens).length).toBeGreaterThan(30);
    expect(client['--bg-base']).toBeDefined();
  });

  it.each(SHARED)('%s equals the client dark theme %s', (landingName, clientName) => {
    expect(landingTokens[landingName], `${landingName} is not declared`).toBeDefined();
    expect(client[clientName], `${clientName} is not declared`).toBeDefined();
    expect(landingTokens[landingName]).toBe(client[clientName]);
  });

  it('imports no ink that fails AA on this page', () => {
    /*
     * `--text-muted` (#6d7c93) is the obvious third ink to copy across and it
     * measures 4.13:1 on `--lp-surface` — under AA for body text, on the cards.
     * It reads as "the quiet one" and it is the one that would be used for every
     * caption. Named here so re-adding it is a deliberate act.
     */
    expect(Object.values(landingTokens)).not.toContain(client['--text-muted']);
  });
});

describe('the rules LANDING-02 settled', () => {
  const rules = [...css.matchAll(/(^|\n)([^{}@\n][^{}]*?)\{([^}]*)\}/g)].map((m) => ({
    selector: m[2]!.trim().replace(/\s+/g, ' '),
    body: m[3]!,
  }));

  it('parses the stylesheet into rules', () => {
    expect(rules.length).toBeGreaterThan(30);
    expect(rules.some((r) => r.selector.includes('.lp-cta'))).toBe(true);
  });

  it('never paints an interactive element with the brand amber', () => {
    /*
     * The other half of `tokens.css`'s qualified brand-amber rule. Amber is
     * allowed here for decoration — the mark, the feature icons, the headline's
     * full stop — and forbidden for anything a person can click, because the one
     * thing H.4's single-accent guarantee buys is that blue means "this does
     * something".
     */
    const interactive = /(^|[\s,>])(a|button)\b|:hover|:focus|\.lp-cta|\.lp-provider|__nav\b/;
    const offenders = rules
      .filter((rule) => rule.body.includes('--lp-brand') && interactive.test(rule.selector))
      .map((rule) => rule.selector);

    expect(
      offenders,
      `these rules make the brand amber interactive:\n  ${offenders.join('\n  ')}`,
    ).toEqual([]);
  });

  it('zeroes motion once, at the root, and nowhere else', () => {
    /*
     * Every component inherits the reduced-motion decision from the token rather
     * than restating it. The property that matters is not that the page respects
     * the preference today — it is that LANDING-04…09 cannot add a section that
     * forgets to.
     */
    const blocks = [...css.matchAll(/@media\s*\(prefers-reduced-motion[^)]*\)\s*\{/g)];
    expect(blocks, 'expected exactly one reduced-motion block').toHaveLength(1);

    const block = css.slice(blocks[0]!.index);
    const selectors = [...block.slice(0, block.indexOf('\n}\n')).matchAll(/\n\s{2}([^{\n]+)\{/g)]
      .map((m) => m[1]!.trim())
      .sort();
    expect(selectors).toEqual([':root', 'html']);

    // A duration typed into a rule cannot be zeroed by the root, so there must
    // not be one anywhere but the token block that declares them and the
    // reduced-motion block that overrides them.
    const outside = css
      .replace(/@media\s*\(prefers-reduced-motion[\s\S]*?\n\}\n/, '')
      .replace(tokenBlock, '');
    const hardcoded = [...outside.matchAll(/\b\d+m?s\b/g)].map((m) => m[0]);
    expect(hardcoded, 'durations must come from --lp-motion-* tokens').toEqual([]);
  });

  it('only opens a media query at a declared breakpoint', () => {
    /*
     * A media query cannot read a custom property — `@media (min-width:
     * var(--lp-bp-laptop))` is invalid and fails *silently*, so the layout it
     * guards simply never arrives. The literal therefore has to stay in the
     * query, and this is what keeps it equal to the token.
     */
    const declared = new Set(
      Object.entries(landingTokens)
        .filter(([name]) => name.startsWith('--lp-bp-'))
        .map(([, value]) => value),
    );
    expect(declared.size).toBe(3);

    const widths = [...css.matchAll(/@media\s*\((?:min|max)-width:\s*([^)]+)\)/g)].map((m) =>
      m[1]!.trim().toLowerCase(),
    );
    expect(widths.length, 'expected the page to have breakpoints at all').toBeGreaterThan(0);

    const strays = widths.filter((width) => !declared.has(width));
    expect(strays, `media widths not declared as --lp-bp-* tokens: ${strays.join(', ')}`).toEqual(
      [],
    );
  });

  it('names every class in one family', () => {
    /*
     * `.card`, `.panel` and `.stat` — this page's names before LANDING-02 — are
     * all live in dashboard.css. They collide the moment ADR-0028's deferred
     * "static shell that hydrates" arrives, and a collision between a marketing
     * card and a finance card is not a bug anyone would look for here.
     */
    const html = blank(readFileSync(join(landingDir, 'index.html'), 'utf8'), '<!--', '-->');
    const used = [...html.matchAll(/class="([^"]+)"/g)].flatMap((m) => m[1]!.split(/\s+/));
    const strays = [...new Set(used)].filter((name) => !name.startsWith('lp-')).sort();
    expect(strays, `landing classes must all be lp-…: ${strays.join(', ')}`).toEqual([]);

    // `url('/landing-hero.webp')` is not a class named `webp`.
    const selectors = css.replace(/url\([^)]*\)/g, 'url()');
    const declared = [...selectors.matchAll(/\.([a-z][a-z0-9_-]*)/g)].map((m) => m[1]!);
    const foreign = [...new Set(declared)].filter((name) => !name.startsWith('lp-')).sort();
    expect(foreign, `landing.css declares non-lp classes: ${foreign.join(', ')}`).toEqual([]);
  });

  it('resolves every token it references', () => {
    const offences = css
      .split('\n')
      .flatMap((line, index) =>
        [...line.matchAll(/var\(\s*(--[a-z0-9-]+)\s*\)/g)]
          .filter((m) => landingTokens[m[1]!] === undefined)
          .map((m) => `landing.css:${String(index + 1)}  ${m[1]!}`),
      );
    expect(offences, `undefined custom properties:\n${offences.join('\n')}`).toEqual([]);
  });

  it('declares no token it never uses', () => {
    // The mistake this page was told not to repeat: --rail-width-collapsed in
    // the client's tokens is defined for a layout nobody built, and UX-09 cites
    // it. A design language is a catalogue of what the page uses.
    const body = css.replace(tokenBlock, '');
    const unused = Object.keys(landingTokens)
      .filter((name) => !name.startsWith('--lp-bp-'))
      .filter((name) => !body.includes(`var(${name})`))
      .sort();
    expect(unused, `declared but never referenced: ${unused.join(', ')}`).toEqual([]);
  });
});

describe('contrast, measured rather than asserted', () => {
  /*
   * LANDING-02 supplies these numbers and LANDING-10 enforces the standard
   * across the page. They are here as well as in the stylesheet's comments
   * because a ratio written only in a comment is a ratio that rots — and the
   * failing pair this exercise actually found (`--text-muted` at 4.13 on the
   * cards) was one nobody would have noticed by looking.
   *
   * The landing page has one theme. There is no light treatment of a night-time
   * photograph of the earth that is the same page.
   */
  function channel(value: number): number {
    const c = value / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }

  function luminance(hex: string): number {
    const h = hex.replace('#', '');
    const [r, g, b] = [0, 2, 4].map((i) => channel(parseInt(h.slice(i, i + 2), 16)));
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
  }

  function contrast(fg: string, bg: string): number {
    const [a, b] = [luminance(fg), luminance(bg)];
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  }

  /** [foreground token, background token, minimum, why that minimum] */
  const PAIRS: readonly (readonly [string, string, number, string])[] = [
    ['--lp-text', '--lp-bg', 4.5, 'body copy'],
    ['--lp-text', '--lp-surface', 4.5, 'body copy on a card'],
    ['--lp-text', '--lp-hero-wash', 4.5, 'the headline over the map'],
    ['--lp-text-secondary', '--lp-bg', 4.5, 'the lede'],
    ['--lp-text-secondary', '--lp-surface', 4.5, 'card copy and stat labels'],
    ['--lp-text-secondary', '--lp-hero-wash', 4.5, 'the lede over the map'],
    ['--lp-accent', '--lp-bg', 4.5, 'link text'],
    ['--lp-ink-on-accent', '--lp-accent', 4.5, 'the CTA label'],
    ['--lp-brand', '--lp-bg', 3, 'the mark and the feature icons — a graphic, not text'],
    ['--lp-brand', '--lp-hero-wash', 3, 'the headline stop over the map'],
    // Large text (>=18.66px bold) needs 3:1, which is the whole reason
    // --lp-text-provider is 1.1875rem at weight 700: white on Google's blue is
    // 3.56 and does not reach 4.5 at any size.
    ['--lp-provider-ink', '--lp-google', 3, 'the Google button label, as large text'],
    ['--lp-provider-ink', '--lp-discord', 3, 'the Discord button label, as large text'],
  ];

  it.each(PAIRS)('%s on %s clears %s:1 (%s)', (fg, bg, minimum) => {
    const foreground = landingTokens[fg];
    const background = landingTokens[bg];
    expect(foreground, `${fg} is not declared`).toMatch(/^#[0-9a-f]{6}$/);
    expect(background, `${bg} is not declared`).toMatch(/^#[0-9a-f]{6}$/);
    expect(contrast(foreground!, background!)).toBeGreaterThanOrEqual(minimum);
  });

  it('keeps the provider label large enough for its 3:1 pairing to be legal', () => {
    /*
     * The pair above only conforms *as large text*. If somebody shrinks the
     * button, the ratio does not change but its threshold does — from 3 to 4.5 —
     * and it silently stops passing. WCAG's bar is 18.66px bold; 1.1875rem is 19.
     */
    expect(landingTokens['--lp-text-provider']).toBe('1.1875rem');
    const rule = /\.lp-provider\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(rule).toContain('font-size: var(--lp-text-provider)');
    expect(rule).toContain('font-weight: var(--lp-weight-bold)');
    expect(landingTokens['--lp-weight-bold']).toBe('700');
  });
});
