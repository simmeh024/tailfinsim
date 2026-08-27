import { z } from 'zod';

import { AirlineLogo } from './airline-logo';
import { AirportTier, SlotLevel } from './airport';
import { ApiError } from './api';
import { AirlineKind, NpcArchetype } from './npc';
import {
  AirlineIataCode,
  AirlineIcaoCode,
  AirportIdent,
  AirportIataCode,
  AirportIcaoCode,
  CountryCode,
  MinorUnits,
  Reputation,
  Timestamp,
  Uuid,
} from './primitives';

/**
 * The starting point of the reputation scale (§15), not a balance lever.
 *
 * AIR-03 deliberately keeps this out of economy config: changing it would
 * redefine what the 0.00–1.00 scale means rather than retune an economy.
 */
export const INITIAL_AIRLINE_REPUTATION = 0.35 as const;

const AIRLINE_NAME_ALLOWED = /^[\p{L}\p{M}\p{N} '&.,()’-]+$/u;

/**
 * The public display name of an airline (AIR-02).
 *
 * Names are Unicode deliberately: players may write in their own script. NFC
 * is required so visually identical text has one stored representation. The
 * punctuation set is deliberately small and ordinary spaces are the only
 * whitespace; emoji, controls and invisible separators belong nowhere in a
 * leaderboard label.
 */
export const AirlineName = z.string().superRefine((value, context) => {
  const length = [...value].length;
  if (length < 1 || length > 120) {
    context.addIssue({
      code: 'custom',
      message: 'must be between 1 and 120 Unicode characters',
    });
  }
  if (value !== value.normalize('NFC')) {
    context.addIssue({ code: 'custom', message: 'must use Unicode NFC normalization' });
  }
  if (!AIRLINE_NAME_ALLOWED.test(value)) {
    context.addIssue({
      code: 'custom',
      message:
        'may contain only Unicode letters, combining marks, numbers, spaces, apostrophes, ampersands, periods, commas, parentheses and hyphens',
    });
  }
  if (!/\p{L}/u.test(value)) {
    context.addIssue({ code: 'custom', message: 'must contain at least one Unicode letter' });
  }
  if (value.startsWith(' ') || value.endsWith(' ')) {
    context.addIssue({ code: 'custom', message: 'must not start or end with a space' });
  }
  if (value.includes('  ')) {
    context.addIssue({ code: 'custom', message: 'must use single spaces between words' });
  }
});
export type AirlineName = z.infer<typeof AirlineName>;

/**
 * The spoken operational callsign. Unlike the display name this is ASCII on
 * purpose, so every player and later voice/ATC surface can reproduce it.
 */
export const AirlineCallsign = z
  .string()
  .min(2, 'must be at least 2 characters')
  .max(32, 'must be at most 32 characters')
  .regex(
    /^[A-Z0-9]+(?: [A-Z0-9]+)*$/,
    'must use uppercase Latin letters, numbers and single spaces only',
  )
  .refine((value) => /[A-Z]/.test(value), 'must contain at least one uppercase letter');
export type AirlineCallsign = z.infer<typeof AirlineCallsign>;

/** All player-authored identity fields, with one source of deterministic rules. */
export const AirlineIdentity = z.object({
  name: AirlineName,
  iataCode: AirlineIataCode,
  icaoCode: AirlineIcaoCode,
  callsign: AirlineCallsign,
});
export type AirlineIdentity = z.infer<typeof AirlineIdentity>;

/**
 * The lifecycle of an airline record (AIR-09).
 *
 * Restricted airlines remain recoverable and may operate existing commitments,
 * while ceased airlines are retained as read-only world history.
 */
export const AirlineStatus = z.enum(['active', 'restricted', 'ceased']);
export type AirlineStatus = z.infer<typeof AirlineStatus>;

/** States included by live statistics, leaderboards and world-cap accounting. */
export const LIVE_AIRLINE_STATUSES = [
  'active',
  'restricted',
] as const satisfies readonly AirlineStatus[];

/**
 * An airline in one world. Mirrors the `airline` table from M0-06.
 *
 * Usually a player's presence in that world, and since M3-12 not always: NPC
 * carriers are airlines too, in the same table under the same constraints,
 * which is what makes *"NPCs obey exactly the same rules as players"* a
 * structural fact rather than a promise. `kind` says which, and `playerId` is
 * null for exactly the NPCs.
 */
export const Airline = z.object({
  id: Uuid,
  worldId: Uuid,
  /** Null for an NPC carrier, which no person runs. */
  playerId: Uuid.nullable(),
  kind: AirlineKind,
  /** The NPC's behavioural archetype. Null for a player airline. */
  archetype: NpcArchetype.nullable(),

  ...AirlineIdentity.shape,
  baseCountry: CountryCode,

  /** The brand emblem, or null for an airline that has never set one (a default is shown). */
  logo: AirlineLogo.nullable(),

  cash: MinorUnits,
  reputation: Reputation,

  status: AirlineStatus,
  statusChangedAt: Timestamp,
  ceasedAt: Timestamp.nullable(),

  createdAt: Timestamp,
});
export type Airline = z.infer<typeof Airline>;

/**
 * What another player may see (§16: public airline profiles and leaderboards).
 *
 * Derived from `Airline` by picking, rather than being written out again, so a
 * field added to `Airline` cannot silently fail to appear here — and, more
 * importantly, a *private* field cannot silently leak into it. Cash is
 * deliberately absent.
 */
export const PublicAirline = Airline.pick({
  id: true,
  worldId: true,
  name: true,
  iataCode: true,
  icaoCode: true,
  callsign: true,
  baseCountry: true,
  reputation: true,
  status: true,
  statusChangedAt: true,
  ceasedAt: true,
  createdAt: true,
});
export type PublicAirline = z.infer<typeof PublicAirline>;

/**
 * What a player supplies when founding an airline. Server-assigned fields
 * (`id`, `playerId`, `cash`, `reputation`, `createdAt`) are absent on purpose —
 * a client that could set its own starting cash would be a problem, and
 * omitting them from the input type makes that structurally impossible rather
 * than a validation rule someone has to remember.
 */
export const CreateAirlineInput = Airline.pick({
  worldId: true,
  name: true,
  iataCode: true,
  icaoCode: true,
  callsign: true,
  baseCountry: true,
}).extend({
  /** The first hub is chosen at founding and granted without a purchase (App. B.5). */
  hubIdent: AirportIdent,
});
export type CreateAirlineInput = z.infer<typeof CreateAirlineInput>;

/** One airport at which an airline is based. M7-04 adds purchases and facilities. */
export const AirlineHub = z.object({
  id: Uuid,
  airlineId: Uuid,
  airportIdent: AirportIdent,
  /** True only when consumed from the world's free-hub starting allowance. */
  founderGrant: z.boolean(),
  createdAt: Timestamp,
});
export type AirlineHub = z.infer<typeof AirlineHub>;

/** The complete result of AIR-01's one transactional founding operation. */
export const CreateAirlineResponse = z.object({
  airline: Airline,
  hub: AirlineHub,
});
export type CreateAirlineResponse = z.infer<typeof CreateAirlineResponse>;

/** One existing airline used to decide whether `/` opens the game or the founding desk. */
export const AirlineFoundingMembership = Airline.pick({ id: true, worldId: true });
export type AirlineFoundingMembership = z.infer<typeof AirlineFoundingMembership>;

/**
 * An open world's server-owned terms for the founding desk (AIR-07).
 *
 * Starting cash is sent rather than duplicated in the client: it is a pinned
 * economy value, and the balance-in-config invariant applies to display just as
 * much as it applies to the founding write.
 */
export const AirlineFoundingWorld = z.object({
  id: Uuid,
  name: z.string().min(1),
  openingCashMinor: MinorUnits.nonnegative(),
  freeHubAllowance: z.number().int().nonnegative(),
  playerCap: z.number().int().positive().nullable(),
  airlines: z.number().int().nonnegative(),
  availability: z.enum(['available', 'already-founded', 'full']),
});
export type AirlineFoundingWorld = z.infer<typeof AirlineFoundingWorld>;

/** Everything needed to choose a world without exposing the admin world API. */
export const AirlineFoundingOptionsResponse = z.object({
  memberships: z.array(AirlineFoundingMembership),
  worlds: z.array(AirlineFoundingWorld),
});
export type AirlineFoundingOptionsResponse = z.infer<typeof AirlineFoundingOptionsResponse>;

/**
 * A searchable founder-hub candidate.
 *
 * Exact airport fee schedules do not exist yet, so the response does not
 * fabricate one. It states the real acquisition cost (the founder grant makes
 * it zero) and carries a server-authored warning for high-cost/slot-scarce
 * tiers. Later airport-fee work can replace the warning with exact figures.
 */
export const AirlineFoundingAirport = z.object({
  ident: AirportIdent,
  icao: AirportIcaoCode.nullable(),
  iata: AirportIataCode.nullable(),
  name: z.string().min(1),
  city: z.string().min(1).nullable(),
  country: CountryCode,
  tier: AirportTier,
  slotLevel: SlotLevel.nullable(),
  foundingCostMinor: z.literal(0),
  feeWarning: z.string().min(1).nullable(),
});
export type AirlineFoundingAirport = z.infer<typeof AirlineFoundingAirport>;

export const AirlineFoundingAirportListResponse = z.object({
  airports: z.array(AirlineFoundingAirport),
  query: z.string(),
});
export type AirlineFoundingAirportListResponse = z.infer<typeof AirlineFoundingAirportListResponse>;

/**
 * Expected player-context refusals for endpoints that operate on "my airline".
 *
 * These are state responses, not authentication failures: the caller is signed
 * in, but either has no airline in the selected world or has several possible
 * worlds and has not selected one. Clients branch on the stable code rather
 * than matching the message.
 */
export const PlayerAirlineContextError = ApiError.extend({
  code: z.enum([
    'airline_required',
    'active_world_required',
    'invalid_active_world',
    'airline_restricted',
    'airline_ceased',
  ]),
});
export type PlayerAirlineContextError = z.infer<typeof PlayerAirlineContextError>;

export const AirlineCodeKind = z.enum(['iata', 'icao']);
export type AirlineCodeKind = z.infer<typeof AirlineCodeKind>;

/**
 * What the code checker needs while the founding form is still advisory.
 * The final allocation remains the airline insert inside AIR-01's transaction.
 */
export const AirlineCodeAvailabilityInput = AirlineIdentity.pick({
  name: true,
  iataCode: true,
  icaoCode: true,
})
  .extend({ worldId: Uuid })
  .strict();
export type AirlineCodeAvailabilityInput = z.infer<typeof AirlineCodeAvailabilityInput>;

/** The scope and non-reservation semantics every availability result carries. */
export const AirlineCodeAvailabilityAdvisory = z.object({
  scope: z.literal('world'),
  reservation: z.literal('none'),
  realWorldCodes: z.enum(['allowed-if-free', 'reserved']),
  message: z.string().min(1),
});
export type AirlineCodeAvailabilityAdvisory = z.infer<typeof AirlineCodeAvailabilityAdvisory>;

export const AirlineCodeAvailabilityResponse = z.object({
  advisory: AirlineCodeAvailabilityAdvisory,
  iataCode: z.object({
    requested: AirlineIataCode,
    status: z.enum(['available', 'assigned', 'reserved']),
    alternatives: z.array(AirlineIataCode).max(3),
  }),
  icaoCode: z.object({
    requested: AirlineIcaoCode,
    status: z.enum(['available', 'assigned', 'reserved']),
    alternatives: z.array(AirlineIcaoCode).max(3),
  }),
});
export type AirlineCodeAvailabilityResponse = z.infer<typeof AirlineCodeAvailabilityResponse>;

/** A policy or constraint refusal, enriched with current advisory alternatives. */
export const AirlineCodeUnavailableError = ApiError.extend({
  code: z.enum(['iata_code_taken', 'icao_code_taken', 'iata_code_reserved', 'icao_code_reserved']),
  codeKind: AirlineCodeKind,
  submittedCode: z.union([AirlineIataCode, AirlineIcaoCode]),
  alternatives: z.array(z.union([AirlineIataCode, AirlineIcaoCode])).max(3),
  advisory: AirlineCodeAvailabilityAdvisory,
});
export type AirlineCodeUnavailableError = z.infer<typeof AirlineCodeUnavailableError>;

/** The fields a moderation remedy may replace; scarce codes are not renamed here. */
export const ForceRenameAirlineInput = AirlineIdentity.pick({ name: true, callsign: true })
  .extend({
    /** Why the intervention happened, retained in the append-only admin audit log. */
    reason: z.string().trim().min(1, 'is required for the audit log').max(500),
  })
  .strict();
export type ForceRenameAirlineInput = z.infer<typeof ForceRenameAirlineInput>;

export const ForceRenameAirlineResponse = z.object({ airline: Airline, changed: z.boolean() });
export type ForceRenameAirlineResponse = z.infer<typeof ForceRenameAirlineResponse>;

/**
 * The caller's airline and the server-owned terms for changing its identity.
 *
 * A missing airline is a normal 200 response on this discovery endpoint. The
 * mutation itself still uses AIR-05's guarded ownership context.
 */
export const OwnAirlineResponse = z.object({
  airline: Airline.nullable(),
  rebrand: z
    .object({
      costMinor: MinorUnits.positive(),
      mutableFields: z.tuple([
        z.literal('name'),
        z.literal('callsign'),
        z.literal('baseCountry'),
        z.literal('logo'),
      ]),
      immutableFields: z.tuple([
        z.literal('iataCode'),
        z.literal('icaoCode'),
        z.literal('cash'),
        z.literal('reputation'),
      ]),
    })
    .nullable(),
});
export type OwnAirlineResponse = z.infer<typeof OwnAirlineResponse>;

/**
 * The complete player-editable identity replacement.
 *
 * Strictness is a security property here: cash, reputation and scarce codes
 * are rejected rather than silently stripped from a request that tried to set
 * them. AIR-09 owns whether codes can ever be released or reassigned.
 */
export const UpdateOwnAirlineInput = Airline.pick({
  name: true,
  callsign: true,
  baseCountry: true,
})
  .extend({
    /**
     * Optional so a caller that only rebrands the name or callsign need not
     * resend the logo: omitted means "leave the logo as it is", a value replaces
     * it, and `null` clears it back to the default emblem. Provided or not, any
     * change here is the same paid rebrand as a name change.
     */
    logo: AirlineLogo.nullable().optional(),
  })
  .strict();
export type UpdateOwnAirlineInput = z.infer<typeof UpdateOwnAirlineInput>;

/** One paid §15 identity event, or a no-op when the submitted identity is current. */
export const UpdateOwnAirlineResponse = z.object({
  airline: Airline,
  changed: z.boolean(),
  chargedMinor: MinorUnits.nonnegative(),
  identityChangeId: Uuid.nullable(),
});
export type UpdateOwnAirlineResponse = z.infer<typeof UpdateOwnAirlineResponse>;
