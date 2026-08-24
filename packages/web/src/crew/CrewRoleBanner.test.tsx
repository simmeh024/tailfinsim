import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CrewRank } from '@tailfin/shared';

import { CREW_BANNER_ASPECT, crewBanner } from './crew-banners';
import {
  CREW_RANK_LABEL,
  CREW_ROLE_DESCRIPTION,
  CrewRoleBanner,
  rotationOrder,
} from './CrewRoleBanner';

/**
 * The Crew page's rotating role banner.
 *
 * Two properties matter more than the rest and are easy to lose: the rotation
 * must be **weighted by the airline's actual problem** rather than random, and
 * it must **change nothing**. The banner is presentation; a page that altered a
 * headcount because a picture changed would be indefensible, and the test that
 * catches it is cheap.
 */

const ALL_RANKS: readonly CrewRank[] = [
  'cadet',
  'first_officer',
  'senior_first_officer',
  'captain',
  'training_captain',
  'cabin_crew',
  'senior_cabin_crew',
  'purser',
  'cabin_service_manager',
];

function bannerImage(): HTMLImageElement {
  return screen.getByRole('img');
}

describe('the role banner', () => {
  it('has artwork and a description for every rank that exists', () => {
    /*
     * All nine, not the three the page used to show. `crew_rank` already holds
     * the full ladder, and a rank that reaches the UI without artwork is a
     * broken image nobody notices until a player finds it.
     */
    for (const rank of ALL_RANKS) {
      expect(crewBanner(rank).src).toBeTruthy();
      expect(crewBanner(rank).srcSet).toContain('1024w');
      expect(crewBanner(rank).srcSet).toContain('2048w');
      expect(CREW_RANK_LABEL[rank]).toBeTruthy();
      expect(CREW_ROLE_DESCRIPTION[rank]).toBeTruthy();
    }
    expect(rotationOrder([])).toHaveLength(ALL_RANKS.length);
  });

  it('declares the artwork’s own shape, so the box never letterboxes it', () => {
    /*
     * The v2 set is 2048 x 409 for all nine, which is what let the letterbox go.
     * If a v3 arrives at a different shape this pair has to move with it — and
     * the next test is what stops the CSS being forgotten when it does.
     */
    expect(CREW_BANNER_ASPECT).toEqual({ width: 2048, height: 409 });

    render(<CrewRoleBanner reducedMotion />);
    const image = bannerImage();
    expect(image.getAttribute('width')).toBe('2048');
    expect(image.getAttribute('height')).toBe('409');
  });

  it('and the stylesheet agrees with it', () => {
    /*
     * Two places have to know the ratio: the box in CSS and the artwork in TS.
     * Artwork and box drifting apart is exactly the kind of thing nobody notices
     * until a rotation looks wrong — and by then the cause is three files away
     * from the symptom.
     */
    const css = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), '../shell/shell.css'),
      'utf8',
    );
    const declared = /\.crew-banner\s*\{[^}]*aspect-ratio:\s*(\d+)\s*\/\s*(\d+)/.exec(css);
    expect(declared).not.toBeNull();
    expect(Number(declared?.[1])).toBe(CREW_BANNER_ASPECT.width);
    expect(Number(declared?.[2])).toBe(CREW_BANNER_ASPECT.height);
  });

  it('names the rank in the alt text, because that is the only place it exists', () => {
    // The headline is set into the pixels, so there is no visible caption to
    // read. Alt text is how a screen reader learns which rank this is at all.
    render(<CrewRoleBanner priorityRanks={['purser']} reducedMotion />);
    expect(bannerImage().alt).toBe(`Purser. ${CREW_ROLE_DESCRIPTION.purser}`);
  });

  it('leads with the rank the airline has a problem with', () => {
    render(<CrewRoleBanner priorityRanks={['cabin_service_manager']} reducedMotion />);
    // The picture and the number then say the same thing.
    expect(bannerImage().alt).toContain('Cabin Service Manager');
  });

  it('falls back to the default rotation when nothing is wrong', () => {
    render(<CrewRoleBanner reducedMotion />);
    expect(bannerImage().alt).toContain('Captain');
  });

  it('never repeats a rank inside one cycle', () => {
    // A rank that is both short and in training would otherwise appear twice and
    // read as a stutter.
    const order = rotationOrder(['captain', 'captain', 'purser']);
    expect(new Set(order).size).toBe(order.length);
    expect(order.slice(0, 2)).toEqual(['captain', 'purser']);
  });

  it('drops a rank it has no artwork for rather than rendering a broken image', () => {
    // The priority list is derived from server data. A rank the client does not
    // know is a gap in the client, and a gap must not become a 404 on screen.
    const order = rotationOrder(['flight_engineer' as CrewRank, 'purser']);
    expect(order).not.toContain('flight_engineer');
    expect(order[0]).toBe('purser');
  });
});

describe('rotation', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('advances through the order on its own', () => {
    render(
      <CrewRoleBanner
        priorityRanks={['purser', 'cadet']}
        intervalMs={1000}
        reducedMotion={false}
      />,
    );
    expect(bannerImage().alt).toContain('Purser');

    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(bannerImage().alt).toContain('Cadet');
  });

  it('wraps rather than stopping at the end', () => {
    render(<CrewRoleBanner priorityRanks={['purser']} intervalMs={1000} reducedMotion={false} />);
    act(() => {
      // Nine ranks: a full cycle returns to the front.
      vi.advanceTimersByTime(9000);
    });
    expect(bannerImage().alt).toContain('Purser');
  });

  it('stands still under prefers-reduced-motion', () => {
    render(<CrewRoleBanner priorityRanks={['purser', 'cadet']} intervalMs={1000} reducedMotion />);
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    /*
     * One banner, not a faster one. The objection is to unrequested movement,
     * and an element that changes itself while being looked at is movement
     * whether or not it fades.
     */
    expect(bannerImage().alt).toContain('Purser');
  });

  it('stops when unmounted, so a left page keeps no timer running', () => {
    const { unmount } = render(<CrewRoleBanner intervalMs={1000} reducedMotion={false} />);
    unmount();
    expect(() => {
      act(() => {
        vi.advanceTimersByTime(10_000);
      });
    }).not.toThrow();
  });

  it('returns to the front when the airline’s problem changes', () => {
    const { rerender } = render(
      <CrewRoleBanner priorityRanks={['purser']} intervalMs={1000} reducedMotion={false} />,
    );
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(bannerImage().alt).not.toContain('Purser');

    rerender(
      <CrewRoleBanner priorityRanks={['captain']} intervalMs={1000} reducedMotion={false} />,
    );
    /*
     * Without the reset, an airline whose captain shortage resolves keeps
     * showing whichever rank sat at the old index — the one rank it no longer
     * has a reason to see.
     */
    expect(bannerImage().alt).toContain('Captain');
  });

  it('does not restart on an unrelated re-render', () => {
    const { rerender } = render(
      <CrewRoleBanner priorityRanks={['purser']} intervalMs={1000} reducedMotion={false} />,
    );
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    const afterOneStep = bannerImage().alt;

    // A new array with the same contents, as the page above produces on every
    // render. Keying the memo on the reference would reset the rotation for ever.
    rerender(<CrewRoleBanner priorityRanks={['purser']} intervalMs={1000} reducedMotion={false} />);
    expect(bannerImage().alt).toBe(afterOneStep);
  });

  it('changes nothing but itself', () => {
    /*
     * The banner is presentation. Nothing it does may reach the simulation, and
     * the cheapest guard is to prove it makes no requests at all — a rotation
     * that POSTed anything would fail here.
     */
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    render(<CrewRoleBanner intervalMs={500} reducedMotion={false} />);
    act(() => {
      vi.advanceTimersByTime(5000);
    });

    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
