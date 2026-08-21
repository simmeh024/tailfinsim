import { screen, waitFor } from '@testing-library/react';

/**
 * The gates a rendered `<App />` puts in front of a page, waited for by name.
 *
 * Every test that renders the whole app meets at least two of these in sequence.
 * `RequireSession` holds a screen until `GET /api/me` answers; only then does the
 * route tree mount, and only then does the page start the fetch its own contents
 * depend on. A test that renders and immediately waits for something on the
 * finished page is putting that whole chain inside one async query's budget.
 *
 * Nothing in it is waiting on I/O — every `fetch` is a stub that has already
 * resolved. What the wait is really waiting for is React's scheduler being given
 * the CPU to commit each render, and on a full-suite run on a loaded machine that
 * has taken longer than the second an async query allows. Three tests lost that
 * race here, and each reported the wrong thing: `lifecycle-ui` said "Unable to
 * find role=button and name Manage Flagship", which reads as a missing control
 * when what had actually happened was a world list that had not arrived yet.
 * It is the flake CLAUDE.md already records against the build badge's clock.
 *
 * Waiting for each gate separately means a budget covers one hop rather than all
 * of them, the lookup that follows can be synchronous, and a failure names the
 * gate that did not open instead of blaming whatever was behind it.
 */

/** `RequireSession`'s holding screen is gone: `/api/me` has answered. */
export async function waitForSignInCheck(): Promise<void> {
  await waitFor(() => {
    if (screen.queryByText('Checking your sign-in…') !== null) {
      throw new Error('the sign-in check has not answered; the route tree has not mounted');
    }
  });
}

/** `IndexRedirect`'s holding screen is gone: `/` has picked a destination. */
export async function waitForLandingChoice(): Promise<void> {
  await waitFor(() => {
    if (screen.queryByText('Checking your airline…') !== null) {
      throw new Error(
        'the landing page has not been chosen; the founding options have not arrived',
      );
    }
  });
}
