import { Component } from 'react';
import { useLocation } from 'react-router';

import { Button } from './Button';
import { StateBlock } from './StateBlock';

import type { ReactNode } from 'react';

/**
 * What a page shows when rendering it throws, instead of the whole app going blank.
 *
 * React unmounts the entire root on an error no boundary catches, and until this
 * existed there was no boundary anywhere in the client. So one page's bug — a
 * stored draft this build cannot read, a document past its size cap — took the
 * rail, the shell and every other page down with it, and kept doing so on every
 * visit for as long as the bad state stayed stored. This catches the error at the
 * page, says so through `StateBlock`, and offers a reload.
 *
 * It sits outside each `Suspense`, so a lazily loaded route whose chunk fails to
 * arrive — the usual shape of a tab left open across a deploy — lands here too.
 * React still reports the error to the console, as it does for any it catches.
 */
class Boundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <section className="page">
        <StateBlock
          kind="broken"
          action={
            <Button
              variant="secondary"
              onClick={() => {
                window.location.reload();
              }}
            >
              Reload
            </Button>
          }
        >
          This page hit an error and could not be shown. The rest of Tailfin still works; reload to
          try this page again.
        </StateBlock>
      </section>
    );
  }
}

/** The boundary, reset when the route changes: leaving a broken page clears it. */
export function PageErrorBoundary({ children }: { children: ReactNode }): ReactNode {
  const { pathname } = useLocation();
  return <Boundary key={pathname}>{children}</Boundary>;
}
