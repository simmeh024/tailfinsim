import { spawn } from 'node:child_process';

const port = process.env.E2E_PORT ?? '3100';
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
    HOST: '127.0.0.1',
    PORT: port,
    WEB_SURFACE: 'app',
    PUBLIC_ORIGIN: `http://127.0.0.1:${port}`,
    ENVIRONMENT_LABEL: 'local',
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
