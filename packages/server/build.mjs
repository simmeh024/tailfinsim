import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { build } from 'esbuild';

/**
 * Bundles the server into standalone ESM files so the container image needs no
 * node_modules at runtime.
 *
 * TypeScript is the typechecker in this repo, not the compiler
 * (`moduleResolution: bundler` cannot emit runnable Node output) — see
 * ADR-0001. This is the compiler for the server package.
 *
 * Six entry points:
 *   main.js             the server process
 *   migrate.js          a one-off run by the deploy script before main starts
 *   import-airports.js  a one-off run by hand when the dataset moves (M1-01)
 *   classify-airports.js  assigns tiers over the imported set (M1-02)
 *   derive-catchment.js   attaches the demand inputs (M1-03)
 *   build-distance-matrix.js  packs the great-circle matrix (M1-04)
 */
await build({
  entryPoints: [
    'src/main.ts',
    'src/migrate.ts',
    'src/import-airports.ts',
    'src/classify-airports.ts',
    'src/derive-catchment.ts',
    'src/build-distance-matrix.ts',
  ],
  outdir: 'dist',
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  sourcemap: true,
  minify: false, // Readable stack traces matter more than a few hundred KB.
  // `pg` optionally requires the native client, which we do not ship.
  external: ['pg-native'],
  // Several dependencies are CommonJS. Bundling them into ESM output leaves
  // bare `require` calls with nothing to resolve them, so provide one.
  banner: {
    js: [
      "import { createRequire as __createRequire } from 'node:module';",
      'const require = __createRequire(import.meta.url);',
    ].join('\n'),
  },
  logLevel: 'info',
});

/**
 * Stamp the build (M0-12).
 *
 * The build number is `git rev-list --count HEAD` — the number of commits behind
 * the checked-out revision. Not a semantic version: nothing here is released to
 * anyone, so there is no compatibility to promise, and a hand-maintained version
 * would drift the first time somebody forgot to bump it. This one cannot drift,
 * because it is derived rather than declared.
 *
 * It is generated at build time rather than read from git at runtime, because
 * the running server is a bundle that may sit somewhere git knows nothing about.
 *
 * A missing or broken git is not fatal — `pnpm build` has to work in a source
 * tarball too — so it falls back to build 0, which reads as "not a real build"
 * rather than as a plausible wrong number.
 */
function git(args) {
  try {
    return execFileSync('git', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

const count = git(['rev-list', '--count', 'HEAD']);
const commit = git(['rev-parse', '--short', 'HEAD']);
const dirty = git(['status', '--porcelain']) !== '';

const buildInfo = {
  build: Number.parseInt(count, 10) || 0,
  // The suffix matters: a build made from a modified working tree is not the
  // commit it claims to be, and that is exactly the moment you want to know.
  commit: commit === '' ? 'unknown' : dirty ? `${commit}+dirty` : commit,
};

mkdirSync(resolve(import.meta.dirname, 'dist'), { recursive: true });
writeFileSync(
  resolve(import.meta.dirname, 'dist', 'build-info.json'),
  `${JSON.stringify(buildInfo, null, 2)}\n`,
);

// Written directly rather than via console.log: this is build output alongside
// esbuild's own, not application logging, and the lint rule that bans
// console.log in shipped code has no reason to make an exception for it.
process.stdout.write(`  build ${String(buildInfo.build)} (${buildInfo.commit})\n`);
