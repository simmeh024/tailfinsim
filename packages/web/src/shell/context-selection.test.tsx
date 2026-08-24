import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { ContextSelectionProvider, useContextSelection } from './context-selection';

import type { ReactNode } from 'react';

/**
 * The context panel's selection store (App. H.4).
 *
 * The panel has existed since the shell did, showing a paragraph promising that
 * detail *would* appear there. These tests are about the store that finally puts
 * something in it — and mostly about the two behaviours that are easy to get
 * wrong and invisible when they are: a selection that outlives its page, and a
 * component that cannot be tested without the whole shell.
 */

function Selector({ id = 'pool-1', title = 'ATR 72 · Captain' }: { id?: string; title?: string }) {
  const { select, clear, selection } = useContextSelection();
  return (
    <div>
      <button
        type="button"
        onClick={() => {
          select({ kind: 'crew-pool', id, title, subtitle: 'EHAM', body: <p>Detail for {id}</p> });
        }}
      >
        Select {id}
      </button>
      <button type="button" onClick={clear}>
        Clear
      </button>
      <output>{selection === null ? 'none' : `${selection.kind}:${selection.id}`}</output>
    </div>
  );
}

function Panel(): ReactNode {
  const { selection } = useContextSelection();
  return (
    <aside aria-label="Context">
      <h2>{selection?.title ?? 'Context'}</h2>
      {selection?.subtitle !== undefined && <p>{selection.subtitle}</p>}
      {selection === null ? <p>Nothing selected</p> : selection.body}
    </aside>
  );
}

describe('the context selection store', () => {
  it('carries a page’s own rendered detail to the panel', () => {
    render(
      <ContextSelectionProvider>
        <Selector />
        <Panel />
      </ContextSelectionProvider>,
    );

    expect(screen.getByText('Nothing selected')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Select pool-1' }));

    /*
     * The panel renders what the page gave it. It does not switch on a kind —
     * that design would put fleet, network, finance and crew rendering into one
     * shell component, and make every new selectable thing a change to a file
     * five other pages depend on.
     */
    expect(screen.getByText('Detail for pool-1')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'ATR 72 · Captain' })).toBeInTheDocument();
    expect(screen.getByText('EHAM')).toBeInTheDocument();
  });

  it('replaces the selection rather than stacking it', () => {
    render(
      <ContextSelectionProvider>
        <Selector id="pool-1" title="First" />
        <Selector id="pool-2" title="Second" />
        <Panel />
      </ContextSelectionProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Select pool-1' }));
    fireEvent.click(screen.getByRole('button', { name: 'Select pool-2' }));

    // Choosing another row swaps the panel's contents; it does not navigate and
    // it does not accumulate.
    expect(screen.getByText('Detail for pool-2')).toBeInTheDocument();
    expect(screen.queryByText('Detail for pool-1')).not.toBeInTheDocument();
  });

  it('returns to the neutral empty state when cleared', () => {
    render(
      <ContextSelectionProvider>
        <Selector />
        <Panel />
      </ContextSelectionProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Select pool-1' }));
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));

    expect(screen.getByText('Nothing selected')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Context' })).toBeInTheDocument();
  });

  it('carries the kind, so a page can recognise its own selection', () => {
    render(
      <ContextSelectionProvider>
        <Selector />
      </ContextSelectionProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Select pool-1' }));
    // Not for rendering. For a page asking "is this row mine and selected?"
    // without comparing opaque ids.
    expect(screen.getByRole('status').textContent).toBe('crew-pool:pool-1');
  });

  it('is inert outside the provider rather than throwing', () => {
    /*
     * Deliberate. A component test for a table should not have to mount the
     * whole shell to click a row, and a missing provider is a layout fact rather
     * than a bug in the page. Throwing here would make every page test a shell
     * test.
     */
    render(<Selector />);
    fireEvent.click(screen.getByRole('button', { name: 'Select pool-1' }));
    expect(screen.getByRole('status').textContent).toBe('none');
  });
});
