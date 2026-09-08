/*
 * The landing page's only script (LANDING-01, LANDING-06).
 *
 * It drives the fleet carousel and nothing else. Everything on the page works
 * without it — the first aircraft is visible, the sign-in links are ordinary
 * anchors, and no content is rendered here. All this adds is movement.
 *
 * ## A same-origin file, deliberately
 *
 * The edge policy is `script-src 'self'`. An inline `<script>` would need its own
 * `sha256-` hash pinned in the Caddyfile, and `deploy.sh` does not install Caddy
 * config — so every future edit would silently stop working until somebody
 * remembered. The stylesheet learned this the hard way; see ADR-0028.
 *
 * ## No build step
 *
 * Plain ES2020 served as-is, not bundled. The page is a static document outside
 * the Vite client, so a bundler here would mean a second build pipeline for
 * roughly forty lines. If this file ever needs imports or types, that is the
 * moment to reconsider — not before.
 */

(() => {
  'use strict';

  /**
   * Somebody who asked their system not to animate did not mean "except for the
   * carousel". Reduced motion turns off both the auto-advance and the slide
   * transition; the buttons still work, so the content stays reachable — it just
   * never moves on its own.
   */
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

  /** @param {HTMLElement} root */
  function setUpCarousel(root) {
    const track = root.querySelector('.lp-fleet__track');
    const slides = Array.from(root.querySelectorAll('.lp-fleet__slide'));
    const previous = root.querySelector('[data-fleet-prev]');
    const next = root.querySelector('[data-fleet-next]');
    if (track === null || slides.length < 2) return;

    const interval = Number(root.dataset.interval) || 5000;
    let index = 0;
    let timer = null;

    function render() {
      track.style.transform = `translateX(${String(index * -100)}%)`;
      slides.forEach((slide, position) => {
        // `inert` keeps the off-screen slides out of the tab order and out of a
        // screen reader's path. Without it the carousel is a trap: five images
        // and five captions all reachable, only one of them visible.
        const hidden = position !== index;
        slide.toggleAttribute('inert', hidden);
        slide.setAttribute('aria-hidden', hidden ? 'true' : 'false');
      });
    }

    function go(delta) {
      index = (index + delta + slides.length) % slides.length;
      render();
    }

    function stop() {
      if (timer !== null) {
        window.clearInterval(timer);
        timer = null;
      }
    }

    function start() {
      stop();
      if (reduceMotion.matches) return;
      timer = window.setInterval(() => {
        go(1);
      }, interval);
    }

    previous?.addEventListener('click', () => {
      go(-1);
      // Restart rather than merely continue: advancing a moment after somebody
      // pressed a button is the behaviour that makes carousels infuriating.
      start();
    });
    next?.addEventListener('click', () => {
      go(1);
      start();
    });

    // Hold still while it is being read or operated.
    root.addEventListener('mouseenter', stop);
    root.addEventListener('mouseleave', start);
    root.addEventListener('focusin', stop);
    root.addEventListener('focusout', (event) => {
      if (!root.contains(event.relatedTarget)) start();
    });

    // A background tab should not be cycling; it burns battery to animate
    // something nobody is looking at, and it lands the visitor on an arbitrary
    // aircraft when they come back.
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) stop();
      else start();
    });

    reduceMotion.addEventListener('change', start);

    render();
    // The buttons are hidden until this point, so they never appear as controls
    // that do nothing when the script is blocked or still loading.
    root.dataset.ready = 'true';
    start();
  }

  document.querySelectorAll('[data-carousel]').forEach((element) => {
    setUpCarousel(/** @type {HTMLElement} */ (element));
  });

  /**
   * Tidy `?auth_error=` out of the address bar (LANDING-04).
   *
   * The split here is the point. The **server** renders the message, because the
   * funnel must work without JavaScript and an error only some visitors can read
   * is not an error message. This only removes the spent parameter afterwards,
   * which is genuinely optional: without it a refresh resurrects a refusal the
   * player has already read, and the code rides along in any link they copy out
   * of the bar.
   *
   * `replaceState`, not `pushState` — a failed sign-in should not put an extra
   * entry in the back button. The alert stays on screen; only the URL changes.
   *
   * This mirrors what `useAuthError` does inside the application, and for the
   * same reasons. What differs is that there, one hook does both jobs; here they
   * belong to different layers, and each is done by the layer that can.
   */
  const url = new URL(window.location.href);
  if (url.searchParams.has('auth_error')) {
    url.searchParams.delete('auth_error');
    window.history.replaceState(null, '', url.pathname + url.search + url.hash);
  }
})();
