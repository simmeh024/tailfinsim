import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useUnsavedGuard } from './unsaved';

/**
 * Unsaved work is not thrown away without asking (UX-05).
 *
 * The planner tracked a per-route dirty flag from the day it was built and
 * showed an "Unsaved" chip from it. That was the only thing it did with it:
 * `grep` found no `beforeunload`, no router blocker, and no guard on the in-page
 * tab switch — so editing a rotation and clicking another route lost the edits
 * silently.
 *
 * IMPROVE-04 made that worse rather than leaving it equally bad: Publish now
 * genuinely persists, so a player reasonably believes a draft is saveable.
 */

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Fire a `beforeunload` and report whether anything armed the dialog. */
function unloadArmed(): boolean {
  const event: BeforeUnloadEvent = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(event);
  // Browsers accept either signal and have disagreed about which; a guard that
  // set only one would work in some and not others.
  return event.defaultPrevented || event.returnValue === '';
}

describe('leaving with unsaved work', () => {
  it('asks, and stays put when the answer is no', () => {
    const confirm = vi.fn(() => false);
    vi.stubGlobal('confirm', confirm);

    const { result } = renderHook(() => useUnsavedGuard(true, 'Leave without publishing?'));

    expect(result.current.confirmLeave()).toBe(false);
    // The message names the work. "Are you sure?" gives a player nothing to
    // decide with.
    expect(confirm).toHaveBeenCalledWith('Leave without publishing?');
  });

  it('goes ahead when the answer is yes', () => {
    vi.stubGlobal(
      'confirm',
      vi.fn(() => true),
    );
    const { result } = renderHook(() => useUnsavedGuard(true, 'Leave?'));
    expect(result.current.confirmLeave()).toBe(true);
  });

  it('arms the browser dialog for a reload or a close', () => {
    // The half the app cannot ask about itself.
    renderHook(() => useUnsavedGuard(true, 'Leave?'));
    expect(unloadArmed()).toBe(true);
  });
});

describe('leaving with nothing to lose', () => {
  it('does not ask at all', () => {
    // A guard that asks on every navigation is one people learn to dismiss
    // without reading, which is worse than no guard.
    const confirm = vi.fn(() => true);
    vi.stubGlobal('confirm', confirm);

    const { result } = renderHook(() => useUnsavedGuard(false, 'Leave?'));

    expect(result.current.confirmLeave()).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
  });

  it('lets a reload through', () => {
    renderHook(() => useUnsavedGuard(false, 'Leave?'));
    expect(unloadArmed()).toBe(false);
  });
});

describe('following the dirty flag', () => {
  it('starts asking as soon as there is something to lose', () => {
    // The flag changes on every keystroke that edits a draft, so the guard reads
    // it through a ref rather than re-registering the listener each time. This
    // is the test that the ref is actually kept current.
    const confirm = vi.fn(() => true);
    vi.stubGlobal('confirm', confirm);

    const { result, rerender } = renderHook(
      ({ dirty }: { dirty: boolean }) => useUnsavedGuard(dirty, 'Leave?'),
      { initialProps: { dirty: false } },
    );

    expect(unloadArmed()).toBe(false);
    result.current.confirmLeave();
    expect(confirm).not.toHaveBeenCalled();

    rerender({ dirty: true });

    expect(unloadArmed()).toBe(true);
    result.current.confirmLeave();
    expect(confirm).toHaveBeenCalledTimes(1);
  });

  it('stops asking once the work is saved', () => {
    const confirm = vi.fn(() => true);
    vi.stubGlobal('confirm', confirm);

    const { result, rerender } = renderHook(
      ({ dirty }: { dirty: boolean }) => useUnsavedGuard(dirty, 'Leave?'),
      { initialProps: { dirty: true } },
    );

    rerender({ dirty: false });

    expect(result.current.confirmLeave()).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
    expect(unloadArmed()).toBe(false);
  });

  it('lets go of the listener when it unmounts', () => {
    // Otherwise a page that has been left behind keeps blocking reloads for the
    // rest of the session, which is the kind of bug people report as "the site
    // asks me twice".
    const { unmount } = renderHook(() => useUnsavedGuard(true, 'Leave?'));
    act(() => {
      unmount();
    });
    expect(unloadArmed()).toBe(false);
  });
});
