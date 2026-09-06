import { z } from 'zod';

import { CabinClass } from './primitives';

/**
 * The service and ancillary catalogue (M8-03, design doc App. D).
 *
 * App. D's one rule, and the reason the whole appendix exists:
 *
 * > **Tier sets the ceiling. Execution decides where you land inside it.**
 *
 * A perfectly executed Tier 2 tops out at 0.42; a badly executed Tier 3 floors
 * at 0.45. The hot meal still wins. That is the design requirement that a basic
 * offering can never beat a luxury one however well run, and it is enforced
 * here rather than trusted: {@link ServiceBalance} in the economy config refuses
 * a ladder whose bands overlap, so a retune cannot ship one.
 *
 * ## What is identity and what is balance
 *
 * This file holds **identity**: which categories exist, how many tiers each
 * ladder has, what a tier is called, and what one tier needs another to be.
 * None of it is a number a designer would tune.
 *
 * Every number — cost per passenger, revenue per passenger, the score band
 * itself, the turnaround delta, the commercial-intensity coefficients — lives in
 * the `service` section of `EconomyConfig`, versioned in `economy_config` and
 * pinned per world. That is the project's standing rule (CLAUDE.md, *"the
 * economy is a database row, not a constant"*), and it applies here with unusual
 * force: the roadmap's own line for this work is *"tune the service tier bands
 * so no two bands overlap after execution is applied"*. A quantity described as
 * something to tune belongs in the payload that can be retuned.
 *
 * ## Why the catalogue is not a third pinned version
 *
 * A world already pins two versions — `economy_config_version` and
 * `aircraft_catalogue_version` — and they are separate because a fare change and
 * an aerodynamics change must not share a number. A service catalogue *could*
 * have been a third, but it is not: an aircraft type is thirty fields of physical
 * fact with entry-into-service dates gating it, while a service tier is a name
 * and four numbers. Splitting the name from the numbers into a separate immutable
 * table would buy nothing and cost a version nobody could explain the difference
 * of. The names live in code, the numbers live in the economy payload, and
 * retuning services is an economy version like retuning anything else.
 *
 * ## What this file deliberately does not do
 *
 * It does not compute **execution** — that is M8-04, from crew service skill,
 * morale, vendor quality and crew-to-passenger ratio — and it does not assemble
 * `ProductScore` from the per-category scores, which is M8-04 as well and needs
 * the per-cabin weights that issue adds. M8-03 stops at: given an execution value
 * between 0 and 1, where inside its band does a tier land, and what does the
 * package cost and earn.
 */

/**
 * The seven categories of App. D.2.
 *
 * Food & beverage is `catering`; the appendix's alcohol policy, welcome drink,
 * hot towels and dine-on-demand timing are rungs of that ladder rather than
 * categories of their own, because they are the same decision made at different
 * levels of spend. Ground & pre-flight is `ground_services`.
 */
export const ServiceCategory = z.enum([
  'catering',
  'baggage_seating',
  'ife_connectivity',
  'amenities',
  'onboard_retail',
  'ground_services',
  'atmosphere',
]);
export type ServiceCategory = z.infer<typeof ServiceCategory>;

/** Every category, in the order App. D.2 introduces them — the order a UI lists. */
export const SERVICE_CATEGORIES: readonly ServiceCategory[] = ServiceCategory.options;

/**
 * One tier of one category: what it is, and what it needs.
 *
 * `requires` is App. D.6's `requires[]`. Most of what a dependency list would
 * have carried is absorbed by the ladder — a tier includes everything below it,
 * so "dine-on-demand needs a hot meal" is simply a higher rung of `catering`.
 * What is left is the genuinely cross-category case, and there is one shipped;
 * see {@link SERVICE_LADDERS}.
 */
export interface ServiceTierDefinition {
  /** Position on its ladder. Tier 0 is always "nothing at all" and always free. */
  readonly tier: number;
  /** What the player is buying, in App. D's own words where it has them. */
  readonly name: string;
  /** Other categories this tier cannot be selected without. */
  readonly requires: readonly { readonly category: ServiceCategory; readonly minTier: number }[];
}

/** A category's tiers, lowest first and contiguous from 0. */
export type ServiceLadder = readonly ServiceTierDefinition[];

const rung = (
  tier: number,
  name: string,
  requires: ServiceTierDefinition['requires'] = [],
): ServiceTierDefinition => ({ tier, name, requires });

/**
 * The ladders.
 *
 * `catering` is quoted from App. D.1's table, which is the only ladder the
 * design doc writes out in full. The other six are built from the options App.
 * D.2 lists, ordered by what they cost — which is the ordering the tier-band
 * rule requires, because a band is a claim that more spend buys more score.
 *
 * The one shipped `requires`: the top of `amenities` — bedding, pyjamas, a
 * turndown — needs `catering` at 3 or better. Not a balance decision but a
 * coherence one: an airline offering a duvet and no food is not a premium
 * product, it is a bug in the configurator. Every other dependency the appendix
 * hints at is a rung rather than a requirement.
 */
export const SERVICE_LADDERS: Readonly<Record<ServiceCategory, ServiceLadder>> = {
  catering: [
    rung(0, 'Nothing at all'),
    rung(1, 'Buy-on-board only'),
    rung(2, 'Complimentary snack & drink'),
    rung(3, 'Hot meal service'),
    rung(4, 'Multi-course, real crockery'),
    rung(5, 'Chef-designed, dine-on-demand'),
  ],
  baggage_seating: [
    rung(0, 'Everything charged for'),
    rung(1, 'Cabin bag included'),
    rung(2, 'Cabin bag and seat selection included'),
    rung(3, 'Checked bag, seat selection and priority boarding included'),
  ],
  ife_connectivity: [
    rung(0, 'None'),
    rung(1, 'Bring your own device streaming'),
    rung(2, 'Seatback screens'),
    rung(3, '4K seatback with power'),
    rung(4, '4K seatback with power and free Wi-Fi'),
  ],
  amenities: [
    rung(0, 'None'),
    rung(1, 'Amenity kit'),
    rung(2, 'Amenity kit and noise-cancelling headphones'),
    rung(3, 'Bedding, pyjamas and slippers', [{ category: 'catering', minTier: 3 }]),
  ],
  onboard_retail: [
    rung(0, 'Nothing sold on board'),
    rung(1, 'Duty-free'),
    rung(2, 'Duty-free and merchandise'),
    rung(3, 'Duty-free, merchandise, scratch cards and raffles'),
  ],
  ground_services: [
    rung(0, 'Nothing'),
    rung(1, 'Dedicated check-in'),
    rung(2, 'Dedicated check-in and fast-track security'),
    rung(3, 'Lounge access'),
    rung(4, 'Lounge access, arrivals lounge and chauffeur transfer'),
  ],
  atmosphere: [
    rung(0, 'Standard cabin'),
    rung(1, 'Mood lighting and boarding music'),
    rung(2, 'Mood lighting, scent and a crew greeting style'),
    rung(3, 'Full scheme with celebration service and kids’ packs'),
  ],
};

/** The highest tier a category offers. */
export function maxTier(category: ServiceCategory): number {
  return SERVICE_LADDERS[category].length - 1;
}

/** A tier's definition, or undefined when the ladder does not go that high. */
export function serviceTier(
  category: ServiceCategory,
  tier: number,
): ServiceTierDefinition | undefined {
  return SERVICE_LADDERS[category][tier];
}

/**
 * One cabin's selection: the tier chosen in each category.
 *
 * Partial, and an absent category means **tier 0** rather than "unset". A
 * package that says nothing about amenities is a package with no amenities,
 * which is a real and common configuration; making the caller write every
 * category out would turn "the budget package" into seven zeroes.
 */
export const ServiceSelection = z.partialRecord(
  ServiceCategory,
  z.number().int().nonnegative().max(16),
);
export type ServiceSelection = z.infer<typeof ServiceSelection>;

/** The tier a selection picks in a category — 0 when it is silent. */
export function selectedTier(selection: ServiceSelection, category: ServiceCategory): number {
  return selection[category] ?? 0;
}

/**
 * A package, as App. D.6 describes it: a per-class selection plus one dial.
 *
 * **Commercial intensity** is App. D.2's scratch-cards-and-raffles lever, 0 to 1:
 * how hard the airline pushes what it sells on board. It raises onboard retail
 * revenue and costs satisfaction, both in proportion to how far it is pushed, and
 * past a threshold it carries a reputation risk. The appendix is explicit that
 * this is *"a legitimate, characterful budget-airline strategy [that] should be
 * fully supported without being optimal"*, which is why it is a dial rather than
 * a tier: the same catalogue selection can be run gently or hard.
 *
 * It is one dial for the package rather than one per cabin, because it describes
 * how the airline behaves, not what a seat includes.
 */
export const ServicePackageContent = z
  .object({
    perClass: z.partialRecord(CabinClass, ServiceSelection),
    commercialIntensity: z.number().min(0).max(1),
  })
  .strict();
export type ServicePackageContent = z.infer<typeof ServicePackageContent>;

/** Why a package cannot be saved as written. */
export const ServiceSelectionProblem = z
  .object({
    cabin: CabinClass,
    category: ServiceCategory,
    tier: z.number().int(),
    /** `unknown_tier` — off the end of the ladder; `requires` — a dependency is unmet. */
    code: z.enum(['unknown_tier', 'requires']),
    message: z.string().min(1),
  })
  .strict();
export type ServiceSelectionProblem = z.infer<typeof ServiceSelectionProblem>;

/**
 * Everything wrong with a package's selections, in cabin then category order.
 *
 * Returns every problem rather than the first, because a configurator that
 * reports one broken row at a time makes the player fix a package by trial.
 */
export function validateServicePackage(content: ServicePackageContent): ServiceSelectionProblem[] {
  const problems: ServiceSelectionProblem[] = [];
  for (const [cabin, selection] of Object.entries(content.perClass) as [
    CabinClass,
    ServiceSelection,
  ][]) {
    for (const category of SERVICE_CATEGORIES) {
      const tier = selectedTier(selection, category);
      const definition = serviceTier(category, tier);
      if (definition === undefined) {
        problems.push({
          cabin,
          category,
          tier,
          code: 'unknown_tier',
          message: `${category} has no tier ${String(tier)}; the ladder stops at ${String(maxTier(category))}.`,
        });
        continue;
      }
      for (const requirement of definition.requires) {
        if (selectedTier(selection, requirement.category) < requirement.minTier) {
          problems.push({
            cabin,
            category,
            tier,
            code: 'requires',
            message: `${definition.name} needs ${requirement.category} at tier ${String(requirement.minTier)} or better.`,
          });
        }
      }
    }
  }
  return problems;
}

/* ---- Route groups (App. D.5) -------------------------------------------- */

/**
 * A named set of the airline's routes that share one service package.
 *
 * App. D.5 says packages are assigned **per route group, not per aircraft** — so
 * *"a single airframe flies a leisure config in the morning and a business
 * config in the evening"* — and then never defines what a route group is. This
 * is the definition M8-03 chose, and it is a decision worth knowing about:
 *
 * A route group is **player-defined**, not inferred. It is a name and a set of
 * that airline's routes, and a route belongs to at most one group. The
 * alternative was to derive groups from each route's segment mix — leisure
 * routes here, business routes there — which reads well until a player wants two
 * products on two leisure routes and the game will not let them. The appendix's
 * own justification for groups is that they *"keep the system from becoming
 * per-flight micromanagement"*, which is an argument about granularity, not about
 * who decides. So the player decides, and the granularity is the group.
 *
 * A route in no group has no package: the airline flies the world's baseline
 * service. That is deliberately not the same as an empty package, which is a
 * package the player wrote and which costs and scores accordingly.
 */
export const RouteGroupName = z.string().trim().min(1).max(60);

/** A service package as the API returns it. */
export const ServicePackageSummary = z
  .object({
    id: z.uuid(),
    name: z.string(),
    content: ServicePackageContent,
    /** How many route groups have this package assigned — a delete is refused above zero. */
    assignedGroups: z.number().int().nonnegative(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .strict();
export type ServicePackageSummary = z.infer<typeof ServicePackageSummary>;

/** A route group as the API returns it, with the routes in it. */
export const RouteGroupSummary = z
  .object({
    id: z.uuid(),
    name: z.string(),
    /** Null when the group exists but has been given no package yet. */
    servicePackageId: z.uuid().nullable(),
    servicePackageName: z.string().nullable(),
    routes: z.array(
      z.object({ routeId: z.uuid(), originIcao: z.string(), destinationIcao: z.string() }).strict(),
    ),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .strict();
export type RouteGroupSummary = z.infer<typeof RouteGroupSummary>;
