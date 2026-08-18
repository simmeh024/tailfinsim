import { eq } from 'drizzle-orm';

import { BOOTSTRAP_ACTOR, grantAdmin, listAdmins, revokeAdmin } from './admin/grants';
import { createDatabase } from './db/client';
import { player, playerIdentity } from './db/schema';

/**
 * `node dist/admin-cli.js` — admin grants from a shell (M1A-01).
 *
 * ## Why a command line at all
 *
 * Someone has to be the first admin, and there is no admin to grant them. Every
 * console route requires a grant, so without this the console could never be
 * entered on a fresh instance. The bootstrap therefore runs where the only
 * credential that matters is already required: a shell on the server.
 *
 * It stays useful afterwards as the recovery path. If the last admin loses
 * access, `revokeAdmin` refusing to remove the last grant is not enough on its
 * own — you still need a way back in that does not go through the console.
 *
 *   list                       who holds a grant
 *   grant --email a@b.c        grant admin, matched on a sign-in identity
 *   grant --player <uuid>      grant admin by player id
 *   revoke --email a@b.c       revoke admin
 *   revoke --player <uuid>
 *
 * Matching on email looks up `player_identity`, which is where the address from
 * the provider lives. It is a *lookup*, not an identity: ADR-0004 is explicit
 * that accounts are matched on the provider subject, and nothing here changes
 * that. The email is simply how a human names the account they mean.
 */

type Command = 'list' | 'grant' | 'revoke';

interface Args {
  command: Command;
  email: string;
  playerId: string;
}

function parseArgs(argv: readonly string[]): Args {
  const [command, ...rest] = argv;
  if (command !== 'list' && command !== 'grant' && command !== 'revoke') {
    throw new Error(`Usage: admin-cli <list|grant|revoke> [--email a@b.c | --player <uuid>]`);
  }

  const args: Args = { command, email: '', playerId: '' };
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    const next = rest[i + 1];
    if (arg === '--email') {
      if (next === undefined) throw new Error('--email needs an address');
      args.email = next;
      i += 1;
    } else if (arg === '--player') {
      if (next === undefined) throw new Error('--player needs a uuid');
      args.playerId = next;
      i += 1;
    } else {
      throw new Error(`unknown option: ${String(arg)}`);
    }
  }

  if (command !== 'list' && !args.email && !args.playerId) {
    throw new Error(`${command} needs --email or --player`);
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const out = (line: string): void => {
    process.stdout.write(`${line}\n`);
  };

  const db = createDatabase();
  try {
    if (args.command === 'list') {
      const admins = await listAdmins(db.db);
      if (admins.length === 0) {
        out('No admins. Grant the first with: admin-cli grant --email you@example.com');
        return;
      }
      out(`${String(admins.length)} admin${admins.length === 1 ? '' : 's'}:`);
      for (const entry of admins) {
        const by = entry.grantedByLabel ?? 'bootstrap';
        out(
          `  ${entry.displayName}  ${entry.playerId}  granted ${entry.grantedAt.toISOString()} by ${by}`,
        );
      }
      return;
    }

    let playerId = args.playerId;
    if (!playerId) {
      const found = await db.db
        .select({ playerId: playerIdentity.playerId })
        .from(playerIdentity)
        .where(eq(playerIdentity.email, args.email))
        .limit(1);
      const id = found[0]?.playerId;
      if (!id) {
        throw new Error(
          `No account with the sign-in address ${args.email}. ` +
            'They have to sign in once before they can be granted anything.',
        );
      }
      playerId = id;
    }

    const named = await db.db
      .select({ displayName: player.displayName })
      .from(player)
      .where(eq(player.id, playerId))
      .limit(1);
    const displayName = named[0]?.displayName ?? playerId;

    if (args.command === 'grant') {
      const { changed } = await grantAdmin(db.db, playerId, BOOTSTRAP_ACTOR);
      out(
        changed
          ? `Granted admin to ${displayName} (${playerId})`
          : `${displayName} was already an admin`,
      );
    } else {
      const { changed } = await revokeAdmin(db.db, playerId, BOOTSTRAP_ACTOR);
      out(
        changed
          ? `Revoked admin from ${displayName} (${playerId})`
          : `${displayName} was not an admin`,
      );
    }
  } finally {
    await db.close();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
