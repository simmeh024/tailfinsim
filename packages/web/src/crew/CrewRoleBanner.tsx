import { useEffect, useMemo, useRef, useState } from 'react';

import type { CrewRank } from '@tailfin/shared';

import { crewBanner } from './crew-banners';

import type { ReactNode } from 'react';

/**
 * The Crew page's one photographic element (M5-01, M5-02).
 *
 * ## Why it rotates, and why it is not a carousel
 *
 * There are nine ranks and one banner slot. A fixed banner would make eight
 * pieces of artwork dead weight and would tell the player, every visit, the same
 * thing about captains. Rotating is the cheap way to let the page have a cast.
 *
 * It is deliberately not a carousel: no dots, no arrows, no auto-advancing
 * content the player might be *reading for information*. Everything on the
 * banner is flavour; nothing in it is a control or a number they need. If it
 * were, moving it would be hostile.
 *
 * ## The words are in the pixels, so there is no overlay
 *
 * Each banner is a finished piece of artwork with its own headline set into the
 * image. An HTML caption on top would say the same thing twice, and it is why
 * `object-fit: cover` is not allowed anywhere near this — a crop eats the text,
 * and rendered *"ommand the aircraft"* once before that was understood.
 *
 * The copy below therefore exists for the **alt text and the live region**, not
 * for a visible layer. That is not a lesser job: the alt text is the only way a
 * screen reader learns the rank at all.
 *
 * ## Nine ratios, one box
 *
 * The artwork is 880 wide and between 126 and 217 tall, rank by rank. Sizing to
 * each image would make the page jump on every rotation, which is exactly the
 * movement this is supposed to avoid. So the box is fixed at the **tallest**
 * ratio and the image is `contain`ed inside it: shorter banners sit centred with
 * a band of surface above and below, and nothing is cropped and nothing shifts.
 *
 * ## Rotation is weighted by the airline's actual problem
 *
 * Purely random rotation is decoration. Given a shortage of captains the page
 * should be showing a captain, because then the picture and the number say the
 * same thing and each makes the other easier to read.
 *
 * This is **presentation only**. {@link CrewRoleBannerProps.priorityRanks} is an
 * ordering hint derived from data the page already holds; nothing here reads or
 * writes simulation state, and a banner has never changed a headcount.
 *
 * ## Reduced motion means one banner, not a faster one
 *
 * `prefers-reduced-motion` stops the rotation entirely and shows the
 * highest-priority role. Not a shorter crossfade — the objection is to
 * unrequested movement, and an element that changes itself while being looked at
 * is movement whether or not it fades.
 *
 * ## Nine images, one request
 *
 * Only the banner on screen is fetched. The next is warmed with a detached
 * `Image()` while the current one is being looked at, rather than eagerly at
 * mount, so a ten-second visit costs one image and not nine — and the decode has
 * happened by the time the crossfade starts.
 */

export const CREW_RANK_LABEL: Record<CrewRank, string> = {
  cadet: 'Cadet',
  first_officer: 'First Officer',
  senior_first_officer: 'Senior First Officer',
  captain: 'Captain',
  training_captain: 'Training Captain',
  cabin_crew: 'Cabin Crew',
  senior_cabin_crew: 'Senior Cabin Crew',
  purser: 'Purser',
  cabin_service_manager: 'Cabin Service Manager',
};

/**
 * What each rank *is*, in one sentence.
 *
 * A record keyed by `CrewRank`, for the reason the banner registry is one:
 * adding a rank without a description is a type error rather than an empty alt
 * attribute nobody notices until it ships.
 */
export const CREW_ROLE_DESCRIPTION: Record<CrewRank, string> = {
  cadet: 'In training for the right-hand seat. Cannot yet operate a flight.',
  first_officer: 'The right-hand seat. Every flight needs one.',
  senior_first_officer: 'A first officer with the hours to cover a captain’s slot.',
  captain: 'Commands the aircraft. Grown over weeks, never bought in a hurry.',
  training_captain: 'Commands, and makes the next captain.',
  cabin_crew: 'One for every fifty seats fitted, by regulation.',
  senior_cabin_crew: 'Experienced cabin crew, able to lead a smaller cabin.',
  purser: 'Leads the cabin from a hundred seats up.',
  cabin_service_manager: 'Runs the cabin on the widebodies.',
};

/** The rotation order when the airline has no particular problem. */
const DEFAULT_ORDER: readonly CrewRank[] = [
  'captain',
  'cabin_crew',
  'first_officer',
  'purser',
  'training_captain',
  'senior_first_officer',
  'senior_cabin_crew',
  'cadet',
  'cabin_service_manager',
];

export interface CrewRoleBannerProps {
  /**
   * Ranks the airline has a live reason to see, most urgent first.
   *
   * Shortages, then training, then whatever else the page can justify. Ranks not
   * listed still appear, after these. An empty array is the ordinary case and
   * means *"nothing to say — rotate"*.
   */
  priorityRanks?: readonly CrewRank[];
  /** Milliseconds per banner. Overridable so a test need not wait ten seconds. */
  intervalMs?: number;
  /**
   * Force the reduced-motion branch.
   *
   * jsdom's `matchMedia` is a stub, so the preference is read through a prop a
   * test can set rather than mocked globally in every suite that renders a page.
   */
  reducedMotion?: boolean;
}

export function CrewRoleBanner({
  priorityRanks = [],
  intervalMs = 10_000,
  reducedMotion,
}: CrewRoleBannerProps): ReactNode {
  /*
   * Joined into a string before memoising. `priorityRanks` is rebuilt on every
   * render of the page above, so a reference-keyed memo would produce a new
   * order every render — and the effect below would reset the rotation to the
   * first banner for ever.
   */
  const priorityKey = priorityRanks.join(',');
  const order = useMemo(
    () => rotationOrder(priorityKey === '' ? [] : (priorityKey.split(',') as CrewRank[])),
    [priorityKey],
  );

  const prefersReduced = usePrefersReducedMotion(reducedMotion);
  const [index, setIndex] = useState(0);

  /*
   * Back to the front whenever the priority changes. Without it, an airline
   * whose captain shortage resolves keeps showing whichever rank happened to sit
   * at the old index — the one rank it no longer has a reason to see.
   */
  useEffect(() => {
    setIndex(0);
  }, [order]);

  useEffect(() => {
    if (prefersReduced || order.length < 2) return undefined;
    const timer = setInterval(() => {
      setIndex((current) => (current + 1) % order.length);
    }, intervalMs);
    return () => {
      clearInterval(timer);
    };
  }, [prefersReduced, order, intervalMs]);

  const rank = order[index] ?? 'captain';
  const next = order[(index + 1) % order.length];
  useWarmImage(prefersReduced ? undefined : next);

  const description = CREW_ROLE_DESCRIPTION[rank];
  const banner = crewBanner(rank);

  return (
    <section className="crew-banner" aria-label="Crew roles">
      {/*
       * Keyed on the rank so React swaps the element rather than mutating one
       * `src`. Mutating would blank the frame to the browser's placeholder for
       * however long the swap takes; a new element lets CSS fade the incoming
       * one in over the outgoing one.
       */}
      <img
        key={rank}
        className="crew-banner__image"
        src={banner.src}
        srcSet={banner.srcSet}
        sizes="(max-width: 720px) 100vw, 880px"
        alt={`${CREW_RANK_LABEL[rank]}. ${description}`}
        width={880}
        height={217}
        loading="eager"
        decoding="async"
      />

      {/*
       * `polite`, never `assertive`: a rank changing is worth knowing if you are
       * already listening and is never worth interrupting anything for. The alt
       * text above carries the same words for the frame itself.
       */}
      <p className="visually-hidden" aria-live="polite">
        {CREW_RANK_LABEL[rank]}. {description}
      </p>
    </section>
  );
}

/**
 * Priority ranks first, in the order given; then the default rotation.
 *
 * Deduplicated, because a rank that is both short and in training would
 * otherwise appear twice in one cycle and read as a stutter. Unknown strings are
 * dropped rather than trusted — the priority list is derived from server data,
 * and a rank the client does not have artwork for must not become a broken
 * image.
 */
export function rotationOrder(priorityRanks: readonly CrewRank[]): readonly CrewRank[] {
  const known = new Set<string>(DEFAULT_ORDER);
  const seen = new Set<CrewRank>();
  const order: CrewRank[] = [];
  for (const rank of [...priorityRanks, ...DEFAULT_ORDER]) {
    if (!known.has(rank) || seen.has(rank)) continue;
    seen.add(rank);
    order.push(rank);
  }
  return order;
}

function usePrefersReducedMotion(override?: boolean): boolean {
  const [matches, setMatches] = useState(() => {
    if (override !== undefined) return override;
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  });

  useEffect(() => {
    if (override !== undefined) {
      setMatches(override);
      return undefined;
    }
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return undefined;

    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    setMatches(query.matches);
    const onChange = (event: MediaQueryListEvent): void => {
      setMatches(event.matches);
    };
    /*
     * Subscribed rather than read once. The preference can change while the page
     * is open — a system setting, or a browser extension — and a rotation that
     * carries on after it does is the entire complaint.
     */
    query.addEventListener('change', onChange);
    return () => {
      query.removeEventListener('change', onChange);
    };
  }, [override]);

  return matches;
}

/** Decode the next banner off-screen, so the crossfade has something to fade to. */
function useWarmImage(rank: CrewRank | undefined): void {
  const warmed = useRef(new Set<CrewRank>());

  useEffect(() => {
    if (rank === undefined || warmed.current.has(rank)) return;
    if (typeof Image !== 'function') return;
    // Remembered, so a rotation that comes round again does not re-request or
    // re-decode what the cache already holds.
    warmed.current.add(rank);
    const image = new Image();
    image.srcset = crewBanner(rank).srcSet;
    image.src = crewBanner(rank).src;
  }, [rank]);
}
