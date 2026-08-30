import { accessSync, constants, existsSync } from 'node:fs';
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
 *
 * ## Why readability is checked and not existence
 *
 * `existsSync` then `loadEnvFile` looks equivalent and is not. Existence needs
 * only a traversable directory, so the check passes for a file owned by someone
 * else — and the load then fails. Worse, Node reports that failure as
 * `ENOENT: no such file or directory`, naming a file that plainly exists.
 *
 * That happened on the server: the app was started as `postgres` while `.env`
 * was `-rw-------` and owned by `tailfin`, and the error sent me looking for a
 * missing file for several minutes. Asking for read permission asks the question
 * the caller actually has.
 *
 * A present-but-unreadable file **warns and continues** rather than throwing.
 * The variables may well have been injected anyway, in which case the server is
 * fine and should boot; and if they were not, `required()` fails immediately
 * afterwards with the name of what is missing. Throwing here would break a
 * working configuration to complain about a file it did not need.
 */
function loadDotEnvOnce(): void {
  if (dotEnvLoaded) return;
  dotEnvLoaded = true;

  const envFile = resolve(repoRoot, '.env');

  try {
    accessSync(envFile, constants.R_OK);
  } catch {
    if (existsSync(envFile)) {
      // Deliberately `console.warn`: this runs before any logger exists, and
      // silence here is what made the original failure so hard to read.
      console.warn(
        `[env] ${envFile} exists but is not readable by this process (uid ${String(process.getuid?.() ?? 'unknown')}). ` +
          'Ignoring it. The server normally runs as the user that owns its checkout — ' +
          'if configuration is missing, that is why.',
      );
    }
    return;
  }

  process.loadEnvFile(envFile);
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

/** Genuinely optional: absent and empty both mean "not set". */
function optionalUndefined(name: string): string | undefined {
  loadDotEnvOnce();
  const value = process.env[name];
  return value === undefined || value === '' ? undefined : value;
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

export type EnvironmentLabel = 'local' | 'dev' | 'production';

const ENVIRONMENT_LABELS = new Set<string>(['local', 'dev', 'production']);

export interface ServerEnv {
  nodeEnv: NodeEnv;
  databaseUrl: string;
  databasePoolMax: number;

  /**
   * How long to wait for a TCP connection to Postgres before giving up.
   *
   * `pg` defaults to 0, meaning **wait forever**. That is the wrong default here:
   * `deploy.sh` polls `/healthz` to decide whether a release came up, and if the
   * database is unreachable in a way that drops packets rather than refusing them
   * — a firewall change, a vanished host — the health check never answers at all.
   * A hung endpoint is worse than an honest 503.
   */
  databaseConnectTimeoutMs: number;

  logLevel: string;

  /**
   * DoS guard: the most requests one client IP may make per window before the
   * edge answers 429 (SEC-HARD-09, ADR-0012). Generous by default — a single
   * player loading the SPA and polling stays far under it — because the purpose
   * is to cap abuse, not to shape normal traffic. Loopback is always exempt, so
   * the worker, local development and the test suite are never limited.
   *
   * Optional so the many hand-built test envs need not carry an operational knob;
   * `loadEnv` always sets it, and `buildApp` supplies the same default when it is
   * absent.
   */
  rateLimitMax?: number;
  /** The window `rateLimitMax` is counted over, in milliseconds. */
  rateLimitWindowMs?: number;

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
   * Which deployment this is, in human terms (M0-12).
   *
   * Deliberately separate from `NODE_ENV`, which is `production` on **both**
   * boxes — dev runs a production build of the same code, and that is the point.
   * `NODE_ENV` says how the code was compiled; this says which door you came in,
   * and it is what the build badge shows so that "dev is ahead of production" is
   * visible rather than inferred.
   */
  environmentLabel: EnvironmentLabel;

  /** Absolute origin this instance is reached on. The OAuth redirect URI is derived from it. */
  publicOrigin: string;

  /**
   * Google OAuth credentials (ADR-0004), and the session signing secret.
   *
   * All three are **optional**, and auth is simply switched off when any is
   * missing. That is deliberate: this code deploys to environments that do not
   * yet have credentials, and a server that refused to boot without them would
   * take the whole site down to add a feature nobody can use yet. `authEnabled`
   * is the single thing routes check.
   */
  googleClientId: string | undefined;
  googleClientSecret: string | undefined;
  sessionSecret: string | undefined;
  authEnabled: boolean;

  /** Player sessions last 30 days; see ADR-0015 for the persistent-world trade-off. */
  sessionTtlHours: number;

  /** Privileged sessions last one operator workday and must be shorter than player sessions. */
  adminSessionTtlHours: number;

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

  // Defaults to `local` rather than to `production`: a box that forgot to say
  // which it is should not claim to be the live one.
  const environmentLabel = optional('ENVIRONMENT_LABEL', 'local');
  if (!ENVIRONMENT_LABELS.has(environmentLabel)) {
    throw new Error(
      `ENVIRONMENT_LABEL must be one of local, dev, production — got ${JSON.stringify(environmentLabel)}.`,
    );
  }

  const googleClientId = optionalUndefined('GOOGLE_CLIENT_ID');
  const googleClientSecret = optionalUndefined('GOOGLE_CLIENT_SECRET');
  const sessionSecret = optionalUndefined('SESSION_SECRET');
  const authEnabled = Boolean(googleClientId && googleClientSecret && sessionSecret);

  // A half-configured auth setup is a trap: it looks enabled and fails at the
  // callback. Say so at boot instead.
  const supplied = [googleClientId, googleClientSecret, sessionSecret].filter(Boolean).length;
  if (supplied > 0 && !authEnabled) {
    throw new Error(
      'Auth is partially configured. GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and SESSION_SECRET ' +
        'must all be set, or all be absent. See docs/adr/0004-google-oauth.md.',
    );
  }

  if (sessionSecret !== undefined && sessionSecret.length < 32) {
    throw new Error('SESSION_SECRET must be at least 32 characters. Try: openssl rand -base64 48');
  }

  const publicOrigin = optional('PUBLIC_ORIGIN', 'http://localhost:3000').replace(/\/+$/, '');
  if (environmentLabel === 'production' && !publicOrigin.startsWith('https://')) {
    throw new Error(
      'ENVIRONMENT_LABEL=production requires an https PUBLIC_ORIGIN so session cookies are Secure.',
    );
  }

  const sessionTtlHours = optionalInt('SESSION_TTL_HOURS', 24 * 30);
  const adminSessionTtlHours = optionalInt('ADMIN_SESSION_TTL_HOURS', 12);
  if (adminSessionTtlHours >= sessionTtlHours) {
    throw new Error('ADMIN_SESSION_TTL_HOURS must be shorter than SESSION_TTL_HOURS.');
  }

  return {
    nodeEnv: nodeEnv as NodeEnv,
    databaseUrl: required('DATABASE_URL'),
    databasePoolMax: optionalInt('DATABASE_POOL_MAX', 10),
    databaseConnectTimeoutMs: optionalInt('DATABASE_CONNECT_TIMEOUT_MS', 5000),
    logLevel: optional('LOG_LEVEL', nodeEnv === 'production' ? 'info' : 'debug'),
    webSurface: webSurface as WebSurface,
    environmentLabel: environmentLabel as EnvironmentLabel,
    publicOrigin,
    googleClientId,
    googleClientSecret,
    sessionSecret,
    authEnabled,
    sessionTtlHours,
    adminSessionTtlHours,
    allowRegistration: optionalBool('ALLOW_REGISTRATION', false),
    rateLimitMax: optionalInt('RATE_LIMIT_MAX', 1200),
    rateLimitWindowMs: optionalInt('RATE_LIMIT_WINDOW_MS', 60_000),
  };
}
