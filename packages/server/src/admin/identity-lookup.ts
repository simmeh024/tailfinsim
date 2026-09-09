/**
 * Resolving an operator's `--email` onto exactly one player.
 *
 * `admin-cli`'s `grant` and `revoke` let an operator name an account by its
 * sign-in address, because an address is what a human has to hand and a player
 * uuid is not. That is a **lookup**, never an identity: ADR-0004 matches an
 * account on the provider's subject claim, and nothing here changes it.
 *
 * ## Why this refuses instead of picking one
 *
 * `player_identity.email` is not unique and never was. With Google the only
 * provider a person holds one identity, so the address resolved to one row and
 * a `limit(1)` was harmless. AUTH-08 added Discord and then Twitch, and all
 * three report an address, so one human commonly holds several rows carrying
 * the same one — and AUTH-04 decides that a new provider's sign-in does **not**
 * merge onto an account matched by email, so those rows can name different
 * players. An unordered `limit(1)` would then hand admin to whichever account
 * Postgres happened to return first, silently, with the operator unable to tell
 * which of them they had just changed.
 *
 * So the ambiguity that matters is **several players**, not several rows.
 * Several identities resolving to one player is ordinary — that is one person
 * with three sign-ins — and proceeds, because every candidate row names the same
 * account and there is nothing to guess. Several players is refused and named,
 * and `--player <uuid>` is the way through: it bypasses this lookup entirely.
 */

/** One `player_identity` row that matched the address the operator typed. */
export interface IdentityMatch {
  readonly playerId: string;
  /**
   * The provider whose identity carried the address, so the refusal can say
   * *which* sign-in points at each candidate. Deliberately `string` rather than
   * the `auth_provider` enum: the ambiguity this module exists to refuse is the
   * one AUTH-08 creates by adding providers, and a test has to be able to name
   * one the enum does not carry yet. The enum has grown from one value to five
   * since this was written, which is the argument holding rather than expiring.
   */
  readonly provider: string;
}

/**
 * The player the address names, or a thrown refusal saying why it cannot say.
 *
 * Throws rather than returning a result because both outcomes are already
 * terminal for the caller: `admin-cli` prints the message and exits non-zero.
 * The message is the deliverable in the ambiguous case, so it is asserted on
 * directly in `identity-lookup.test.ts`.
 */
export function resolvePlayerIdFromIdentities(
  email: string,
  matches: readonly IdentityMatch[],
): string {
  // Collapse to one entry per player, keeping the providers that pointed at it.
  // Insertion order is the caller's ordering, so a caller that reads the rows
  // with a stable `ORDER BY` gets a stable message.
  const byPlayer = new Map<string, string[]>();
  for (const match of matches) {
    const providers = byPlayer.get(match.playerId);
    if (providers === undefined) {
      byPlayer.set(match.playerId, [match.provider]);
    } else if (!providers.includes(match.provider)) {
      providers.push(match.provider);
    }
  }

  const candidates = [...byPlayer].map(([playerId, providers]) => ({ playerId, providers }));
  const [first, second] = candidates;

  if (first === undefined) {
    throw new Error(
      `No account with the sign-in address ${email}. ` +
        'They have to sign in once before they can be granted anything.',
    );
  }
  // No second candidate: one player, however many identities named it.
  if (second === undefined) return first.playerId;

  const listed = candidates
    .map(({ playerId, providers }) => `  ${playerId}  ${providers.join(', ')}`)
    .join('\n');
  throw new Error(
    `The sign-in address ${email} matches ${String(candidates.length)} accounts:\n` +
      `${listed}\n` +
      'A second provider does not merge onto an existing account, so these are ' +
      'separate players and changing the wrong one would be silent. Re-run with ' +
      '--player <uuid> naming the account you mean.',
  );
}
