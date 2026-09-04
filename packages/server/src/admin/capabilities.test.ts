import { describe, expect, it } from 'vitest';

import { adminRole as adminRoleEnum } from '../db/schema';

import {
  ADMIN_CAPABILITIES,
  ADMIN_ROLES,
  type AdminCapability,
  isAdminRole,
  ROLE_CAPABILITIES,
  roleHasCapability,
} from './capabilities';

/**
 * The administrator capability model (M11-01, §22.1).
 *
 * These hold the properties the rest of the console depends on: that the stored
 * roles and the modelled roles are the same set, that no capability is
 * unreachable, and — the one that matters most — that Support cannot do anything
 * destructive.
 */

describe('roles and the database agree', () => {
  it('stores exactly the roles the model knows', () => {
    expect([...adminRoleEnum.enumValues].sort()).toEqual([...ADMIN_ROLES].sort());
  });

  it('accepts only known roles', () => {
    for (const role of ADMIN_ROLES) expect(isAdminRole(role)).toBe(true);
    // A role from a future build, or none at all, must read as no access.
    expect(isAdminRole('root')).toBe(false);
    expect(isAdminRole(null)).toBe(false);
    expect(isAdminRole(undefined)).toBe(false);
  });
});

describe('the capability model', () => {
  it('gives super_admin every capability', () => {
    for (const capability of ADMIN_CAPABILITIES) {
      expect(roleHasCapability('super_admin', capability)).toBe(true);
    }
  });

  it('leaves no capability unreachable', () => {
    for (const capability of ADMIN_CAPABILITIES) {
      const holders = ADMIN_ROLES.filter((role) => roleHasCapability(role, capability));
      expect(holders.length, `${capability} belongs to no role`).toBeGreaterThan(0);
    }
  });

  it('grants every role the read floor, so the console is legible to all of them', () => {
    for (const role of ADMIN_ROLES) {
      expect(roleHasCapability(role, 'console.read')).toBe(true);
      expect(roleHasCapability(role, 'audit.read')).toBe(true);
    }
  });

  it('never lets Support change anything', () => {
    // The whole point of the role: everything it holds only reads. Any capability
    // that is not a `.read` is a mutation, and Support may hold none of them.
    const mutations = ADMIN_CAPABILITIES.filter((c) => !c.endsWith('.read'));
    for (const capability of mutations) {
      expect(roleHasCapability('support', capability), `support may ${capability}`).toBe(false);
    }
  });

  it('keeps the destructive world reset away from every role but world_admin', () => {
    const holders = ADMIN_ROLES.filter((role) => roleHasCapability(role, 'world.reset'));
    expect(holders.sort()).toEqual(['super_admin', 'world_admin']);
  });

  it('separates the economy from the world lifecycle', () => {
    // An economist tunes the economy and cannot touch worlds; a world admin runs
    // worlds and cannot publish a balance change. That separation is the reason
    // roles exist at all.
    expect(roleHasCapability('economist', 'economy.publish')).toBe(true);
    expect(roleHasCapability('economist', 'world.create')).toBe(false);
    expect(roleHasCapability('world_admin', 'world.create')).toBe(true);
    expect(roleHasCapability('world_admin', 'economy.publish')).toBe(false);
  });

  it('gives the game master the player-facing remedies and nothing structural', () => {
    expect(roleHasCapability('game_master', 'player.sessions.revoke')).toBe(true);
    expect(roleHasCapability('game_master', 'airline.identity')).toBe(true);
    expect(roleHasCapability('game_master', 'world.reset')).toBe(false);
    expect(roleHasCapability('game_master', 'economy.publish')).toBe(false);
  });

  it('lists no capability twice in a role', () => {
    for (const role of ADMIN_ROLES) {
      const held: readonly AdminCapability[] = ROLE_CAPABILITIES[role];
      expect(new Set(held).size, `${role} repeats a capability`).toBe(held.length);
    }
  });
});
