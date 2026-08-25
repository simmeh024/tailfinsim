import { build } from 'esbuild';

await build({
  entryPoints: ['src/cli.ts'],
  outfile: 'dist/cli.js',
  bundle: true,
  external: ['@gltf-transform/*', 'gltf-validator', 'meshoptimizer', 'zod'],
  platform: 'node',
  target: 'node24',
  format: 'esm',
  sourcemap: true,
  minify: false,
  logLevel: 'info',
});
