import {
  LIVERY_DOCUMENT_FORMAT_VERSION,
  LiveryDocument,
  type LiveryDocument as LiveryDocumentValue,
} from '@tailfin/shared';

export type LiveryDocumentMigrationErrorCode =
  'invalid_document' | 'unsupported_version' | 'missing_migration';

/** A stable failure vocabulary for database, builder-draft and render callers. */
export class LiveryDocumentMigrationError extends Error {
  readonly code: LiveryDocumentMigrationErrorCode;

  constructor(code: LiveryDocumentMigrationErrorCode, message: string) {
    super(message);
    this.name = 'LiveryDocumentMigrationError';
    this.code = code;
  }
}

/** One deterministic N → N+1 transform. Migrations must return new data. */
export interface LiveryDocumentMigration {
  fromVersion: number;
  toVersion: number;
  migrate(document: Readonly<Record<string, unknown>>): unknown;
}

function versionOf(document: unknown): number {
  if (document === null || typeof document !== 'object' || Array.isArray(document)) {
    throw new LiveryDocumentMigrationError(
      'invalid_document',
      'A livery document must be a JSON object.',
    );
  }

  const version = (document as Record<string, unknown>).formatVersion;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 0) {
    throw new LiveryDocumentMigrationError(
      'invalid_document',
      'A livery document must carry a non-negative integer formatVersion.',
    );
  }
  return version;
}

function migrationMap(
  migrations: readonly LiveryDocumentMigration[],
): ReadonlyMap<number, LiveryDocumentMigration> {
  const byVersion = new Map<number, LiveryDocumentMigration>();
  for (const migration of migrations) {
    if (migration.toVersion !== migration.fromVersion + 1 || migration.fromVersion < 0) {
      throw new Error(
        `Livery migration ${String(migration.fromVersion)} → ${String(migration.toVersion)} must advance exactly one non-negative version.`,
      );
    }
    if (byVersion.has(migration.fromVersion)) {
      throw new Error(
        `More than one livery migration starts at version ${String(migration.fromVersion)}.`,
      );
    }
    byVersion.set(migration.fromVersion, migration);
  }
  return byVersion;
}

/**
 * Build the one supported read path for persisted documents.
 *
 * The registry is intentionally linear. When v2 lands it adds a 1 → 2 step;
 * when v3 lands it adds 2 → 3, and a v1 document walks both. Skipping a version
 * would make old saved work dependent on which build happened to read it.
 */
export function createLiveryDocumentMigrator(
  migrations: readonly LiveryDocumentMigration[],
): (document: unknown) => LiveryDocumentValue {
  const byVersion = migrationMap(migrations);

  return (document: unknown): LiveryDocumentValue => {
    let current: unknown = document;
    let version = versionOf(current);

    if (version > LIVERY_DOCUMENT_FORMAT_VERSION) {
      throw new LiveryDocumentMigrationError(
        'unsupported_version',
        `Livery format v${String(version)} is newer than this build's v${String(LIVERY_DOCUMENT_FORMAT_VERSION)}.`,
      );
    }

    while (version < LIVERY_DOCUMENT_FORMAT_VERSION) {
      const migration = byVersion.get(version);
      if (!migration) {
        throw new LiveryDocumentMigrationError(
          'missing_migration',
          `No livery migration is registered from format v${String(version)}.`,
        );
      }

      current = migration.migrate(current as Readonly<Record<string, unknown>>);
      const nextVersion = versionOf(current);
      if (nextVersion !== migration.toVersion) {
        throw new LiveryDocumentMigrationError(
          'invalid_document',
          `The v${String(version)} livery migration returned format v${String(nextVersion)} instead of v${String(migration.toVersion)}.`,
        );
      }
      version = nextVersion;
    }

    const parsed = LiveryDocument.safeParse(current);
    if (!parsed.success) {
      const detail = parsed.error.issues
        .map((issue) => `${issue.path.join('.') || 'document'}: ${issue.message}`)
        .join('; ');
      throw new LiveryDocumentMigrationError(
        'invalid_document',
        `Livery format v${String(version)} is invalid: ${detail}`,
      );
    }
    return parsed.data;
  };
}

/** Add consecutive migration steps here when a new format version ships. */
const LIVERY_DOCUMENT_MIGRATIONS: readonly LiveryDocumentMigration[] = [];

/** Every authoritative persisted livery read must enter through this function. */
export const migrateLiveryDocument = createLiveryDocumentMigrator(LIVERY_DOCUMENT_MIGRATIONS);
