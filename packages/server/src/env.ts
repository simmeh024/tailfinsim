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

export type NodeEnv = 'development' | 'test' | 'production';

export interface ServerEnv {
  nodeEnv: NodeEnv;
  databaseUrl: string;
  databasePoolMax: number;
  logLevel: string;
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

  return {
    nodeEnv: nodeEnv as NodeEnv,
    databaseUrl: required('DATABASE_URL'),
    databasePoolMax: optionalInt('DATABASE_POOL_MAX', 10),
    logLevel: optional('LOG_LEVEL', nodeEnv === 'production' ? 'info' : 'debug'),
  };
}
