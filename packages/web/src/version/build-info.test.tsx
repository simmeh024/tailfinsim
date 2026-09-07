import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { clearBuildInfoCache, useBuildInfo } from './BuildBadge';

import type { ReactNode } from 'react';

/**
 * The build is read once per page load, however many badges ask (PERF-01).
 *
 * Two badges are on screen together on more surfaces than it looks — the
 * sign-in wall renders one while it resolves the session and the login page
 * renders another behind it — so an unauthenticated visit made **two**
 * identical `/api/version` requests before the player had done anything. This
 * is the kind of thing a render assertion never notices, so it is asserted on
 * the request count directly.
 */

function Reader(): ReactNode {
  const info = useBuildInfo();
  return <span>{info === null ? 'pending' : `build ${String(info.build)}`}</span>;
}

const BODY = {
  build: 814,
  commit: 'abc1234',
  environment: 'dev',
  serverTime: '2027-03-10T00:00:00.000Z',
};

afterEach(() => {
  clearBuildInfoCache();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('reading the build', () => {
  it('asks the server once however many badges mount', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(BODY) }),
    );
    vi.stubGlobal('fetch', fetchMock);

    render(
      <MemoryRouter>
        <Reader />
        <Reader />
        <Reader />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getAllByText('build 814')).toHaveLength(3);
    });
    const versionCalls = fetchMock.mock.calls.filter(([url]) => String(url) === '/api/version');
    expect(versionCalls).toHaveLength(1);
  });

  /**
   * A failure is not cached.
   *
   * The one time this matters is a server that was briefly unreachable: caching
   * the `null` would make one bad moment permanent for the life of the page,
   * which is worse than the duplicate request the cache exists to remove.
   */
  it('tries again after a failed read', async () => {
    let attempt = 0;
    const fetchMock = vi.fn(() => {
      attempt += 1;
      return attempt === 1
        ? Promise.resolve({ ok: false, status: 503, json: () => Promise.resolve({}) })
        : Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(BODY) });
    });
    vi.stubGlobal('fetch', fetchMock);

    const first = render(
      <MemoryRouter>
        <Reader />
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    expect(screen.getByText('pending')).toBeInTheDocument();
    first.unmount();

    render(
      <MemoryRouter>
        <Reader />
      </MemoryRouter>,
    );
    expect(await screen.findByText('build 814')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  /** A body whose shape has moved is not an answer, and is not cached as one. */
  it('treats an unshaped body as no answer', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ build: 'soon' }) }),
    );
    vi.stubGlobal('fetch', fetchMock);

    render(
      <MemoryRouter>
        <Reader />
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    expect(screen.getByText('pending')).toBeInTheDocument();
  });
});
