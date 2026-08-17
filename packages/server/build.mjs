import { build } from 'esbuild';

/**
 * Bundles the server into standalone ESM files so the container image needs no
 * node_modules at runtime.
 *
 * TypeScript is the typechecker in this repo, not the compiler
 * (`moduleResolution: bundler` cannot emit runnable Node output) — see
 * ADR-0001. This is the compiler for the server package.
 *
 * Two entry points:
 *   main.js     the server process
 *   migrate.js  a one-off run by the deploy script before main starts
 */
await build({
  entryPoints: ['src/main.ts', 'src/migrate.ts'],
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
