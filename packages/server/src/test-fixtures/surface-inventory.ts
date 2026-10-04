import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

import type { MatrixRow } from './route-inventory';

/**
 * Which player routes a player can actually reach (SURFACE-01).
 *
 * The inventory is **generated**, from two sources that cannot drift from the
 * thing they describe:
 *
 *   - the routes, from `docs/authorization-matrix.md` — the join key, which
 *     SEC-04 already holds in exact agreement with Fastify's own route table;
 *   - the consumers, from the **client's real code**: every `/api/…` path the
 *     web package builds, read with the TypeScript parser rather than grepped,
 *     in a call, a variable, a return or an `href` — never in a comment, a `case`
 *     label or a comparison — and counted only when the function that builds it
 *     is imported and used by a module the app's entry point actually reaches.
 *
 * The last part is the one a grep cannot do. `dashboard/api.ts` exported a
 * `fetchProfitAndLoss` for a milestone with nothing calling it, in a module the
 * app did import — so "the URL appears in shipped code" said consumed when no
 * player could ever see a profit and loss. A consumer here is a call a player can
 * cause.
 *
 * ## What it does not decide
 *
 * Whether the page that calls a route is reachable from the navigation is
 * SURFACE-07's question (`packages/web/src/shell/reachability.test.tsx`); this
 * one asks whether any page calls it at all. And method inference is
 * deliberately coarse: an explicit `method:` or a method argument decides, a
 * bare `fetch` is a `GET`, a helper is read by its name (`read…`, `post…`), and
 * anything else counts for every method on the path rather than for none.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
export const WEB_SRC = resolve(HERE, '..', '..', '..', 'web', 'src');
/** The client's entry point: `main.tsx` mounts `App`, and everything a player reaches is under it. */
export const WEB_ENTRY = 'main.tsx';

const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
/** Calls whose string argument is a comparison, not a request. */
const COMPARISON_CALLS = new Set([
  'startsWith',
  'endsWith',
  'includes',
  'indexOf',
  'match',
  'replace',
  'replaceAll',
  'test',
  'split',
]);

/** One place the client builds an API path. */
export interface ClientCall {
  /** Relative to `packages/web/src`, POSIX separators. */
  file: string;
  /** Normalised: every interpolated segment is `:`; no query string. */
  path: string;
  /** The HTTP methods it is sent with, or `*` when the code does not say. */
  methods: readonly string[] | '*';
  /** The exported function or const it is built in, or null at module level / in a local. */
  symbol: string | null;
}

/** A source module of the client, as far as reachability needs it. */
interface Module {
  file: string;
  source: ts.SourceFile;
  /** Resolved relative imports: file → the names it imports (`*` for a namespace or dynamic import). */
  imports: Map<string, Set<string>>;
  /** Top-level declarations: name → node. */
  declarations: Map<string, ts.Node>;
  /** Names exported from this module. */
  exported: Set<string>;
}

function posix(path: string): string {
  return path.split(sep).join('/');
}

/** Every non-test TypeScript module under a directory. */
export function sourceFiles(root: string): string[] {
  const files: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory)) {
      const path = join(directory, entry);
      if (statSync(path).isDirectory()) {
        walk(path);
      } else if (
        /\.(ts|tsx)$/.test(entry) &&
        !/\.(test|spec)\.(ts|tsx)$/.test(entry) &&
        !entry.endsWith('.d.ts') &&
        entry !== 'test-setup.ts'
      ) {
        files.push(posix(relative(root, path)));
      }
    }
  };
  walk(root);
  return files.sort();
}

function resolveSpecifier(root: string, from: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null;
  const base = posix(join(dirname(from), specifier));
  for (const candidate of [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}/index.ts`,
    `${base}/index.tsx`,
  ]) {
    const absolute = join(root, candidate);
    if (existsSync(absolute) && statSync(absolute).isFile() && /\.(ts|tsx)$/.test(candidate)) {
      return posix(candidate);
    }
  }
  return null;
}

function hasExport(node: ts.Node): boolean {
  return (
    ts.canHaveModifiers(node) &&
    (ts.getModifiers(node) ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
  );
}

function readModule(root: string, file: string): Module {
  const text = readFileSync(join(root, file), 'utf8');
  const source = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const imports = new Map<string, Set<string>>();
  const declarations = new Map<string, ts.Node>();
  const exported = new Set<string>();

  const addImport = (specifier: string, names: Iterable<string>): void => {
    const target = resolveSpecifier(root, file, specifier);
    if (target === null) return;
    const set = imports.get(target) ?? new Set<string>();
    for (const name of names) set.add(name);
    imports.set(target, set);
  };

  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      const clause = statement.importClause;
      // `import type` executes nothing and reaches nothing.
      if (clause?.isTypeOnly === true) continue;
      if (clause === undefined) {
        addImport(statement.moduleSpecifier.text, []);
        continue;
      }
      const names: string[] = [];
      if (clause.name) names.push('default');
      const bindings = clause.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) names.push('*');
      if (bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          if (!element.isTypeOnly) names.push((element.propertyName ?? element.name).text);
        }
      }
      addImport(statement.moduleSpecifier.text, names);
    } else if (
      ts.isExportDeclaration(statement) &&
      statement.moduleSpecifier &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      !statement.isTypeOnly
    ) {
      // A re-export makes the target's names this module's.
      addImport(statement.moduleSpecifier.text, ['*']);
    } else if (ts.isFunctionDeclaration(statement) && statement.name) {
      declarations.set(statement.name.text, statement);
      if (hasExport(statement)) exported.add(statement.name.text);
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) {
          declarations.set(declaration.name.text, statement);
          if (hasExport(statement)) exported.add(declaration.name.text);
        }
      }
    } else if (ts.isClassDeclaration(statement) && statement.name) {
      declarations.set(statement.name.text, statement);
      if (hasExport(statement)) exported.add(statement.name.text);
    }
  }

  // Dynamic `import('./x')` anywhere — the route table's lazy pages.
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] !== undefined &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      addImport(node.arguments[0].text, ['*']);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);

  return { file, source, imports, declarations, exported };
}

/** Identifier names used inside a node, excluding the import declarations. */
function identifiersIn(node: ts.Node): Set<string> {
  const names = new Set<string>();
  const visit = (child: ts.Node): void => {
    if (ts.isImportDeclaration(child)) return;
    if (ts.isIdentifier(child)) names.add(child.text);
    ts.forEachChild(child, visit);
  };
  visit(node);
  return names;
}

/** The top-level statement a node sits in. */
function topLevel(node: ts.Node): ts.Node {
  let current = node;
  while (current.parent !== undefined && !ts.isSourceFile(current.parent)) current = current.parent;
  return current;
}

/** The exported symbol a node is declared inside, or null. */
function enclosingSymbol(module: Module, node: ts.Node): string | null {
  const statement = topLevel(node);
  for (const [name, declaration] of module.declarations) {
    if (declaration === statement && module.exported.has(name)) return name;
  }
  return null;
}

/* -- Finding the API paths the client builds ---------------------------------- */

/**
 * Where an interpolation stood in a template. Braces cannot appear unencoded in
 * a URL path, so the marker cannot collide with anything a literal spells.
 */
const HOLE = '{}';

/** The path a literal spells, `:` for each interpolation, or null when it is not an API path. */
function pathOf(node: ts.Node): string | null {
  let raw: string | null = null;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    raw = node.text;
  } else if (ts.isTemplateExpression(node)) {
    raw = node.head.text + node.templateSpans.map((span) => `${HOLE}${span.literal.text}`).join('');
  }
  if (!raw?.startsWith('/api/')) return null;

  // `'/api/x/' + id` — the string is the left of a concatenation.
  const parent = node.parent;
  if (
    parent !== undefined &&
    ts.isBinaryExpression(parent) &&
    parent.operatorToken.kind === ts.SyntaxKind.PlusToken &&
    parent.left === node
  ) {
    raw = `${raw}${HOLE}`;
  }

  const withoutQuery = raw.split('?')[0] ?? raw;
  const segments = withoutQuery.split('/').slice(1);
  const normalised = segments
    .map((segment) => {
      // `${id}`, or `${id}${suffix}` — a segment that is nothing but interpolation.
      if (segment !== '' && segment.split(HOLE).join('') === '') return ':';
      // `founding-airports${suffix}` — an interpolation glued onto a literal is a
      // query or a suffix, not a segment of its own.
      return segment.split(HOLE).join('');
    })
    .filter((segment, index, all) => segment !== '' || index < all.length - 1);
  return `/${normalised.join('/')}`;
}

/** Walk up through what only wraps a value — `+`, parentheses, `as`. */
function useSite(node: ts.Node): { site: ts.Node; child: ts.Node } {
  let child = node;
  let site = node.parent;
  while (
    site !== undefined &&
    (ts.isParenthesizedExpression(site) ||
      ts.isAsExpression(site) ||
      ts.isSatisfiesExpression(site) ||
      (ts.isBinaryExpression(site) && site.operatorToken.kind === ts.SyntaxKind.PlusToken))
  ) {
    child = site;
    site = site.parent;
  }
  return { site, child };
}

function calleeName(call: ts.CallExpression): string {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
  return '';
}

/** The methods a call argument is sent with. */
function methodsOf(call: ts.CallExpression, argument: ts.Node): readonly string[] | '*' {
  const found: string[] = [];
  const literal = (expression: ts.Expression): void => {
    if (ts.isStringLiteral(expression) && HTTP_METHODS.has(expression.text)) {
      found.push(expression.text);
    } else if (ts.isConditionalExpression(expression)) {
      literal(expression.whenTrue);
      literal(expression.whenFalse);
    }
  };
  for (const other of call.arguments) {
    if (other === argument) continue;
    literal(other);
    if (ts.isObjectLiteralExpression(other)) {
      for (const property of other.properties) {
        if (
          ts.isPropertyAssignment(property) &&
          property.name.getText() === 'method' &&
          property.initializer !== undefined
        ) {
          literal(property.initializer);
        }
      }
    }
  }
  if (found.length > 0) return [...new Set(found)];

  const name = calleeName(call);
  if (name === 'fetch') return ['GET'];
  if (/^(get|read|fetch|load|shaped|poll)/i.test(name)) return ['GET'];
  if (/^(post|create|send)$/i.test(name) || /^post/i.test(name)) return ['POST'];
  if (/^put/i.test(name)) return ['PUT'];
  if (/^patch/i.test(name)) return ['PATCH'];
  if (/^(del|delete|remove)/i.test(name)) return ['DELETE'];
  return '*';
}

/** A literal in a position where it is sent somewhere, and how. Null when it is not. */
function consumption(node: ts.Node): { methods: readonly string[] | '*' } | null {
  const { site, child } = useSite(node);
  if (site === undefined) return null;

  if (ts.isCallExpression(site) || ts.isNewExpression(site)) {
    if (!site.arguments?.some((argument) => argument === child)) return null;
    if (ts.isCallExpression(site) && COMPARISON_CALLS.has(calleeName(site))) return null;
    return { methods: ts.isCallExpression(site) ? methodsOf(site, child) : '*' };
  }
  if (ts.isVariableDeclaration(site) && site.initializer === child) return { methods: '*' };
  if (ts.isReturnStatement(site)) return { methods: '*' };
  if (ts.isArrowFunction(site) && site.body === child) return { methods: '*' };
  if (ts.isJsxExpression(site) || ts.isJsxAttribute(site)) {
    const attribute = ts.isJsxAttribute(site) ? site : site.parent;
    if (attribute !== undefined && ts.isJsxAttribute(attribute)) {
      const name = attribute.name.getText();
      if (name === 'href' || name === 'action' || name === 'src') return { methods: ['GET'] };
    }
  }
  // Everything else — a `case` label, a comparison, an object key or value — is
  // a mention, not a request.
  return null;
}

function callsIn(module: Module): ClientCall[] {
  const calls: ClientCall[] = [];
  const visit = (node: ts.Node): void => {
    const path = pathOf(node);
    if (path !== null) {
      const used = consumption(node);
      if (used !== null) {
        calls.push({
          file: module.file,
          path,
          methods: used.methods,
          symbol: enclosingSymbol(module, node),
        });
      }
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(module.source);
  return calls;
}

/* -- Which of them a player can cause -------------------------------------------- */

/**
 * The client's live API calls: those in a module the entry point reaches, in a
 * symbol that something reachable actually uses.
 */
export function liveClientCalls(root: string = WEB_SRC, entry: string = WEB_ENTRY): ClientCall[] {
  const modules = new Map(sourceFiles(root).map((file) => [file, readModule(root, file)]));

  // Modules reachable from the entry, by real (non-type) imports.
  const reachable = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.shift();
    if (file === undefined || reachable.has(file)) continue;
    const module = modules.get(file);
    if (module === undefined) continue;
    reachable.add(file);
    for (const target of module.imports.keys()) queue.push(target);
  }

  // Symbols used: imported and referenced by a reachable module, then closed
  // over references inside each used symbol of the same module.
  const used = new Set<string>();
  const key = (file: string, name: string) => `${file}#${name}`;
  const pending: [string, string][] = [];
  const mark = (file: string, name: string): void => {
    const id = key(file, name);
    if (used.has(id)) return;
    used.add(id);
    pending.push([file, name]);
  };

  for (const file of reachable) {
    const module = modules.get(file);
    if (module === undefined) continue;
    const names = identifiersIn(module.source);
    for (const [target, imported] of module.imports) {
      const targetModule = modules.get(target);
      if (targetModule === undefined) continue;
      for (const name of targetModule.exported) {
        if ((imported.has(name) || imported.has('*')) && names.has(name)) mark(target, name);
      }
    }
    // A reachable module's own top-level code (not inside a declaration).
    for (const statement of module.source.statements) {
      if (ts.isImportDeclaration(statement)) continue;
      if ([...module.declarations.values()].includes(statement)) continue;
      for (const name of identifiersIn(statement)) {
        if (module.declarations.has(name)) mark(file, name);
      }
    }
  }
  while (pending.length > 0) {
    const next = pending.pop();
    if (next === undefined) break;
    const [file, name] = next;
    const module = modules.get(file);
    const declaration = module?.declarations.get(name);
    if (module === undefined || declaration === undefined) continue;
    for (const inner of identifiersIn(declaration)) {
      if (inner !== name && module.declarations.has(inner)) mark(file, inner);
    }
  }

  const live: ClientCall[] = [];
  for (const file of reachable) {
    const module = modules.get(file);
    if (module === undefined) continue;
    for (const call of callsIn(module)) {
      if (call.symbol === null || used.has(key(file, call.symbol))) live.push(call);
    }
  }
  return live;
}

/* -- Joining them to the matrix ---------------------------------------------- */

function segmentsOf(path: string): string[] {
  return path
    .split('/')
    .slice(1)
    .map((segment) => (segment.startsWith(':') ? ':' : segment));
}

function sameShape(call: string[], route: string[], wildcard: boolean): boolean {
  if (call.length !== route.length) return false;
  return call.every(
    (segment, index) =>
      segment === route[index] || (wildcard && segment === ':' && route[index] !== undefined),
  );
}

/**
 * The matrix routes a client path reaches.
 *
 * An interpolated segment matches a route's parameter first. Only when no route
 * has a parameter there does it stand for the literal segments it could be —
 * `/api/auth/${provider}` reaches `/api/auth/google`, `…/discord` and `…/twitch`
 * — so `/api/ground/${icao}` reaches `/api/ground/:icao` and is never mistaken
 * for a consumer of the static `/api/ground/contracts` beside it.
 */
export function routesReached(path: string, routes: readonly MatrixRow[]): MatrixRow[] {
  const call = segmentsOf(path);
  const exact = routes.filter((route) => sameShape(call, segmentsOf(route.url), false));
  if (exact.length > 0) return exact;
  return routes.filter((route) => sameShape(call, segmentsOf(route.url), true));
}

export type RouteAudience = 'player' | 'admin' | 'static';

export function audienceOf(url: string): RouteAudience {
  if (url.startsWith('/api/admin/')) return 'admin';
  if (url.startsWith('/api/')) return 'player';
  return 'static';
}

export interface InventoryRow {
  key: string;
  audience: RouteAudience;
  /** `file#symbol` (or `file` at module level), sorted. */
  consumers: string[];
}

/** Every matrix route and the live client code that calls it. */
export function surfaceInventory(
  routes: readonly MatrixRow[],
  calls: readonly ClientCall[],
): InventoryRow[] {
  const consumers = new Map<string, Set<string>>();
  for (const call of calls) {
    for (const route of routesReached(call.path, routes)) {
      if (call.methods !== '*' && !call.methods.includes(route.method)) continue;
      const set = consumers.get(route.key) ?? new Set<string>();
      set.add(call.symbol === null ? call.file : `${call.file}#${call.symbol}`);
      consumers.set(route.key, set);
    }
  }
  return [...routes]
    .sort((a, b) => a.key.localeCompare(b.key))
    .map((route) => ({
      key: route.key,
      audience: audienceOf(route.url),
      consumers: [...(consumers.get(route.key) ?? [])].sort(),
    }));
}

/* -- Judging it ----------------------------------------------------------------- */

/** One allowlisted or baselined route, as the judge reads it. */
export interface SurfaceEntry {
  route: string;
  issue: number;
  reason: string;
  surfaceIssueFiled?: false;
}

export interface SurfaceLists {
  notASurface: readonly SurfaceEntry[];
  baseline: readonly SurfaceEntry[];
  adminBaseline: readonly SurfaceEntry[];
}

export interface SurfaceVerdict {
  /** Player routes with no consumer and no entry: the failure the guard exists for. */
  orphans: string[];
  /** Entries whose route has a consumer now — the baseline must be trimmed. */
  stale: string[];
  /** Entries naming a route the matrix does not have. */
  unknown: string[];
  /** Entries without a reason worth the name or an issue number. */
  unexplained: string[];
  /** The same as `orphans`, for the admin console, scored apart. */
  adminOrphans: string[];
}

export function judgeSurfaces(rows: readonly InventoryRow[], lists: SurfaceLists): SurfaceVerdict {
  const byKey = new Map(rows.map((row) => [row.key, row]));
  const player = new Map<string, SurfaceEntry>();
  for (const entry of [...lists.notASurface, ...lists.baseline]) player.set(entry.route, entry);
  const admin = new Map(lists.adminBaseline.map((entry) => [entry.route, entry]));

  const all = [...lists.notASurface, ...lists.baseline, ...lists.adminBaseline];
  return {
    orphans: rows
      .filter(
        (row) => row.audience === 'player' && row.consumers.length === 0 && !player.has(row.key),
      )
      .map((row) => row.key),
    stale: all
      .filter((entry) => (byKey.get(entry.route)?.consumers.length ?? 0) > 0)
      .map((entry) => entry.route),
    unknown: all.filter((entry) => !byKey.has(entry.route)).map((entry) => entry.route),
    unexplained: all
      .filter((entry) => entry.reason.trim().length < 20 || !(entry.issue > 0))
      .map((entry) => entry.route),
    adminOrphans: rows
      .filter(
        (row) => row.audience === 'admin' && row.consumers.length === 0 && !admin.has(row.key),
      )
      .map((row) => row.key),
  };
}

/* -- The generated document ------------------------------------------------------- */

function statusOf(row: InventoryRow, lists: SurfaceLists): string {
  if (row.consumers.length > 0) return 'consumed';
  const entry = [...lists.notASurface, ...lists.baseline, ...lists.adminBaseline].find(
    (candidate) => candidate.route === row.key,
  );
  if (entry === undefined) return row.audience === 'static' ? 'static' : '**orphan**';
  if (lists.notASurface.includes(entry)) return `not a surface (#${String(entry.issue)})`;
  return entry.surfaceIssueFiled === false
    ? `baselined (#${String(entry.issue)}, no surface issue filed)`
    : `baselined (#${String(entry.issue)})`;
}

function detailOf(row: InventoryRow, lists: SurfaceLists): string {
  if (row.consumers.length > 0)
    return row.consumers.map((consumer) => `\`${consumer}\``).join(', ');
  const entry = [...lists.notASurface, ...lists.baseline, ...lists.adminBaseline].find(
    (candidate) => candidate.route === row.key,
  );
  if (entry !== undefined) return entry.reason;
  return row.audience === 'static'
    ? 'Not under `/api`: served to the browser or a monitor directly, not called by the app.'
    : '';
}

/** The inventory as Markdown, before Prettier formats it. */
export function renderSurfaceInventory(rows: readonly InventoryRow[], lists: SurfaceLists): string {
  const section = (audience: RouteAudience) => rows.filter((row) => row.audience === audience);
  const count = (audience: RouteAudience, predicate: (row: InventoryRow) => boolean) =>
    section(audience).filter(predicate).length;
  const table = (audience: RouteAudience) =>
    [
      '| Route | Status | Consumers, or why there are none |',
      '| --- | --- | --- |',
      ...section(audience).map(
        (row) => `| \`${row.key}\` | ${statusOf(row, lists)} | ${detailOf(row, lists)} |`,
      ),
    ].join('\n');

  const consumed = (row: InventoryRow) => row.consumers.length > 0;
  const unfiled = lists.baseline.filter((entry) => entry.surfaceIssueFiled === false).length;

  return [
    '# Surface inventory',
    '',
    '<!-- Generated by packages/server/src/surface/surface-reachability.test.ts. Do not edit by hand. -->',
    '',
    'Every route in [`authorization-matrix.md`](authorization-matrix.md), and the client code that',
    'calls it (SURFACE-01). **Generated**, not written: the routes are the matrix’s, the consumers',
    'are read from `packages/web/src` with the TypeScript parser and counted only where a module the',
    'app’s entry point reaches imports and uses the function that builds the call. The reasons are',
    '`packages/server/src/surface/surface-allowlist.ts`’s. Regenerate with',
    '`SURFACE_INVENTORY_WRITE=1 npx vitest run --project server surface-reachability`; the guard',
    'fails while this file is out of date.',
    '',
    `- **Player routes:** ${String(section('player').length)} — ${String(count('player', consumed))} consumed, ${String(lists.baseline.length)} baselined ahead of their surface (${String(unfiled)} with no surface issue filed yet), ${String(lists.notASurface.length)} not a surface.`,
    `- **Admin routes:** ${String(section('admin').length)} — ${String(count('admin', consumed))} consumed, ${String(lists.adminBaseline.length)} baselined.`,
    `- **Static routes:** ${String(section('static').length)}, outside \`/api\` and not scored.`,
    '',
    '## Player routes',
    '',
    table('player'),
    '',
    '## Admin routes',
    '',
    table('admin'),
    '',
    '## Static routes',
    '',
    table('static'),
    '',
  ].join('\n');
}
