import { readdirSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * The web/worker boundary, as a property of the code rather than of a document
 * (OPS-08, ADR-0019).
 *
 * The acceptance criteria are behavioural: the web process must start and serve
 * normally without ticking, and the worker must do its work without serving
 * anything. `health.test.ts` proves the second half by asserting the worker's
 * route table. This file proves the first half, and proves it the only way that
 * survives someone being helpful at 2am — by walking the module graph.
 *
 * ## Why the module graph rather than a running process
 *
 * "Start the web app and assert nothing ticked" is the obvious test and a weak
 * one: it passes for any interval longer than the test, and it passes for a loop
 * that starts on the first request rather than at boot. Whether the web bundle
 * can *reach* the loop at all is decidable, total, and fails the moment somebody
 * adds the import — which is exactly when it should fail, rather than after the
 * same job has run twice in production.
 *
 * The walk is textual, so it follows type-only imports too and over-states what
 * is reachable. That direction is deliberate: it can produce a false failure,
 * never a false pass, and a false failure is a conversation about the boundary.
 *
 * `eslint.config.js` carries the same rule for the fast, local version of this
 * feedback. The lint rule tells you at the keystroke; this tells you it is still
 * true of the whole graph.
 */

const serverSrc = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Every relative specifier in a source file — `import`, `export … from`, both. */
function importsOf(source: string): string[] {
  const specifiers: string[] = [];
  const pattern = /(?:^|[\s;}])(?:import|export)\b[^'"]*?from\s*['"](\.[^'"]*)['"]/gms;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    if (match[1] !== undefined) specifiers.push(match[1]);
  }
  // Bare side-effect imports: `import './thing'`.
  const bare = /(?:^|[\s;}])import\s*['"](\.[^'"]*)['"]/gms;
  while ((match = bare.exec(source)) !== null) {
    if (match[1] !== undefined) specifiers.push(match[1]);
  }
  return specifiers;
}

function resolveSpecifier(fromFile: string, specifier: string): string | null {
  const base = resolve(dirname(fromFile), specifier);
  for (const candidate of [`${base}.ts`, resolve(base, 'index.ts')]) {
    try {
      readFileSync(candidate, 'utf8');
      return candidate;
    } catch {
      // Not this shape; try the next.
    }
  }
  return null;
}

/** Every `.ts` file in the server package, as paths relative to `src`. */
function allSourceFiles(dir: string = serverSrc): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) return allSourceFiles(full);
    return entry.name.endsWith('.ts') ? [relative(serverSrc, full).replaceAll('\\', '/')] : [];
  });
}

/** Every file in this package reachable from `entry`, as repo-relative paths. */
function reachableFrom(entry: string): Set<string> {
  const start = resolve(serverSrc, entry);
  const seen = new Set<string>();
  const queue = [start];

  while (queue.length > 0) {
    const file = queue.pop();
    if (file === undefined || seen.has(file)) continue;
    seen.add(file);

    let source: string;
    try {
      source = readFileSync(file, 'utf8');
    } catch {
      continue;
    }

    for (const specifier of importsOf(source)) {
      const resolved = resolveSpecifier(file, specifier);
      // A specifier that resolves to nothing is a workspace or node import and
      // is not part of this package's graph.
      if (resolved !== null && !seen.has(resolved)) queue.push(resolved);
    }
  }

  return new Set([...seen].map((file) => relative(serverSrc, file).replaceAll('\\', '/')));
}

/**
 * The modules that make something happen on a schedule.
 *
 * Deliberately not the whole of `sim/`. `event-queue.ts` is left open to the web
 * process, because scheduling an event is web work: a route writes a due row and
 * the worker picks it up, which is the entire communication channel ADR-0019
 * chose. `tick.ts` is the thing that decides *when*, and only one process may
 * own that.
 */
const SCHEDULING_MODULES = ['sim/tick.ts'];

describe('the web process cannot tick', () => {
  const fromApp = reachableFrom('app.ts');
  const fromMain = reachableFrom('main.ts');

  it('walks a graph big enough for the result to mean something', () => {
    // Guards against a resolver change making the walk match nothing and every
    // assertion below passing vacuously.
    expect(fromApp.size).toBeGreaterThan(20);
    expect(fromApp.has('db/schema.ts')).toBe(true);
  });

  it.each(SCHEDULING_MODULES)('does not reach %s from app.ts', (module) => {
    expect(fromApp.has(module)).toBe(false);
  });

  it.each(SCHEDULING_MODULES)('does not reach %s from main.ts', (module) => {
    expect(fromMain.has(module)).toBe(false);
  });

  it('does not reach the engine at all', () => {
    const engineFiles = [...fromApp, ...fromMain].filter((file) => file.startsWith('engine/'));
    expect(engineFiles).toEqual([]);
  });

  it('is not forbidden the queue, only the loop', () => {
    // The boundary is about who *runs* jobs, not about who may create them:
    // writing a due row is how web asks the worker for something, and ADR-0019
    // makes that the whole communication channel.
    //
    // Asserted as an absence rather than as reachability, because today it is
    // neither. `schedule/store.ts` and `flight/ferry.ts` both call
    // `scheduleEvent`, and neither is wired to a route yet — the writers are in
    // the same state the loop was in before this change. So this records that
    // nothing stops it, and `SCHEDULING_MODULES` is where the line actually sits.
    expect(SCHEDULING_MODULES).not.toContain('sim/event-queue.ts');
  });
});

describe('nothing else drives a clock', () => {
  it('leaves the tick loop with exactly one importer in the whole package', () => {
    // The glob in `eslint.config.js` and the two graphs above both work from a
    // named entry point. This works from the other end — every file in the
    // package — so a module that no entry point reaches yet, like `schedule/`
    // was until this change, cannot quietly acquire a loop of its own.
    const importers = allSourceFiles()
      .filter((file) => !file.endsWith('.test.ts'))
      .filter((file) =>
        /from\s*['"][^'"]*sim\/tick['"]/.test(readFileSync(resolve(serverSrc, file), 'utf8')),
      );

    expect(importers).toEqual(['engine/simulation.ts']);
  });
});

describe('the worker owns the schedule', () => {
  const fromWorker = reachableFrom('worker.ts');

  it.each(SCHEDULING_MODULES)('reaches %s', (module) => {
    expect(fromWorker.has(module)).toBe(true);
  });

  it('reaches the engine and the queue', () => {
    expect(fromWorker.has('engine/simulation.ts')).toBe(true);
    expect(fromWorker.has('sim/event-queue.ts')).toBe(true);
  });

  it('builds no web application', () => {
    // Not a style preference. `app.ts` carries authentication, sessions, the
    // admin console and every game route; a worker that imported it would be one
    // `listen` away from serving them, and the split would be a matter of which
    // lines somebody remembered to leave out.
    expect(fromWorker.has('app.ts')).toBe(false);
  });
});
