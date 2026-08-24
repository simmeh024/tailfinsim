import { describe, expect, it } from 'vitest';

import {
  LIVERY_DOCUMENT_FORMAT,
  LIVERY_DOCUMENT_FORMAT_VERSION,
  migrateLiveryDocumentV1ToV2,
  type LiveryDocument,
} from '@tailfin/shared';

import {
  createLiveryDocumentMigrator,
  LiveryDocumentMigrationError,
  migrateLiveryDocument,
  type LiveryDocumentMigration,
} from './document';

function currentDocument(): LiveryDocument {
  return {
    format: LIVERY_DOCUMENT_FORMAT,
    formatVersion: LIVERY_DOCUMENT_FORMAT_VERSION,
    artwork: {
      coordinateSpace: 'tailfin-aircraft-artwork',
      coordinateSpaceVersion: 1,
      viewBox: { x: 0, y: 0, width: 1, height: 1 },
      sideMode: 'mirrored',
    },
    renderMode: 'legacy_svg',
    assetBindings: [],
    familyOverrides: [],
    palette: ['#10233FFF'],
    layers: [],
  };
}

function migrationError(action: () => unknown): LiveryDocumentMigrationError {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(LiveryDocumentMigrationError);
    return error as LiveryDocumentMigrationError;
  }
  throw new Error('expected livery migration to fail');
}

describe('livery document migrations', () => {
  it('validates and clones a current document without changing it', () => {
    const input = currentDocument();
    const snapshot = JSON.stringify(input);
    const migrated = migrateLiveryDocument(input);

    expect(migrated).toEqual(input);
    expect(migrated).not.toBe(input);
    expect(JSON.stringify(input)).toBe(snapshot);
  });

  it('rejects malformed, invalid-current and newer documents with distinct reasons', () => {
    expect(migrationError(() => migrateLiveryDocument({})).code).toBe('invalid_document');

    const invalid = { ...currentDocument(), palette: ['navy'] };
    expect(migrationError(() => migrateLiveryDocument(invalid)).code).toBe('invalid_document');

    const future = { ...currentDocument(), formatVersion: LIVERY_DOCUMENT_FORMAT_VERSION + 1 };
    const futureError = migrationError(() => migrateLiveryDocument(future));
    expect(futureError.code).toBe('unsupported_version');
    expect(futureError.message).toMatch(/newer than this build/);
  });

  it('fails closed when an old version has no registered path', () => {
    const error = migrationError(() =>
      migrateLiveryDocument({ format: LIVERY_DOCUMENT_FORMAT, formatVersion: 0 }),
    );
    expect(error.code).toBe('missing_migration');
    expect(error.message).toContain('v0');
  });

  it('migrates stored v1 documents through the registered legacy fallback', () => {
    const legacy = {
      format: LIVERY_DOCUMENT_FORMAT,
      formatVersion: 1,
      palette: ['#10233FFF'],
      layers: [],
    };

    expect(migrateLiveryDocument(legacy)).toMatchObject({
      formatVersion: 2,
      renderMode: 'legacy_svg',
      assetBindings: [],
      palette: legacy.palette,
    });
  });

  it('walks consecutive migrations and leaves the stored input untouched', () => {
    const stored = {
      format: LIVERY_DOCUMENT_FORMAT,
      formatVersion: 0,
      brandColors: ['#10233FFF'],
    };
    const snapshot = JSON.stringify(stored);
    const steps: readonly LiveryDocumentMigration[] = [
      {
        fromVersion: 0,
        toVersion: 1,
        migrate: (document) => ({
          format: document.format,
          formatVersion: 1,
          palette: document.brandColors,
          layers: [],
        }),
      },
      {
        fromVersion: 1,
        toVersion: 2,
        migrate: migrateLiveryDocumentV1ToV2,
      },
    ];

    expect(createLiveryDocumentMigrator(steps)(stored)).toEqual(currentDocument());
    expect(JSON.stringify(stored)).toBe(snapshot);
  });

  it('refuses skipped, duplicate and dishonest migration steps', () => {
    const pass = (document: Readonly<Record<string, unknown>>) => document;
    expect(() =>
      createLiveryDocumentMigrator([{ fromVersion: 0, toVersion: 2, migrate: pass }]),
    ).toThrow(/advance exactly one/);
    expect(() =>
      createLiveryDocumentMigrator([
        { fromVersion: 0, toVersion: 1, migrate: pass },
        { fromVersion: 0, toVersion: 1, migrate: pass },
      ]),
    ).toThrow(/More than one/);

    const dishonest = createLiveryDocumentMigrator([
      { fromVersion: 0, toVersion: 1, migrate: (document) => document },
    ]);
    const error = migrationError(() =>
      dishonest({ format: LIVERY_DOCUMENT_FORMAT, formatVersion: 0 }),
    );
    expect(error.code).toBe('invalid_document');
    expect(error.message).toMatch(/returned format v0 instead of v1/);
  });
});
