import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { STATE_KINDS, StateBlock, type StateKind } from './StateBlock';

/**
 * The announcement each kind is supposed to make. Written out here rather than
 * imported from the component, so the test disagrees with the component if
 * either changes — importing the same map would make this assert that a table
 * equals itself.
 */
const EXPECTED_ROLE: Record<StateKind, string | null> = {
  loading: 'status',
  empty: null,
  refused: 'alert',
  broken: 'alert',
};

describe('StateBlock', () => {
  it('covers every kind the component admits to having', () => {
    // Guards the two tables below against a fifth kind arriving with no
    // decision made about how it announces itself.
    expect([...STATE_KINDS].sort()).toEqual(Object.keys(EXPECTED_ROLE).sort());
    expect(STATE_KINDS.length).toBeGreaterThanOrEqual(4);
  });

  it.each(STATE_KINDS)('shows the caller sentence for %s', (kind) => {
    render(<StateBlock kind={kind}>Nothing wants attention.</StateBlock>);
    expect(screen.getByText('Nothing wants attention.')).toBeTruthy();
  });

  it.each(STATE_KINDS)('announces %s the way its kind requires', (kind) => {
    const { container } = render(<StateBlock kind={kind}>A sentence.</StateBlock>);
    const block = container.querySelector('.state');
    expect(block?.getAttribute('role')).toBe(EXPECTED_ROLE[kind]);
  });

  it('makes a slow request audible, which a bare paragraph did not', () => {
    // The regression this component exists for: before it, "Loading the
    // market..." was a plain <p>, so a screen reader heard an empty panel.
    render(<StateBlock kind="loading">Loading the market…</StateBlock>);
    expect(screen.getByRole('status').textContent).toContain('Loading the market…');
  });

  it('keeps an absence and a failure apart for assistive technology too', () => {
    const empty = render(<StateBlock kind="empty">No aircraft type has flown yet.</StateBlock>);
    expect(empty.container.querySelector('[role]')).toBeNull();
    empty.unmount();

    render(<StateBlock kind="broken">Could not load the catalogue.</StateBlock>);
    expect(screen.getByRole('alert').textContent).toContain('Could not load the catalogue.');
  });

  it.each(STATE_KINDS)('exposes no glyph to assistive technology for %s', (kind) => {
    const { container } = render(<StateBlock kind={kind}>A sentence.</StateBlock>);
    // Every direct child of the glyph slot is decoration and must say so;
    // otherwise a screen reader reads the dots or announces "image".
    const glyphChildren = [...(container.querySelector('.state__glyph')?.children ?? [])];
    expect(glyphChildren.length).toBeGreaterThan(0);
    for (const child of glyphChildren) {
      expect(child.getAttribute('aria-hidden')).toBe('true');
    }
  });

  it('puts a resolving action inside the block rather than beside it', () => {
    // Several of the notes this replaces had their "Back to players" link as a
    // loose sibling, so the two were unrelated to anything reading the page.
    const { container } = render(
      <StateBlock kind="empty" action={<a href="/admin/players">Back to players</a>}>
        No player with that id.
      </StateBlock>,
    );
    const block = container.querySelector('.state');
    expect(block?.querySelector('.state__action a')?.textContent).toBe('Back to players');
  });

  it('omits the action slot entirely when there is nothing to resolve', () => {
    const { container } = render(<StateBlock kind="empty">No sessions.</StateBlock>);
    expect(container.querySelector('.state__action')).toBeNull();
  });

  it('tags the kind on the element, so a page can be checked without reading prose', () => {
    const { container } = render(<StateBlock kind="refused">No admin grant.</StateBlock>);
    expect(container.querySelector('.state')?.getAttribute('data-state')).toBe('refused');
  });

  it('keeps a caller layout class alongside its own', () => {
    const { container } = render(
      <StateBlock kind="empty" className="net-panel__state">
        No rotations yet.
      </StateBlock>,
    );
    const block = container.querySelector('.state');
    expect(block?.classList.contains('state--empty')).toBe(true);
    expect(block?.classList.contains('net-panel__state')).toBe(true);
  });
});

/**
 * A guard rather than a convention.
 *
 * The reason the app had two note classes doing the same job is that adding a
 * third hand-written one was always the path of least resistance. Nothing
 * stopped it, so nothing did. This scans the client for the two shapes that are
 * unambiguously a state — a note whose sentence opens with "Loading" or with
 * "Could not load" — because prose never opens either way, so a match is always
 * somebody reaching for a paragraph where the block belongs.
 *
 * It deliberately does not police "No ..." or "Nothing ...": plenty of
 * legitimate explanatory prose opens like that, and a guard that cries wolf
 * gets deleted.
 */
describe('hand-rolled state notes', () => {
  const clientSrc = resolve(dirname(fileURLToPath(import.meta.url)), '..');

  function walk(dir: string): string[] {
    return readdirSync(dir).flatMap((entry) => {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) return walk(full);
      return entry.endsWith('.tsx') && !entry.endsWith('.test.tsx') ? [full] : [];
    });
  }

  const STATE_NOTE = /<p className="(?:admin__note|page__note)"[^>]*>\s*(Loading|Could not load)/;
  const files = walk(clientSrc);

  it('scans a non-trivial number of files, so a passing result means something', () => {
    expect(files.length).toBeGreaterThanOrEqual(20);
  });

  it.each(files.map((file) => [relative(clientSrc, file), file]))(
    '%s says loading and failure through StateBlock',
    (_label, file) => {
      const match = STATE_NOTE.exec(readFileSync(file, 'utf8'));
      expect(match?.[0] ?? null).toBeNull();
    },
  );
});
