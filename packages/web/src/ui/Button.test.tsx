import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { BUTTON_VARIANTS, Button } from './Button';

const clientSrc = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function walk(dir: string, keep: (entry: string) => boolean): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return walk(full, keep);
    return keep(entry) ? [full] : [];
  });
}

/** Selectors a stylesheet declares, one entry per selector in a group. */
function declaredSelectors(css: string): string[] {
  return withoutComments(css)
    .split('}')
    .flatMap((chunk) => {
      const brace = chunk.indexOf('{');
      if (brace === -1) return [];
      return chunk
        .slice(0, brace)
        .split(',')
        .map((one) => one.trim())
        .filter((one) => one !== '');
    });
}

function withoutComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

describe('Button', () => {
  it('names every variant it admits to having', () => {
    expect([...BUTTON_VARIANTS]).toEqual(['primary', 'secondary', 'tertiary', 'danger']);
  });

  it.each(BUTTON_VARIANTS)('renders %s with its own modifier class', (variant) => {
    const { container } = render(<Button variant={variant}>Open route</Button>);
    const button = container.querySelector('button');
    expect(button?.classList.contains('btn')).toBe(true);
    expect(button?.classList.contains(`btn--${variant}`)).toBe(true);
  });

  it('defaults to secondary, so an unconsidered button is never dominant', () => {
    // The whole hierarchy rests on `primary` being a decision. A default of
    // primary would restore the state this component was built to fix.
    const { container } = render(<Button>Refresh</Button>);
    expect(container.querySelector('button')?.classList.contains('btn--secondary')).toBe(true);
  });

  it('defaults to type=button, because a typeless button in a form submits it', () => {
    render(<Button>Suggest</Button>);
    expect(screen.getByRole('button').getAttribute('type')).toBe('button');
  });

  it('lets a form submit say so', () => {
    render(<Button type="submit">Search</Button>);
    expect(screen.getByRole('button').getAttribute('type')).toBe('submit');
  });

  it('adds the small modifier only when asked', () => {
    const dense = render(<Button size="sm">Close</Button>);
    expect(dense.container.querySelector('button')?.classList.contains('btn--sm')).toBe(true);
    dense.unmount();

    const normal = render(<Button>Close</Button>);
    expect(normal.container.querySelector('button')?.classList.contains('btn--sm')).toBe(false);
  });

  it('keeps a caller layout class beside its own', () => {
    // How a surface with its own placement or typographic voice — the fleet
    // market, the session gate — keeps it without owning its own button.
    const { container } = render(
      <Button variant="primary" className="market-action">
        Buy
      </Button>,
    );
    const button = container.querySelector('button');
    expect(button?.classList.contains('btn--primary')).toBe(true);
    expect(button?.classList.contains('market-action')).toBe(true);
  });

  it('passes the rest of a button through untouched', () => {
    const onClick = vi.fn();
    render(
      <Button disabled aria-label="Publish rotation" onClick={onClick}>
        Publish
      </Button>,
    );
    const button = screen.getByRole('button', { name: 'Publish rotation' });
    expect(button.hasAttribute('disabled')).toBe(true);
    fireEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });
});

/**
 * `tokens.css` requires that status is *"always paired with a shape or label,
 * never carried by hue alone"*, and the status chips in `shell.css` honour it
 * with a glyph. The action hierarchy owes the same debt: if `primary` were only
 * a different colour, it would vanish for anyone who cannot separate the hues,
 * and a greyscale screenshot of the page would show no main action at all.
 *
 * So weight carries it too, and this is the test that says so.
 */
describe('the hierarchy does not rest on colour alone', () => {
  const css = withoutComments(readFileSync(join(clientSrc, 'ui', 'ui.css'), 'utf8'));

  function rule(selector: string): string {
    const block = css.split('}').find((chunk) => {
      const brace = chunk.indexOf('{');
      if (brace === -1) return false;
      return chunk
        .slice(0, brace)
        .split(',')
        .some((one) => one.trim() === selector);
    });
    expect(block, `no rule for ${selector}`).toBeDefined();
    return block === undefined ? '' : block.slice(block.indexOf('{') + 1);
  }

  it('gives primary a weight of its own', () => {
    expect(rule('.btn--primary')).toMatch(/font-weight:\s*[6-9]00/);
  });

  it.each(['.btn--secondary', '.btn--tertiary', '.btn--danger'])(
    '%s does not compete on weight',
    (selector) => {
      expect(rule(selector)).not.toMatch(/font-weight/);
    },
  );

  it.each(BUTTON_VARIANTS)('%s differs by fill or border, not only by text colour', (variant) => {
    expect(rule(`.btn--${variant}`)).toMatch(/background|border-color/);
  });
});

/**
 * The retired button classes, and a guard that they stay retired.
 *
 * Each was a button base named after the page that needed it, and the reason
 * there were eight is that adding a ninth was always easier than deciding which
 * level a new action belonged to. Deleting them is half the fix; this is the
 * other half.
 *
 * The TSX check looks inside `className` attributes rather than anywhere in the
 * file, so `Button.tsx` can still name them in its own history. The CSS check
 * looks at declared selectors for the same reason.
 */
describe('retired button classes', () => {
  const RETIRED = [
    'net-btn',
    'admin__submit',
    'admin__cancel',
    'admin__danger-button',
    'modal__button',
    'market-action--primary',
  ];

  const tsx = walk(clientSrc, (e) => e.endsWith('.tsx') && !e.endsWith('.test.tsx'));
  const cssFiles = walk(clientSrc, (e) => e.endsWith('.css'));

  it('scans a non-trivial number of files, so a passing result means something', () => {
    expect(tsx.length).toBeGreaterThanOrEqual(20);
    expect(cssFiles.length).toBeGreaterThanOrEqual(3);
  });

  it.each(tsx.map((file) => [relative(clientSrc, file), file]))(
    '%s applies no retired button class',
    (_label, file) => {
      const source = readFileSync(file, 'utf8');
      const applied = [...source.matchAll(/className="([^"]*)"/g)].flatMap((match) =>
        RETIRED.filter((name) => (match[1] ?? '').split(/\s+/).includes(name)),
      );
      expect(applied).toEqual([]);
    },
  );

  it.each(cssFiles.map((file) => [relative(clientSrc, file), file]))(
    '%s declares no retired button class',
    (_label, file) => {
      const selectors = declaredSelectors(readFileSync(file, 'utf8'));
      const declared = RETIRED.filter((name) =>
        selectors.some((selector) => selector.split(/[\s>+~]/).includes(`.${name}`)),
      );
      expect(declared).toEqual([]);
    },
  );
});
