import { z } from 'zod';

/**
 * Fuel regions — the vocabulary of where fuel is dear (M5-07, §9.3, §11).
 *
 * §9.3 says fuel *"prices vary by region"* and §11 puts the whole map on one
 * *"world curve"*. Those two together decide the shape: a region is not a price,
 * it is a **classification** — the thing a station's price is looked up under —
 * so the level can move for everyone at once while a Gulf station stays cheap
 * relative to a European one. That relative ordering is what keeps tankering
 * (§9.3) a live decision during §20's oil shock rather than a solved one.
 *
 * It lives in `@tailfin/shared` for the same reason `HandlerGrade` does: the sim
 * classifies an airport into one, the economy config keys its rates by one, and
 * a client shows the answer. One definition, three readers.
 *
 * ## Six, and why not more
 *
 * The regions are the ones with genuinely different jet fuel economics, not a
 * continent list: refinery and pipeline access, import dependence, and how far
 * the product has to travel to reach the wing. Splitting further — a separate
 * `oceania`, a separate `central_asia` — would add rows to every payload
 * without adding a decision, because nothing downstream would price them
 * differently. Distance from a refinery is real, but at the level of *one
 * airport* it is a station fact rather than a regional one, and that is what the
 * tier fee factor and the per-station spread are for.
 *
 * An airport whose geography the dataset does not record classifies as **no
 * region at all** rather than into a fallback bucket. `EconomyConfig`'s
 * `fuel.defaultStation` is the answer for that case, and always was — it is
 * documented as *"what a station charges when the airport row has nothing of its
 * own"*, which before M5-07 was every airport in the world.
 */
export const FuelRegion = z.enum([
  /** Refinery-dense and pipeline-fed, and the world reference §13.4 was solved at. */
  'europe',
  /** Its own crude, its own refineries, and the cheapest handling of the six. */
  'north_america',
  /** At the well. The floor of the range, and the reason tankering exists. */
  'middle_east',
  /** Import-dependent and long-haul-fed, with Singapore pricing the region. */
  'asia_pacific',
  /** Refining capacity well short of demand, so the product is largely imported. */
  'latin_america',
  /** The dearest: thin pipeline networks and fuel trucked a long way to the ramp. */
  'africa',
]);
export type FuelRegion = z.infer<typeof FuelRegion>;
export const FUEL_REGIONS = FuelRegion.options;
