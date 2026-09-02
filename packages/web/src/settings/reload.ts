/**
 * A one-line indirection over `window.location.reload()` (M8-02).
 *
 * The Settings page refreshes the whole app after saving a new display currency,
 * so every already-mounted view re-renders in it at once. Wrapping the call keeps
 * it mockable — jsdom does not implement `location.reload`, and its property is
 * non-configurable, so a test spies on this instead.
 */
export function reloadPage(): void {
  window.location.reload();
}
