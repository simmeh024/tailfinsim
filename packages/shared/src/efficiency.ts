import { z } from 'zod';

/**
 * §10.4's six efficiency quantities, and where a boost to one may come from
 * (M9-04, M9-05, M9-06).
 *
 * ## Why this file exists separately from `crew-skills.ts`
 *
 * `BoostCeiling` there is the **four** quantities a skill point can reach —
 * deliberately not `blockTime`, which §10.3 puts under research doctrine rather
 * than under a person, and not `serviceCost`, which is App. D's. Research
 * reaches all six, so the airline-wide vocabulary needs its own name rather than
 * a widened skill enum that would let a branch definition name a ceiling no
 * person may touch.
 *
 * The keys are the keys of `EconomyConfig.boosts.ceilings`, in the same order,
 * and a test holds the two together: a seventh ceiling that arrived in the
 * config without arriving here would be a quantity nothing could ever resolve.
 *
 * ## What a boost may never be
 *
 * §10.4's second rule, and the reason every name below is a cost or a duration:
 * *"Boosts are **operational efficiency**, never demand or money directly. They
 * make you cheaper and faster, not more popular."* There is no
 * `demandCapture`, no `priceTolerance` and no `reputation` here, and adding one
 * would be a redesign of §10.4 rather than an extension of this file.
 */
export const EfficiencyQuantity = z.enum([
  'fuelBurn',
  'turnaroundTime',
  'blockTime',
  'maintenanceCost',
  'incidentRate',
  'serviceCost',
]);
export type EfficiencyQuantity = z.infer<typeof EfficiencyQuantity>;
export const EFFICIENCY_QUANTITIES = EfficiencyQuantity.options;

/**
 * Where a boost comes from.
 *
 * §10.4's first rule names four sources — *"Stacking academy + research +
 * personal skill + Training Captain never exceeds the ceiling"* — and three of
 * them are here. The **academy is not a source**, and that is §10's own core
 * rule rather than an omission: *"Academy level gates the ceiling. It does not
 * grant the boost."* A building's whole contribution is permission — the
 * research tier it opens (M9-05), the Training Captains it may make (M9-04) and
 * the research points its levels generate — and every one of those arrives here
 * through one of the three sources below. A fourth key that was always empty
 * would read as a missing mechanic.
 *
 *   - `skills` — §10.2's personal skill points, on every named member who is not
 *     a Training Captain (M9-03).
 *   - `trainingCaptains` — the same points on a Training Captain, at their
 *     reduced line contribution (M9-04).
 *   - `doctrine` — completed research, at whatever strength its upkeep has kept
 *     it (M9-05, M9-06).
 */
export const BoostSource = z.enum(['skills', 'trainingCaptains', 'doctrine']);
export type BoostSource = z.infer<typeof BoostSource>;
export const BOOST_SOURCES = BoostSource.options;

/** Plain-language names for the readout. Design, not balance. */
export const EFFICIENCY_QUANTITY_LABELS: Record<EfficiencyQuantity, string> = {
  fuelBurn: 'Fuel burn',
  turnaroundTime: 'Turnaround time',
  blockTime: 'Block time',
  maintenanceCost: 'Maintenance cost',
  incidentRate: 'Incident and delay rate',
  serviceCost: 'Service cost',
};

// ---------------------------------------------------------------------------
// The wire contract
// ---------------------------------------------------------------------------

/**
 * One quantity, resolved: what every source would give alone, what they give
 * together, and what the ceiling let through.
 *
 * Both `uncapped` and `fraction` are sent so the interface can say the one thing
 * a player most needs to hear about a ceiling — *"another boost here buys you
 * nothing"* — rather than showing a bar that has silently stopped moving.
 */
export const EfficiencyQuantityReadout = z
  .object({
    quantity: EfficiencyQuantity,
    /** §10.4's ceiling for this quantity, from the world's own economy config. */
    ceiling: z.number().min(0).max(1),
    /** Every source stacked multiplicatively, before the ceiling. */
    uncapped: z.number().min(0).max(1),
    /** What is actually removed: `min(uncapped, ceiling)`. */
    fraction: z.number().min(0).max(1),
    /** True when the ceiling clipped it. */
    capped: z.boolean(),
    /** Each source's own stack, alone and before the ceiling. Does not sum to `uncapped`. */
    bySource: z
      .object({
        skills: z.number().min(0).max(1),
        trainingCaptains: z.number().min(0).max(1),
        doctrine: z.number().min(0).max(1),
      })
      .strict(),
  })
  .strict();
export type EfficiencyQuantityReadout = z.infer<typeof EfficiencyQuantityReadout>;
