import { runMeshyPreflight } from './meshy-preflight';

try {
  process.stdout.write(await runMeshyPreflight(process.argv.slice(2), process.env));
} catch {
  // No raw exception: JSON, filesystem and parser errors can contain secrets.
  process.stderr.write('Meshy preflight refused. Use --help; no API request was made.\n');
  process.exitCode = 1;
}
