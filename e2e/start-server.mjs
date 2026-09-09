import { spawn } from 'node:child_process';

const port = process.env.E2E_PORT ?? '3100';
const databaseUrl =
  process.env.E2E_DATABASE_URL ?? 'postgres://tailfin:tailfin_dev@127.0.0.1:5432/tailfin_e2e_test';
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', ...options });
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} ${args.join(' ')} exited with ${signal ?? `code ${code}`}.`));
    });
  });
}

await run(pnpm, ['build:apps']);

const server = spawn(process.execPath, ['packages/server/dist/main.js'], {
  stdio: 'inherit',
  env: {
    ...process.env,
    NODE_ENV: 'test',
    DATABASE_URL: databaseUrl,
    HOST: '127.0.0.1',
    PORT: port,
    WEB_SURFACE: 'app',
    PUBLIC_ORIGIN: `http://127.0.0.1:${port}`,
    ENVIRONMENT_LABEL: 'local',
    // Authentication stays fully enabled in browser tests. The setup mints
    // sessions directly in the disposable database, so no provider is ever
    // called — these credentials exist to make every sign-in button render, and
    // are deliberately not valid anywhere (AUTH-23: CI must not be able to reach
    // a real provider).
    //
    // **Every** provider, not a representative sample. The landing page now
    // renders one button per configured provider, so this env block decides how
    // tall the sign-in card is — and the fold assertions below measure the last
    // button. A provider missing here would test the fold against a shorter card
    // than any real visitor sees, which is the one way that assertion can pass
    // and still be wrong.
    GOOGLE_CLIENT_ID: 'e2e-client.apps.googleusercontent.com',
    GOOGLE_CLIENT_SECRET: 'e2e-client-secret',
    DISCORD_CLIENT_ID: '000000000000000000',
    DISCORD_CLIENT_SECRET: 'e2e-discord-client-secret',
    TWITCH_CLIENT_ID: 'e2eclientid0000000000000000000',
    TWITCH_CLIENT_SECRET: 'e2e-twitch-client-secret',
    SESSION_SECRET: 'e2e-session-secret-that-is-longer-than-thirty-two-characters',
    ALLOW_REGISTRATION: 'false',
  },
});

let stopped = false;
function stop(signal) {
  if (stopped) return;
  stopped = true;
  server.kill(signal);
}

for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => stop(signal));
server.on('error', (error) => {
  throw error;
});
server.on('exit', (code, signal) => {
  process.exitCode = code ?? (signal ? 1 : 0);
});
