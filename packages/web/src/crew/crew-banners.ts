import type { CrewRank } from '@tailfin/shared';

import cabinCrew440 from './assets/banners/v1/cabin-crew-440.webp';
import cabinCrew880 from './assets/banners/v1/cabin-crew-880.webp';
import cabinServiceManager440 from './assets/banners/v1/cabin-service-manager-440.webp';
import cabinServiceManager880 from './assets/banners/v1/cabin-service-manager-880.webp';
import cadet440 from './assets/banners/v1/cadet-440.webp';
import cadet880 from './assets/banners/v1/cadet-880.webp';
import captain440 from './assets/banners/v1/captain-440.webp';
import captain880 from './assets/banners/v1/captain-880.webp';
import firstOfficer440 from './assets/banners/v1/first-officer-440.webp';
import firstOfficer880 from './assets/banners/v1/first-officer-880.webp';
import purser440 from './assets/banners/v1/purser-440.webp';
import purser880 from './assets/banners/v1/purser-880.webp';
import seniorCabinCrew440 from './assets/banners/v1/senior-cabin-crew-440.webp';
import seniorCabinCrew880 from './assets/banners/v1/senior-cabin-crew-880.webp';
import seniorFirstOfficer440 from './assets/banners/v1/senior-first-officer-440.webp';
import seniorFirstOfficer880 from './assets/banners/v1/senior-first-officer-880.webp';
import trainingCaptain440 from './assets/banners/v1/training-captain-440.webp';
import trainingCaptain880 from './assets/banners/v1/training-captain-880.webp';

/**
 * One banner per rank (M5-01).
 *
 * A registry rather than a URL built from the rank string, for the reason
 * `aircraft-visuals.ts` is one: a computed path is a broken image the first time
 * a rank is renamed or an asset is missed, and nothing catches it until someone
 * looks. Here the record is keyed by `CrewRank`, so **adding a rank without a
 * banner is a type error** and the compiler is the thing that notices.
 *
 * ## Two widths, and 880 is native
 *
 * The fleet assets carry 720 and 1440; these carry 440 and 880, because the
 * supplied artwork is 880px wide and there is no honest 1440 to emit. Upscaling
 * would be bytes with no detail in them.
 *
 * ## webp, not the PNGs as supplied
 *
 * The nine source PNGs are 1.82 MB together. Re-encoded at quality 82 they are
 * **229 KB** — an 87% saving for artwork that sits behind a heading. The fleet
 * assets are webp for the same reason.
 *
 * Only the rank on screen is ever fetched: these are separate emitted files, not
 * inlined, so the page costs one image and not nine.
 */

export interface CrewBanner {
  /** Native width. Used as `src`. */
  src: string;
  /** `srcSet`, so a narrow viewport pays half. */
  srcSet: string;
}

function banner(small: string, large: string): CrewBanner {
  return { src: large, srcSet: `${small} 440w, ${large} 880w` };
}

const BANNERS: Record<CrewRank, CrewBanner> = {
  cadet: banner(cadet440, cadet880),
  first_officer: banner(firstOfficer440, firstOfficer880),
  senior_first_officer: banner(seniorFirstOfficer440, seniorFirstOfficer880),
  captain: banner(captain440, captain880),
  training_captain: banner(trainingCaptain440, trainingCaptain880),
  cabin_crew: banner(cabinCrew440, cabinCrew880),
  senior_cabin_crew: banner(seniorCabinCrew440, seniorCabinCrew880),
  purser: banner(purser440, purser880),
  cabin_service_manager: banner(cabinServiceManager440, cabinServiceManager880),
};

export function crewBanner(rank: CrewRank): CrewBanner {
  return BANNERS[rank];
}
