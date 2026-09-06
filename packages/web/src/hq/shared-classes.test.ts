import { readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * The Headquarters and C-Suite pages share one class namespace (UX pass).
 *
 * They were built as two views of the same idea and they still wear each
 * other's classes: `hq-card__action`, `hq-page__policies`, `hq-staff__remove`,
 * `hq-staff__assign` and `hq-staff__empty` are all rendered by
 * `ExecutiveSuitePage` or `StaffExecDrawer` as well as — until the UX pass — by
 * the Headquarters page and its drawer.
 *
 * That is exactly how the pass broke the C-Suite. Moving the Headquarters cards
 * onto `ui/Button` made `.hq-card__action` unused *on that page*, so its rule
 * went with it; `ExecutiveSuitePage` still renders a plain `<button>` with that
 * class, and its Hire and Let go controls silently became browser defaults. A
 * page that was not part of the change and has no test asserting its chrome.
 *
 * So this walks the two un-passed C-Suite files, collects every `hq-` class they
 * render, and fails when shell.css does not declare one. It is a coarse check —
 * it does not know whether the rule still says the right thing — but it catches
 * the case that actually happened: a rule deleted alongside the last caller
 * somebody thought to look for.
 *
 * When the C-Suite gets its own pass and moves to `ui/Button`, delete the class
 * from the list here rather than loosening the check.
 */

const hq = dirname(fileURLToPath(import.meta.url));
const SHELL_CSS = resolve(hq, '..', 'shell', 'shell.css');

/** The files still styled out of the shared `hq-` namespace. */
const UNPASSED = ['ExecutiveSuitePage.tsx', 'StaffExecDrawer.tsx'];

function declaredClasses(css: string): Set<string> {
  return new Set(Array.from(css.matchAll(/\.([a-zA-Z0-9_-]+)/g), (match) => match[1] ?? ''));
}

function renderedClasses(source: string): Set<string> {
  const classes = new Set<string>();
  for (const match of source.matchAll(/className="([^"]+)"/g)) {
    for (const name of (match[1] ?? '').split(/\s+/)) {
      if (name.startsWith('hq-')) classes.add(name);
    }
  }
  return classes;
}

describe('the classes the Headquarters and C-Suite pages share', () => {
  const css = readFileSync(SHELL_CSS, 'utf8');
  const declared = declaredClasses(css);

  it('finds a non-trivial stylesheet, so a passing result means something', () => {
    expect(declared.size).toBeGreaterThan(200);
  });

  it.each(UNPASSED)('%s renders no hq- class shell.css has stopped declaring', (file) => {
    const rendered = renderedClasses(readFileSync(join(hq, file), 'utf8'));
    // Guards against the extraction silently matching nothing.
    expect(rendered.size).toBeGreaterThan(3);
    const undeclared = [...rendered].filter((name) => !declared.has(name)).sort();
    expect(undeclared, `${relative(hq, SHELL_CSS)} declares no rule for these`).toEqual([]);
  });
});
