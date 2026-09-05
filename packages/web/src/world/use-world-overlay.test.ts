import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fetchWorldMap } from './map-api';
import { OVERLAY_REFRESH_MS, useWorldOverlay } from './use-world-overlay';

import type { WorldMapData } from './map-api';

/**
 * The world does not stop when you stop looking (WORLD-06).
 *
 * The overlay was one `fetch` in a mount effect: no interval, no refetch, no
 * visibility listener. A World page left open on a 2× world showed the world as
 * it was when the tab opened — NPC carriers opened routes, schedules
 * materialised, the player's own routes changed elsewhere, and none of it
 * appeared until you navigated away and back.
 */

vi.mock('./map-api', () => ({ fetchWorldMap: vi.fn() }));

const read = vi.mocked(fetchWorldMap);

function overlay(hubIcao: string): WorldMapData {
  return {
    hubs: [{ position: [8.5622, 50.0379], icao: hubIcao, name: 'Frankfurt' }],
    routes: [],
    traffic: [],
  };
}

/** jsdom's `visibilityState` is read-only, so it is defined over for the test. */
function setVisibility(state: 'visible' | 'hidden'): void {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => state,
  });
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  read.mockReset();
  setVisibility('visible');
});

afterEach(() => {
  vi.useRealTimers();
});

/** Let the mount fetch resolve. */
async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

describe('while the page is open', () => {
  it('reads the overlay once on mount', async () => {
    read.mockResolvedValue(overlay('EDDF'));
    const { result } = renderHook(() => useWorldOverlay());
    await settle();

    expect(read).toHaveBeenCalledTimes(1);
    expect(result.current.hubs[0]?.icao).toBe('EDDF');
  });

  it('reads it again, and shows what changed', async () => {
    read.mockResolvedValueOnce(overlay('EDDF')).mockResolvedValueOnce(overlay('EGLL'));
    const { result } = renderHook(() => useWorldOverlay());
    await settle();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(OVERLAY_REFRESH_MS + 10);
    });

    expect(read).toHaveBeenCalledTimes(2);
    expect(result.current.hubs[0]?.icao).toBe('EGLL');
  });
});

describe('a refresh that fails', () => {
  it('keeps the map that was drawn', async () => {
    // `null` is *unknown*, and the last good overlay is a better answer than an
    // empty one: the alternative is a player watching their whole network
    // vanish for a minute because one request was lost.
    read.mockResolvedValueOnce(overlay('EDDF')).mockResolvedValueOnce(null);
    const { result } = renderHook(() => useWorldOverlay());
    await settle();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(OVERLAY_REFRESH_MS + 10);
    });

    expect(read).toHaveBeenCalledTimes(2);
    expect(result.current.hubs[0]?.icao).toBe('EDDF');
  });

  it('does still take an empty answer, because that one is an answer', async () => {
    // 401 or 409 — no session, or no airline yet. There is genuinely nothing to
    // draw, and `fetchWorldMap` says so with an empty overlay rather than null.
    read
      .mockResolvedValueOnce(overlay('EDDF'))
      .mockResolvedValueOnce({ hubs: [], routes: [], traffic: [] });
    const { result } = renderHook(() => useWorldOverlay());
    await settle();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(OVERLAY_REFRESH_MS + 10);
    });

    expect(result.current.hubs).toHaveLength(0);
  });
});

describe('a tab nobody is looking at', () => {
  it('is not polled', async () => {
    read.mockResolvedValue(overlay('EDDF'));
    renderHook(() => useWorldOverlay());
    await settle();

    setVisibility('hidden');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(OVERLAY_REFRESH_MS * 3);
    });

    // A backgrounded tab spends nothing.
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('catches up the moment it is looked at', async () => {
    read.mockResolvedValue(overlay('EDDF'));
    renderHook(() => useWorldOverlay());
    await settle();

    setVisibility('hidden');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(OVERLAY_REFRESH_MS * 2);
    });
    setVisibility('visible');
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
      await Promise.resolve();
    });

    // Which is also the moment a stale map would first be noticed — waiting out
    // the rest of the interval would show the tab's old world to somebody now
    // looking straight at it.
    expect(read).toHaveBeenCalledTimes(2);
  });
});

describe('a world where nothing has happened', () => {
  it('hands back the same object it did before', async () => {
    // A fresh object each call, deep-equal to the last — which is what a real
    // `fetch` produces. `mockResolvedValue` would hand back one shared object
    // and React would bail out of the re-render on its own, proving nothing.
    read.mockImplementation(() => Promise.resolve(overlay('EDDF')));
    const { result } = renderHook(() => useWorldOverlay());
    await settle();
    const first = result.current;

    await act(async () => {
      await vi.advanceTimersByTimeAsync(OVERLAY_REFRESH_MS + 10);
    });

    // The identity is what the renderer's memos key on. A fresh array every
    // minute would rebuild every layer on a map where nothing had changed.
    expect(read).toHaveBeenCalledTimes(2);
    expect(result.current).toBe(first);
  });
});

describe('a page that has been left', () => {
  it('stops reading', async () => {
    read.mockResolvedValue(overlay('EDDF'));
    const { unmount } = renderHook(() => useWorldOverlay());
    await settle();

    unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(OVERLAY_REFRESH_MS * 3);
    });

    expect(read).toHaveBeenCalledTimes(1);
  });
});
