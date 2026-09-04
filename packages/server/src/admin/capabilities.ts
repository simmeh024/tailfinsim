/**
 * What an administrator may do (M11-01, §22.1).
 *
 * Until now `admin_grant` was a single boolean and `requireAdmin` the only
 * primitive: every administrator could do everything, and the console's most
 * destructive act — resetting a world, which destroys every airline in it — sat
 * behind the same check as reading the overview. §22.1 asks for roles with
 * **scoped permissions**, and this is the vocabulary they are built from.
 *
 * ## Capabilities, not roles, are what routes check
 *
 * A route names the *capability* it needs; a role is a named bundle of them.
 * That indirection is the whole point: adding a role must never mean editing
 * twenty route registrations, and reading a route must tell you what authority
 * it actually requires rather than which job titles happen to hold it today.
 *
 * ## Read is the floor, not a role
 *
 * Every role can read the console. Support is exactly that floor and nothing
 * more, which makes it the safe default for a new administrator and makes the
 * difference between the roles legible: what each one adds is what it is *for*.
 *
 * `super_admin` is derived from the full list rather than written out, so a
 * capability added below cannot be accidentally unreachable — and
 * `capabilities.test.ts` holds that line, along with the rule that every
 * capability belongs to at least one role.
 */

/**
 * Every capability, in one list.
 *
 * The union type is derived from it, so a route asking for a capability that is
 * not here does not typecheck.
 */
export const ADMIN_CAPABILITIES = [
  // Reading the console.
  'console.read',
  'audit.read',
  'admin.read',
  'player.read',
  'airline.read',
  'world.read',
  'economy.read',
  'npc.read',
  'system.read',

  // Acting on players and their airlines.
  'player.sessions.revoke',
  'airline.identity',

  // The world lifecycle. `world.reset` is separate from the rest of the
  // lifecycle because ADR-0005 makes it destroy every airline in the world —
  // it is not "another status change".
  'world.create',
  'world.lifecycle',
  'world.speed',
  'world.reset',

  // The economy. Publishing a version and pinning a world to one are separate
  // authorities: writing a payload nobody is pinned to changes nothing, and
  // pinning is what moves a live world onto it.
  'economy.publish',
  'economy.pin',

  // Simulation plumbing.
  'event.requeue',
] as const;

export type AdminCapability = (typeof ADMIN_CAPABILITIES)[number];

/** The roles §22.1 names, as they are stored. */
export const ADMIN_ROLES = [
  'support',
  'game_master',
  'economist',
  'world_admin',
  'super_admin',
] as const;

export type AdminRole = (typeof ADMIN_ROLES)[number];

/** Everything that only reads. The floor every role stands on. */
const READ_ONLY: readonly AdminCapability[] = [
  'console.read',
  'audit.read',
  'admin.read',
  'player.read',
  'airline.read',
  'world.read',
  'economy.read',
  'npc.read',
  'system.read',
];

/**
 * What each role may do.
 *
 * `super_admin` is the whole list by construction — see the module note.
 */
export const ROLE_CAPABILITIES: Readonly<Record<AdminRole, readonly AdminCapability[]>> = {
  support: READ_ONLY,
  /** Runs the world for players: sessions, events, and an airline's identity. */
  game_master: [...READ_ONLY, 'player.sessions.revoke', 'airline.identity', 'event.requeue'],
  /** Tunes the economy, and nothing about players or worlds. */
  economist: [...READ_ONLY, 'economy.publish', 'economy.pin'],
  /** Owns the world lifecycle, including the destructive end of it. */
  world_admin: [...READ_ONLY, 'world.create', 'world.lifecycle', 'world.speed', 'world.reset'],
  super_admin: ADMIN_CAPABILITIES,
};

/** Whether a role carries a capability. */
export function roleHasCapability(role: AdminRole, capability: AdminCapability): boolean {
  return ROLE_CAPABILITIES[role].includes(capability);
}

/** Whether a value read back from the database is a role this build knows. */
export function isAdminRole(value: string | null | undefined): value is AdminRole {
  return (
    value !== null && value !== undefined && (ADMIN_ROLES as readonly string[]).includes(value)
  );
}
