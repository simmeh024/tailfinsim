const DATABASE_VARIABLES = ['DATABASE_URL', 'E2E_DATABASE_URL'] as const;
const DEPLOYMENT_ENVIRONMENTS = new Set(['dev', 'production']);

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === '') {
    throw new Error(`${name} is required for the post-deploy browser smoke.`);
  }
  return value.trim();
}

function readBaseUrl(): string {
  const raw = required('POST_DEPLOY_BASE_URL');
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`POST_DEPLOY_BASE_URL must be an absolute URL — got ${JSON.stringify(raw)}.`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`POST_DEPLOY_BASE_URL must use HTTP(S) — got ${JSON.stringify(url.protocol)}.`);
  }
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '') {
    throw new Error('POST_DEPLOY_BASE_URL must name an origin, without a path, query or fragment.');
  }
  return url.origin;
}

function readExpectedCommit(): string {
  const commit = required('POST_DEPLOY_EXPECTED_COMMIT').toLowerCase();
  if (!/^[0-9a-f]{7,40}$/.test(commit)) {
    throw new Error(
      `POST_DEPLOY_EXPECTED_COMMIT must be a 7–40 character Git SHA — got ${JSON.stringify(commit)}.`,
    );
  }
  return commit;
}

function readExpectedEnvironment(): 'dev' | 'production' {
  const environment = required('POST_DEPLOY_EXPECTED_ENVIRONMENT');
  if (!DEPLOYMENT_ENVIRONMENTS.has(environment)) {
    throw new Error(
      `POST_DEPLOY_EXPECTED_ENVIRONMENT must be dev or production — got ${JSON.stringify(environment)}.`,
    );
  }
  return environment as 'dev' | 'production';
}

function rejectDatabaseAccess(): void {
  for (const variable of DATABASE_VARIABLES) {
    if (process.env[variable] !== undefined && process.env[variable] !== '') {
      throw new Error(
        `${variable} must be unset: post-deploy smoke tests never access PostgreSQL.`,
      );
    }
  }
}

// A test that creates fixtures or mints sessions belongs in e2e/, not here.
// Rejecting connection variables makes the no-database guarantee executable,
// rather than a convention a future configuration can accidentally bypass.
rejectDatabaseAccess();

export const postDeploySmoke = {
  baseUrl: readBaseUrl(),
  expectedCommit: readExpectedCommit(),
  expectedEnvironment: readExpectedEnvironment(),
} as const;

/** All browser-originated traffic in this suite is constrained to these verbs. */
export const POST_DEPLOY_SAFE_METHODS = new Set(['GET', 'HEAD']);
