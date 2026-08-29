import { MeshyAccountError } from './meshy-account';
import { runMeshyRunCommand } from './meshy-run-command';
import { meshRunDiagnostic } from './meshy-submit';

try {
  process.stdout.write(await runMeshyRunCommand(process.argv.slice(2), process.env));
} catch (error) {
  // Only closed, code-owned diagnostics can escape. No raw filesystem/JSON/HTTP error.
  const reason = error instanceof MeshyAccountError ? error.code : 'invalid-input-or-run-state';
  process.stderr.write(`${meshRunDiagnostic(error, reason)}\n`);
  process.exitCode = 1;
}
