import { useCallback, useEffect, useRef } from 'react';

/**
 * Do not lose somebody's work without asking (UX-05).
 *
 * The planner has tracked a per-route dirty flag since it was built and shown an
 * "Unsaved" chip from it. That was the *only* use of it: no `beforeunload`, no
 * guard on switching route, no guard on switching tab. Edit a rotation, click
 * another route, and the edits were gone with no warning.
 *
 * ## Why this got worse rather than staying equally bad
 *
 * Before IMPROVE-04 the planner's Publish was local-only — nothing was ever
 * saved, so nothing could be lost in a way that surprised anyone. Publish now
 * genuinely persists, which means a player reasonably believes their draft is
 * saveable. Discarding it silently on a click away is a much bigger betrayal of
 * that belief than it was when saving did not exist.
 *
 * ## Two mechanisms, because a player loses work two ways
 *
 * The browser's own `beforeunload` covers a reload, a close and a link out. It
 * is deliberately not configurable — every browser shows its own wording and
 * ignores yours, which is why this takes no message for that half.
 *
 * Everything *inside* the app — changing route, changing tab — the browser knows
 * nothing about, so those ask through {@link useUnsavedGuard}'s `confirmLeave`.
 * The in-page tab switch is the case a router blocker would not catch either,
 * and is the one a player hits most often.
 *
 * ## Not autosave
 *
 * A draft that saves itself needs somewhere to live and a story for conflicts,
 * and that is a bigger decision. A warning is worth having whether or not
 * autosave ever lands, and it is the thing that stops the current behaviour
 * being a trap.
 */

export interface UnsavedGuard {
  /**
   * Ask before discarding, and say whether to go ahead.
   *
   * `true` when there is nothing to lose or the player said yes. Callers wrap
   * the navigation they were about to do:
   *
   * ```ts
   * if (guard.confirmLeave()) setTab(next);
   * ```
   *
   * Deliberately synchronous. `window.confirm` blocks, which is exactly right
   * here — an async confirmation would let the click that triggered it finish
   * first, and the navigation would happen before the answer arrived.
   */
  confirmLeave: () => boolean;
}

/**
 * Guard unsaved work, in the browser and in the app.
 *
 * @param dirty   Whether there is anything to lose right now.
 * @param message What the in-app confirmation asks. It should name the work,
 *                because "Are you sure?" gives a player nothing to decide with.
 */
export function useUnsavedGuard(dirty: boolean, message: string): UnsavedGuard {
  // Read through a ref inside the listener so the handler is registered once
  // rather than re-attached on every keystroke that changes `dirty`.
  const isDirty = useRef(dirty);
  isDirty.current = dirty;

  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent): void => {
      if (!isDirty.current) return;
      // Both, because browsers have disagreed about which one arms the dialog
      // and the older form is still what some of them read.
      event.preventDefault();
      event.returnValue = '';
    };

    window.addEventListener('beforeunload', onBeforeUnload);
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
    };
  }, []);

  const confirmLeave = useCallback(() => {
    if (!isDirty.current) return true;
    return window.confirm(message);
  }, [message]);

  return { confirmLeave };
}
