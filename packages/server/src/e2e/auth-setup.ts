import { mkdir, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { createSession, SESSION_COOKIE } from '../auth/session';
import { createDatabase } from '../db/client';

import { e2eDatabaseUrl, E2E_FIXTURES } from './prepare';

interface StorageState {
  cookies: {
    name: string;
    value: string;
    domain: string;
    path: string;
    expires: number;
    httpOnly: boolean;
    secure: boolean;
    sameSite: 'Lax';
  }[];
  origins: [];
}

const authDirectory = resolve(import.meta.dirname, '../../../../e2e/.auth');
function stateFor(token: string, expiresAt: Date): StorageState {
  return {
    cookies: [
      {
        name: SESSION_COOKIE,
        value: token,
        domain: '127.0.0.1',
        path: '/',
        expires: Math.floor(expiresAt.getTime() / 1_000),
        httpOnly: true,
        secure: false,
        sameSite: 'Lax',
      },
    ],
    origins: [],
  };
}

export default async function globalSetup(): Promise<() => Promise<void>> {
  const previousDatabaseUrl = process.env.DATABASE_URL;
  // Re-run the same guard in global setup before this second E2E connection.
  // The launcher has already migrated the database, but session minting must
  // retain the same safety boundary when setup is invoked on its own.
  process.env.DATABASE_URL = e2eDatabaseUrl();

  const database = createDatabase();
  try {
    // Each run creates fresh opaque tokens. They are never logged, committed or
    // reused across runs; the files only let every test reuse its identity.
    const [playerSession, adminSession] = await Promise.all([
      createSession(database.db, E2E_FIXTURES.player.id, 24),
      createSession(database.db, E2E_FIXTURES.admin.id, 24),
    ]);

    await mkdir(authDirectory, { recursive: true });
    await Promise.all([
      writeFile(
        resolve(authDirectory, 'player.json'),
        JSON.stringify(stateFor(playerSession.token, playerSession.expiresAt)),
        { mode: 0o600 },
      ),
      writeFile(
        resolve(authDirectory, 'admin.json'),
        JSON.stringify(stateFor(adminSession.token, adminSession.expiresAt)),
        { mode: 0o600 },
      ),
    ]);
  } finally {
    await database.close();
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
  }

  return async () => {
    // The tokens are disposable, but leave no credentials behind for a later
    // local run or an artefact collector to discover.
    await rm(authDirectory, { recursive: true, force: true });
  };
}
