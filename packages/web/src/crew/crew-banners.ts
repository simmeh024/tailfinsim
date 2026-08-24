import type { CrewRank } from '@tailfin/shared';

import cabinCrew1024 from './assets/banners/v2/cabin-crew-1024.webp';
import cabinCrew2048 from './assets/banners/v2/cabin-crew-2048.webp';
import cabinServiceManager1024 from './assets/banners/v2/cabin-service-manager-1024.webp';
import cabinServiceManager2048 from './assets/banners/v2/cabin-service-manager-2048.webp';
import cadet1024 from './assets/banners/v2/cadet-1024.webp';
import cadet2048 from './assets/banners/v2/cadet-2048.webp';
import captain1024 from './assets/banners/v2/captain-1024.webp';
import captain2048 from './assets/banners/v2/captain-2048.webp';
import firstOfficer1024 from './assets/banners/v2/first-officer-1024.webp';
import firstOfficer2048 from './assets/banners/v2/first-officer-2048.webp';
import purser1024 from './assets/banners/v2/purser-1024.webp';
import purser2048 from './assets/banners/v2/purser-2048.webp';
import seniorCabinCrew1024 from './assets/banners/v2/senior-cabin-crew-1024.webp';
import seniorCabinCrew2048 from './assets/banners/v2/senior-cabin-crew-2048.webp';
import seniorFirstOfficer1024 from './assets/banners/v2/senior-first-officer-1024.webp';
import seniorFirstOfficer2048 from './assets/banners/v2/senior-first-officer-2048.webp';
import trainingCaptain1024 from './assets/banners/v2/training-captain-1024.webp';
import trainingCaptain2048 from './assets/banners/v2/training-captain-2048.webp';

/**
 * One banner per rank (M5-01, artwork v2).
 *
 * A registry rather than a URL built from the rank string, for the reason
 * `aircraft-visuals.ts` is one: a computed path is a broken image the first time
 * a rank is renamed or an asset is missed, and nothing catches it until someone
 * looks. Here the record is keyed by `CrewRank`, so **adding a rank without a
 * banner is a type error** and the compiler is the thing that notices.
 *
 * ## v2 is uniform, and that is the important part
 *
 * The first set was 880 wide and between 126 and 217 tall, rank by rank. Nine
 * different aspect ratios in one slot meant the box had to be fixed at the
 * tallest and the images letterboxed inside it, so eight of the nine sat in a
 * band of empty surface — the alternative being a page that jumped on every
 * rotation.
 *
 * v2 is **2048 × 409 for all nine**. The box is now exactly the artwork's own
 * ratio, nothing is letterboxed, and the compromise is gone rather than merely
 * hidden. {@link CREW_BANNER_ASPECT} is the single place that ratio is written
 * down; a v3 that changed it would fail the test that checks the CSS agrees.
 *
 * ## Two widths, and 2048 is native
 *
 * The banner renders about 830 CSS pixels wide on a desktop with the context
 * rail open, so 1024 covers a 1× display and 2048 a 2× one. There is no honest
 * third width above the source.
 *
 * ## webp, not the PNGs as supplied
 *
 * The nine source PNGs are 8.7 MB together. Re-encoded at quality 82 the whole
 * set is **890 KB across both widths** — and only the rank on screen is ever
 * fetched, because these are separate emitted files rather than inlined. A visit
 * costs one image, plus one more warmed for the next rotation.
 *
 * Quality 82 rather than lower because the headline is *set into the pixels*:
 * text is what webp gives up first, and a banner whose lettering has gone soft
 * is the one artefact a reader will notice.
 */

export interface CrewBanner {
  /** Native width. Used as `src`. */
  src: string;
  /** `srcSet`, so a 1× display pays a quarter of the pixels. */
  srcSet: string;
}

/** Every banner is this shape. The CSS box and the `<img>` attributes agree with it. */
export const CREW_BANNER_ASPECT = { width: 2048, height: 409 } as const;

function banner(small: string, large: string): CrewBanner {
  return { src: large, srcSet: `${small} 1024w, ${large} 2048w` };
}

const BANNERS: Record<CrewRank, CrewBanner> = {
  cadet: banner(cadet1024, cadet2048),
  first_officer: banner(firstOfficer1024, firstOfficer2048),
  senior_first_officer: banner(seniorFirstOfficer1024, seniorFirstOfficer2048),
  captain: banner(captain1024, captain2048),
  training_captain: banner(trainingCaptain1024, trainingCaptain2048),
  cabin_crew: banner(cabinCrew1024, cabinCrew2048),
  senior_cabin_crew: banner(seniorCabinCrew1024, seniorCabinCrew2048),
  purser: banner(purser1024, purser2048),
  cabin_service_manager: banner(cabinServiceManager1024, cabinServiceManager2048),
};

export function crewBanner(rank: CrewRank): CrewBanner {
  return BANNERS[rank];
}
