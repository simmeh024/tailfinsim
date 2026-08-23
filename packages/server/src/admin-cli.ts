import { eq } from 'drizzle-orm';

import { adjustAirlineCash } from './admin/cash';
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
 *   cash --airline <uuid> --amount <major> --reason "..."
 *                              adjust an airline's balance (AIR-06)
 *
 * ## Why cash lives here and not in the console
 *
 * The airline support record deliberately has no cash field, and that stays
 * true: money moves only through AIR-06. `cash` does not break that rule — it
 * writes an ordinary immutable movement with its own `admin_adjustment` cause, a
 * reference and an audit row, exactly as a lease deposit does. What it avoids is
 * an HTTP route that creates money, which is worth attacking however well it is
 * guarded. The credential here is a shell on the server.
 *
 * Amounts are in **major units**, because that is what an operator reading the
 * console sees; the ledger stores minor and the conversion happens once, below.
 *
 * Matching on email looks up `player_identity`, which is where the address from
 * the provider lives. It is a *lookup*, not an identity: ADR-0004 is explicit
 * that accounts are matched on the provider subject, and nothing here changes
 * that. The email is simply how a human names the account they mean.
 */

type Command = 'list' | 'grant' | 'revoke' | 'cash';

interface Args {
  command: Command;
  email: string;
  playerId: string;
  airlineId: string;
  /** Major units as typed; converted to minor once, in `main`. */
  amount: string;
  reason: string;
}

function parseArgs(argv: readonly string[]): Args {
  const [command, ...rest] = argv;
  if (command !== 'list' && command !== 'grant' && command !== 'revoke' && command !== 'cash') {
    throw new Error(
      'Usage: admin-cli <list|grant|revoke> [--email a@b.c | --player <uuid>]\n' +
        '       admin-cli cash --airline <uuid> --amount <major> --reason "why"',
    );
  }

  const args: Args = {
    command,
    email: '',
    playerId: '',
    airlineId: '',
    amount: '',
    reason: '',
  };
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
    } else if (arg === '--airline') {
      if (next === undefined) throw new Error('--airline needs a uuid');
      args.airlineId = next;
      i += 1;
    } else if (arg === '--amount') {
      if (next === undefined) throw new Error('--amount needs a number of major units');
      args.amount = next;
      i += 1;
    } else if (arg === '--reason') {
      if (next === undefined) throw new Error('--reason needs a sentence');
      args.reason = next;
      i += 1;
    } else {
      throw new Error(`unknown option: ${String(arg)}`);
    }
  }

  if (command === 'cash') {
    if (!args.airlineId) throw new Error('cash needs --airline <uuid>');
    if (!args.amount) throw new Error('cash needs --amount <major units>');
    // Required, not optional. An adjustment nobody explained is one nobody can
    // review, and the audit row is the only place the why survives.
    if (!args.reason) throw new Error('cash needs --reason "why"');
  } else if (command !== 'list' && !args.email && !args.playerId) {
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

    if (args.command === 'cash') {
      const major = Number(args.amount);
      if (!Number.isFinite(major) || major === 0) {
        throw new Error(`--amount must be a non-zero number, got ${args.amount}`);
      }
      // Two decimal places, like every other minor-unit figure in the game.
      const amountMinor = Math.round(major * 100);

      const result = await adjustAirlineCash(db.db, BOOTSTRAP_ACTOR, {
        airlineId: args.airlineId,
        amountMinor,
        reason: args.reason,
      });
      if (!result.ok) throw new Error(`refused: ${result.code}`);

      out(`adjusted by ${args.amount}; balance is now ${String(result.balanceAfterMinor / 100)}`);
      out(`movement ${result.movementId}, cause admin_adjustment, audited`);
      return;
    }

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
