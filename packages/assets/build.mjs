import { build } from 'esbuild';

await build({
  entryPoints: ['src/cli.ts', 'src/meshy-cli.ts', 'src/meshy-run-cli.ts'],
  outdir: 'dist',
  bundle: true,
  external: ['@gltf-transform/*', 'gltf-validator', 'meshoptimizer', 'sharp', 'watlas', 'zod'],
  platform: 'node',
  target: 'node24',
  format: 'esm',
  sourcemap: true,
  minify: false,
  logLevel: 'info',
});
