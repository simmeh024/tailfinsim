import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

import { readBoundedMeshyInput } from './meshy-preflight';
import {
  loadSemanticWorkbenchPayload,
  parseSemanticWorkbenchArguments,
  startSemanticWorkbenchServer,
} from './semantic-workbench';

try {
  const repository = fileURLToPath(new URL('../../../', import.meta.url));
  const source = fileURLToPath(new URL('../workbench/semantic-review-app.js', import.meta.url));
  const { operationId, port } = parseSemanticWorkbenchArguments(process.argv.slice(2));
  const appSource = await readBoundedMeshyInput(source, 256 * 1024);
  const built = await build({
    stdin: {
      contents: appSource,
      loader: 'js',
      resolveDir: dirname(source),
      sourcefile: 'semantic-review-app.js',
    },
    bundle: true,
    write: false,
    platform: 'browser',
    target: 'es2022',
    format: 'esm',
    minify: true,
    sourcemap: false,
    logLevel: 'silent',
  });
  const app = built.outputFiles[0]?.contents;
  if (!app) throw new Error('Workbench build refused.');
  const payload = await loadSemanticWorkbenchPayload(repository, operationId, Buffer.from(app));
  const running = await startSemanticWorkbenchServer(payload, port);
  process.stdout.write(`Semantic review workbench: http://127.0.0.1:${String(running.port)}/\n`);
} catch {
  process.stderr.write('semantic-workbench: invalid-input-or-run-state\n');
  process.exitCode = 1;
}
