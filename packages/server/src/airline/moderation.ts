import { type AirlineIdentity } from '@tailfin/shared';

/** The judgement fields AIR-02 exposes to a future policy provider. */
export type ModeratedAirlineIdentity = Pick<AirlineIdentity, 'name' | 'callsign'>;
export type ModeratedAirlineIdentityField = keyof ModeratedAirlineIdentity;

export type AirlineIdentityModerationDecision =
  { accepted: true } | { accepted: false; field: ModeratedAirlineIdentityField; reason: string };

/**
 * Policy boundary for public airline text (AIR-02).
 *
 * Deterministic shape rules have already run through the shared Zod schema.
 * This interface owns the judgement that remains: whether otherwise valid text
 * is acceptable in Tailfin's shared world. M13-10 supplies that policy later.
 */
export interface AirlineIdentityModerator {
  review(identity: ModeratedAirlineIdentity): Promise<AirlineIdentityModerationDecision>;
}

/** Explicit permissive default until the UGC policy exists. */
export const permissiveAirlineIdentityModerator: AirlineIdentityModerator = {
  review: () => Promise.resolve({ accepted: true }),
};

export interface AirlineIdentityModerationDependencies {
  identityModerator?: AirlineIdentityModerator;
}

export async function moderateAirlineIdentity(
  identity: ModeratedAirlineIdentity,
  dependencies: AirlineIdentityModerationDependencies = {},
): Promise<AirlineIdentityModerationDecision> {
  return (dependencies.identityModerator ?? permissiveAirlineIdentityModerator).review(identity);
}
