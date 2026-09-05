import { ContextSelectionProvider, useContextSelection } from './context-selection';

import type { ReactNode } from 'react';

/**
 * The context panel, as much of it as a test needs (a test helper).
 *
 * `useContextSelection` is safe outside its provider — it returns a store that
 * accepts selections and drops them — which is right for a table test that
 * should not have to mount the shell. It is exactly wrong for a test *about* a
 * selection, where the page would publish into the void and the assertion would
 * pass whatever happened.
 *
 * So this is the smallest thing that renders one: the provider, the title, the
 * subtitle, the body and a dismissal. `fleet-market-ui.test.tsx` grew its own
 * copy first; this is that idea, shared, so a page's tests and the shell's do
 * not drift apart about what the panel does.
 *
 * Named `test-*` like `test-setup.ts` and `test-gates.ts`, and imported only by
 * tests.
 */
function Panel(): ReactNode {
  const { selection, clear, attachPanelBody } = useContextSelection();
  return (
    <aside aria-label="Context">
      <h2 data-testid="panel-title">{selection?.title ?? 'Context'}</h2>
      {selection?.subtitle !== undefined && (
        <p data-testid="panel-subtitle">{selection.subtitle}</p>
      )}
      {selection !== null && (
        <button
          type="button"
          onClick={() => {
            selection.onClear?.();
            clear();
          }}
        >
          Dismiss panel
        </button>
      )}
      <div data-testid="panel-body">
        {selection === null ? null : selection.body === null ? (
          <div ref={attachPanelBody} />
        ) : (
          selection.body
        )}
      </div>
    </aside>
  );
}

export function ContextPanelProbe({ children }: { children: ReactNode }): ReactNode {
  return (
    <ContextSelectionProvider>
      {children}
      <Panel />
    </ContextSelectionProvider>
  );
}
