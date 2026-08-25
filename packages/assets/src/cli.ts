import { resolve } from 'node:path';

import { intakeAircraftAsset } from './pipeline';
import { selectPreviousAssetVersion, verifyRegistry } from './registry';
import { salvageA320neo } from './salvage-a320neo';
import { AssetPipelineError } from './schema';

function argumentsByName(values: readonly string[]): Map<string, string> {
  const result = new Map<string, string>();
  for (let index = 0; index < values.length; index += 1) {
    const argument = values[index];
    if (!argument?.startsWith('--')) continue;
    const value = values[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${argument} requires a value`);
    result.set(argument.slice(2), value);
    index += 1;
  }
  return result;
}

function required(argumentsMap: ReadonlyMap<string, string>, name: string): string {
  const value = argumentsMap.get(name);
  if (!value) throw new Error(`Missing --${name}`);
  return value;
}

async function main(): Promise<void> {
  const [command, ...values] = process.argv.slice(2);
  const argumentsMap = argumentsByName(values);
  if (command === 'intake') {
    const result = await intakeAircraftAsset({
      manifestPath: resolve(required(argumentsMap, 'manifest')),
      decisionPath: resolve(required(argumentsMap, 'decision')),
      root: resolve(required(argumentsMap, 'root')),
    });
    process.stdout.write(
      `accepted ${result.entry.asset.id}@${result.entry.asset.version} ${result.entry.runtime.contentIdentity}\n`,
    );
    return;
  }
  if (command === 'validate') {
    const registry = await verifyRegistry(resolve(required(argumentsMap, 'root')));
    process.stdout.write(`validated ${String(registry.entries.length)} aircraft runtime assets\n`);
    return;
  }
  if (command === 'rollback') {
    const root = resolve(required(argumentsMap, 'root'));
    const assetId = required(argumentsMap, 'asset');
    const version = required(argumentsMap, 'version');
    await selectPreviousAssetVersion(root, assetId, version);
    process.stdout.write(
      `selected ${assetId}@${version}; exact published livery bindings are unchanged\n`,
    );
    return;
  }
  if (command === 'salvage-a320neo') {
    const result = await salvageA320neo({
      inputPath: resolve(required(argumentsMap, 'input')),
      outputDirectory: resolve(required(argumentsMap, 'output')),
      reviewedAt: required(argumentsMap, 'date'),
    });
    process.stdout.write(
      `salvaged A320neo ${result.sourceSha256} (${String(result.sourceByteSize)} bytes; LODs ${result.lodTriangles.join('/')})\n`,
    );
    return;
  }
  throw new Error('Usage: cli.js intake|validate|rollback|salvage-a320neo [options]');
}

try {
  await main();
} catch (error) {
  if (error instanceof AssetPipelineError) {
    process.stderr.write(`${error.message}\n`);
    for (const issue of error.issues) {
      process.stderr.write(
        `${issue.severity.toUpperCase()} ${issue.code} ${issue.path}: ${issue.message}\n`,
      );
    }
  } else {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  }
  process.exitCode = 1;
}
