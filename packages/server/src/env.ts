import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Environment configuration.
 *
 * Connection config is read from the environment and never hardcoded (M0-05).
 * Missing required values throw rather than falling back to a default, because
 * a server that silently boots against the wrong database is far worse than one
 * that refuses to boot at all.
 *
 * The full documented set lives in `docs/deploy.md`.
 */

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(packageRoot, '..', '..');

let dotEnvLoaded = false;

/**
 * Load the repository-root `.env` if present, once.
 *
 * Local development uses a file; staging and production inject real environment
 * variables and have no `.env` at all, so a missing file is not an error. The
 * path is resolved from this module rather than `process.cwd()` so it works the
 * same whether a script is run from the repo root or from `packages/server`.
 */
function loadDotEnvOnce(): void {
  if (dotEnvLoaded) return;
  dotEnvLoaded = true;

  const envFile = resolve(repoRoot, '.env');
  if (existsSync(envFile)) {
    process.loadEnvFile(envFile);
  }
}

function required(name: string): string {
  loadDotEnvOnce();
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(
      `Missing required environment variable ${name}. ` +
        `Copy .env.example to .env for local development; see docs/deploy.md for the full list.`,
    );
  }
  return value;
}

function optional(name: string, fallback: string): string {
  loadDotEnvOnce();
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value;
}

function optionalInt(name: string, fallback: number): number {
  const raw = optional(name, String(fallback));
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed)) {
    throw new Error(`Environment variable ${name} must be an integer, got ${JSON.stringify(raw)}.`);
  }
  return parsed;
}

/**
 * Strict boolean parsing. Anything unrecognised throws rather than being
 * treated as false — `ALLOW_REGISTRATION=flase` quietly meaning "closed" is
 * survivable, but the same typo on a flag whose safe default is *open* would
 * not be, and one parser for both is easier to trust.
 */
function optionalBool(name: string, fallback: boolean): boolean {
  const raw = optional(name, fallback ? 'true' : 'false').toLowerCase();
  if (raw === 'true' || raw === '1') return true;
  if (raw === 'false' || raw === '0') return false;
  throw new Error(
    `Environment variable ${name} must be true/false (or 1/0), got ${JSON.stringify(raw)}.`,
  );
}

export type NodeEnv = 'development' | 'test' | 'production';

export type WebSurface = 'holding' | 'app';

const WEB_SURFACES = new Set<string>(['holding', 'app']);

export interface ServerEnv {
  nodeEnv: NodeEnv;
  databaseUrl: string;
  databasePoolMax: number;
  logLevel: string;

  /**
   * Which public surface this instance serves at `/`.
   *
   * `holding` serves the coming-soon page; `app` serves the built client.
   *
   * **Defaults to `holding`** — the safe direction. Production and dev run the
   * same code from the same repo, and this is what lets a feature be visible on
   * dev while the front door stays a holding page. Promoting to production is
   * then a config change, not a different build.
   */
  webSurface: WebSurface;

  /**
   * Whether new players may create accounts.
   *
   * **Defaults to `false`** — closed unless explicitly opened. The world is not
   * open yet, and a signup endpoint that is public by default is the kind of
   * thing that gets noticed before you are ready. M0-11 must honour this flag
   * on whatever registration route it adds; until then the real gate is HTTP
   * basic auth on the dev host (see deploy/Caddyfile).
   */
  allowRegistration: boolean;
}

const NODE_ENVS = new Set<string>(['development', 'test', 'production']);

/** Read and validate the environment. Throws on anything missing or malformed. */
export function loadEnv(): ServerEnv {
  const nodeEnv = optional('NODE_ENV', 'development');
  if (!NODE_ENVS.has(nodeEnv)) {
    throw new Error(
      `NODE_ENV must be one of development, test, production — got ${JSON.stringify(nodeEnv)}.`,
    );
  }

  const webSurface = optional('WEB_SURFACE', 'holding');
  if (!WEB_SURFACES.has(webSurface)) {
    throw new Error(`WEB_SURFACE must be one of holding, app — got ${JSON.stringify(webSurface)}.`);
  }

  return {
    nodeEnv: nodeEnv as NodeEnv,
    databaseUrl: required('DATABASE_URL'),
    databasePoolMax: optionalInt('DATABASE_POOL_MAX', 10),
    logLevel: optional('LOG_LEVEL', nodeEnv === 'production' ? 'info' : 'debug'),
    webSurface: webSurface as WebSurface,
    allowRegistration: optionalBool('ALLOW_REGISTRATION', false),
  };
}
