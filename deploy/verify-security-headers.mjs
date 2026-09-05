import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'sha256-ftYZ6VWMqcx4KWcJ2/G2tKyA+X9oEaozaSrupOVb8KM='; img-src 'self' data: https://lh3.googleusercontent.com; connect-src 'self'; frame-ancestors 'none'; form-action 'self'; base-uri 'none'; object-src 'none'";
const PERMISSIONS_POLICY =
  'accelerometer=(), autoplay=(), camera=(), display-capture=(), encrypted-media=(), fullscreen=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), midi=(), payment=(), picture-in-picture=(), publickey-credentials-get=(), screen-wake-lock=(), usb=(), web-share=(), xr-spatial-tracking=()';
const COMMON_HEADERS = new Map([
  ['strict-transport-security', 'max-age=31536000; includeSubDomains'],
  ['x-content-type-options', 'nosniff'],
  ['referrer-policy', 'strict-origin-when-cross-origin'],
  ['x-frame-options', 'DENY'],
  ['permissions-policy', PERMISSIONS_POLICY],
]);
const DEV_ROBOTS = 'noindex, nofollow, noarchive';
const here = dirname(fileURLToPath(import.meta.url));
const caddyfile = resolve(here, 'Caddyfile');
const holdingPage = resolve(here, '..', 'packages', 'web', 'holding', 'index.html');

function verifyHoldingStyleHash() {
  const html = readFileSync(holdingPage, 'utf8');
  const styles = [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)];
  if (styles.length !== 1) {
    throw new Error(`Expected exactly one inline holding-page style, found ${styles.length}`);
  }
  const hash = `sha256-${createHash('sha256').update(styles[0][1]).digest('base64')}`;
  if (!CSP.includes(`style-src 'self' '${hash}'`)) {
    throw new Error(`The holding-page style hash is stale; expected CSP to include ${hash}`);
  }
}

function parseArguments(argv) {
  const result = { mode: 'enforced', integration: null, urls: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--') continue;
    if (argument === '--mode') {
      result.mode = argv[index + 1];
      index += 1;
    } else if (argument === '--integration') {
      result.integration = argv[index + 1];
      index += 1;
    } else {
      result.urls.push(argument);
    }
  }

  if (!['enforced', 'report-only'].includes(result.mode)) {
    throw new Error('--mode must be enforced or report-only');
  }
  if (result.integration === undefined) {
    throw new Error('--integration requires the path to a Caddy executable');
  }
  return result;
}

function expectedCspHeader(mode) {
  return mode === 'report-only' ? 'content-security-policy-report-only' : 'content-security-policy';
}

/**
 * The edge half of ADR-0025's second fact: no CORS, anywhere.
 *
 * The application asserts its own half in `security/csrf.test.ts`, but Caddy
 * owns browser-side policy for static assets, API responses and error responses
 * alike, and a `header Access-Control-Allow-Origin *` added here would be
 * invisible to every test in `packages/`. Sent with a hostile `Origin` because
 * a permissive rule that echoes the request is the one worth catching.
 */
async function verifyNoCors(url, failures) {
  const response = await fetch(url, {
    redirect: 'manual',
    headers: { origin: 'https://tailfinsim.com.evil.example' },
  });
  for (const [name] of response.headers) {
    if (name.toLowerCase().startsWith('access-control-')) {
      failures.push(
        `${name}: expected absent — ADR-0025 treats the absence of CORS as one of the four ` +
          'facts that replace a CSRF token. Amend the ADR in the same change (see SEC-HARD-08).',
      );
    }
  }
}

async function verifyUrl(url, { mode, dev = false }) {
  const response = await fetch(url, { redirect: 'manual' });
  const failures = [];
  await verifyNoCors(url, failures);

  for (const [name, expected] of COMMON_HEADERS) {
    const actual = response.headers.get(name);
    if (actual !== expected)
      failures.push(`${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }

  const cspHeader = expectedCspHeader(mode);
  const otherCspHeader = expectedCspHeader(mode === 'enforced' ? 'report-only' : 'enforced');
  const actualCsp = response.headers.get(cspHeader);
  if (actualCsp !== CSP) {
    failures.push(
      `${cspHeader}: expected ${JSON.stringify(CSP)}, got ${JSON.stringify(actualCsp)}`,
    );
  }
  if (response.headers.has(otherCspHeader)) {
    failures.push(`${otherCspHeader}: expected absent during ${mode} mode`);
  }
  if (response.headers.has('server'))
    failures.push('server: expected the implementation header to be removed');

  const robots = response.headers.get('x-robots-tag');
  if (dev && robots !== DEV_ROBOTS) {
    failures.push(
      `x-robots-tag: expected ${JSON.stringify(DEV_ROBOTS)}, got ${JSON.stringify(robots)}`,
    );
  }
  if (!dev && robots !== null) failures.push('x-robots-tag: expected absent outside dev');

  if (failures.length > 0) {
    throw new Error(`${url} (${response.status})\n  ${failures.join('\n  ')}`);
  }
  process.stdout.write(`security headers ok: ${url} (${mode}, ${response.status})\n`);
}

function listen(server) {
  return new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolveListen();
    });
  });
}

function close(server) {
  return new Promise((resolveClose, reject) => {
    server.close((error) => (error ? reject(error) : resolveClose()));
  });
}

async function unusedPort() {
  const reservation = createServer();
  await listen(reservation);
  const address = reservation.address();
  if (address === null || typeof address === 'string')
    throw new Error('Could not reserve a TCP port');
  await close(reservation);
  return address.port;
}

function stop(child) {
  if (child.exitCode !== null) return Promise.resolve();
  return new Promise((resolveStop) => {
    child.once('exit', resolveStop);
    child.kill();
  });
}

async function waitUntilReady(url, child, output) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Caddy exited before it was ready\n${output()}`);
    try {
      await fetch(url);
      return;
    } catch {
      await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    }
  }
  throw new Error(`Caddy did not become ready at ${url}\n${output()}`);
}

async function runCaddyMode(caddy, upstreamPort, mode) {
  const productionPort = await unusedPort();
  const devPort = await unusedPort();
  const wwwPort = await unusedPort();
  let output = '';
  const child = spawn(caddy, ['run', '--config', caddyfile], {
    env: {
      ...process.env,
      TAILFIN_PRODUCTION_SITE: `http://127.0.0.1:${productionPort}`,
      TAILFIN_DEV_SITE: `http://127.0.0.1:${devPort}`,
      TAILFIN_WWW_SITE: `http://127.0.0.1:${wwwPort}`,
      TAILFIN_PRODUCTION_UPSTREAM: `127.0.0.1:${upstreamPort}`,
      TAILFIN_DEV_UPSTREAM: `127.0.0.1:${upstreamPort}`,
      ...(mode === 'report-only'
        ? { TAILFIN_CSP_HEADER: 'Content-Security-Policy-Report-Only' }
        : {}),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => (output += chunk.toString()));
  child.stderr.on('data', (chunk) => (output += chunk.toString()));

  const productionUrl = `http://127.0.0.1:${productionPort}/`;
  const devUrl = `http://127.0.0.1:${devPort}/`;
  try {
    await waitUntilReady(productionUrl, child, () => output);
    await verifyUrl(productionUrl, { mode });
    await verifyUrl(`${productionUrl}missing`, { mode });
    await verifyUrl(devUrl, { mode, dev: true });
    await verifyUrl(`${devUrl}missing`, { mode, dev: true });
  } finally {
    await stop(child);
  }
}

async function runIntegration(caddy) {
  const upstream = createServer((request, response) => {
    response.statusCode = request.url === '/missing' ? 404 : 200;
    response.setHeader('content-type', 'text/plain');
    response.end('Tailfin Caddy security-header fixture');
  });
  await listen(upstream);
  const address = upstream.address();
  if (address === null || typeof address === 'string')
    throw new Error('Could not start the fixture server');

  try {
    await runCaddyMode(caddy, address.port, 'report-only');
    await runCaddyMode(caddy, address.port, 'enforced');
  } finally {
    await close(upstream);
  }
}

const arguments_ = parseArguments(process.argv.slice(2));
verifyHoldingStyleHash();
if (arguments_.integration !== null) {
  await runIntegration(resolve(arguments_.integration));
} else {
  if (arguments_.urls.length === 0) {
    throw new Error('Pass one or more running-server URLs, or --integration <caddy>');
  }
  for (const url of arguments_.urls) {
    const hostname = new URL(url).hostname;
    await verifyUrl(url, { mode: arguments_.mode, dev: hostname === 'dev.tailfinsim.com' });
  }
}
