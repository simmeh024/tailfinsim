# ADR-0016: Atomic expand/contract migrations with a pre-migration recovery point

- **Status:** Accepted
- **Date:** 2026-08-20
- **Deciders:** @simmeh024
- **Constrains:** every migration after `0019_large_hellfire_club`, production and dev deploys

## Context

The deploy scripts build the new checkout, migrate PostgreSQL, then restart Fastify. A
migration error therefore leaves the old process serving, but that was only half a failure
strategy: the repository did not establish whether an earlier file in the same pending batch
had committed, whether old code could use the resulting schema, or how to recover it.

Down-migrations are not a safe default. A down step that drops a newly written column can
destroy the only copy of data produced by the forward migration, and checking out an older
commit changes code rather than schema.

### What Drizzle actually does — established by experiment

Tailfin uses `drizzle-orm` 0.45.2's Node/PostgreSQL migrator. Its implementation creates the
`drizzle` bookkeeping schema/table if needed, then wraps the loop over **every pending
migration file and every statement** in one `session.transaction`. Source inspection suggested
batch atomicity; OPS-05 proved it rather than treating the implementation as a promise.

The standing experiment in `packages/server/src/migration-policy.test.ts` runs against a
disposable PostgreSQL 16 database:

1. create a table with **100,000 rows**;
2. migration file one adds a required defaulted column and validates a constraint;
3. migration file two sleeps while the first file's lock is held, adds another column, then
   deliberately divides by zero;
4. from another connection, attempt a read with a 200 ms lock timeout;
5. inspect the table and the isolated Drizzle journal after the failure.

Observed on 2026-08-20: the other reader received PostgreSQL `55P03` while an
`AccessExclusiveLock` was held; when the second file failed, **both files rolled back**. The
table still had 100,000 rows and only its original columns, and the experiment's migration
journal had zero applied rows. The local disposable-container run took **1,078 ms**; the test
records its elapsed time in every database-backed CI run. This establishes both halves of the
trade: no half-applied batch, and locks live for the whole batch rather than one file.

The empty Drizzle bookkeeping schema/table may remain after the first migration attempt on a
brand-new database because those two idempotent statements precede the transaction. No domain
DDL or applied-migration journal row remains.

## Decision

Use four controls together.

### 1. Keep the complete pending batch atomic

Continue using Drizzle's PostgreSQL migrator and reject SQL that cannot run in its transaction,
including `CREATE INDEX CONCURRENTLY`, `REINDEX CONCURRENTLY`, `VACUUM` and `CLUSTER`. A failed
statement rolls every pending file back. We do not add down-migrations.

`migrate.js` reads the journal before and after a failure and reports one of three observed
states with a distinct exit code:

| State             | Meaning and deploy response                                                                |
| ----------------- | ------------------------------------------------------------------------------------------ |
| `ROLLED BACK`     | Journal unchanged. Old service keeps serving the pre-deploy schema; fix and retry.         |
| `ALL APPLIED`     | PostgreSQL committed but the client failed afterwards. Old service remains compatible.     |
| `UNKNOWN/PARTIAL` | Journal is between those states or cannot be read. Stop; use the recovery procedure first. |

This distinction matters because a lost connection can make the client uncertain whether
`COMMIT` succeeded. “The command failed” is not evidence that the database rolled back.

### 2. Every migration is compatible with the previous release

Use expand/contract:

- **Expand:** add nullable or defaulted columns, tables, indexes and dual-write/read support.
  The previously deployed code must continue to read and write successfully.
- **Contract:** remove the old path only after an earlier released version stopped using it.
  A contract migration names the issue that proves that sequencing.

Every migration added after `0019_large_hellfire_club` must declare one of these at the top:

```sql
-- tailfin:migration-strategy expand
-- tailfin:migration-strategy contract-safe-after #123
```

The migration command and CI both enforce the marker. The check rejects obvious contractions
mislabelled as expand, new required columns without a database default, and operations that
cannot run inside the atomic transaction. A SQL regular expression cannot prove semantic
compatibility; review and the named contract issue remain responsible for constraints,
triggers, data transforms and application behavior.

### 3. Take a verified local dump before a non-empty batch

After the target build succeeds and the migration preflight reports at least one pending file,
the deploy starts a root-owned systemd oneshot for the **actual configured database**. The
oneshot reuses `tailfin-backup` in local-only mode, verifies the custom-format archive with
`pg_restore --list`, writes a SHA-256 sidecar and records the exact filename in a world-readable
status file. Migration does not start unless that unit succeeds. The latest eight
pre-migration dumps **per database** are kept, so frequent dev previews cannot evict
production's recovery points.

The dump is deliberately local. Its job is a fast schema recovery point while the host and
PostgreSQL still exist; the nightly DreamObjects copy remains the host/volume-loss control.
Uploading every dev preview deploy would create a second retention and alerting system without
improving the migration failure being addressed. A whole-database restore loses valid writes
made after the dump's snapshot, so recovery first preserves the failed database and prefers a
targeted repair when it can be proved safe.

### 4. Recover into a new database, never over the failed one

For an expected `ROLLED BACK` failure, recovery is no restore at all: keep the old process
serving, fix the forward migration and deploy again. For `ALL APPLIED`, inspect the client
failure and rerun the deploy only after confirming the journal; expand/contract keeps the old
process safe meanwhile.

For `UNKNOWN/PARTIAL`, do not rerun migrations and do not assume a code rollback changes the
schema. Preserve a second dump of the failed state, restore the recorded pre-migration archive
into a new `_test` database, verify its checksum and archive listing, inspect the migration
journal and application/domain checks, then choose one explicit recovery:

- repair forward in one reviewed transaction when that preserves post-backup writes; or
- restore into a new non-live database, verify it, stop the service, change `DATABASE_URL` to
  that database and restart. Never overwrite the failed database in place.

The exact commands are in `deploy/README.md`. The recovery path was rehearsed on 2026-08-20
against disposable PostgreSQL 16: a verified custom-format pre-migration dump was taken, a
fake first migration was committed to simulate the old half-applied failure mode, the dump was
restored into a new `_test` database, and the recovered copy retained the original migration
journal's **20 rows** and the real `airline` relation while excluding the fake schema change.
The source probe table and recovery database were then removed. No dev or production database
participated.

## Consequences

### What this makes easier

- A normal SQL failure has one schema outcome: the complete pending batch is unapplied.
- The deploy says which database state it observed instead of only saying the service was not
  restarted.
- Old code can safely serve whether zero or all pending migrations committed.
- Every non-empty batch has a recent, verified recovery point independent of the nightly RPO.
- An obvious destructive or non-transactional migration fails in CI and again on the box.

### What this makes harder

- Incompatible schema changes take at least two releases: expand/application change first,
  contract later.
- A batch holds its strongest locks until every pending file commits. Keep migrations short;
  split deploys rather than accumulating unrelated long transforms.
- `CREATE INDEX CONCURRENTLY` cannot use this path. A future need for it requires a separately
  rehearsed, idempotent operational procedure and a new decision, not an inline exception.
- A verified dump adds time and disk I/O to deploys that carry migrations. Builds without
  pending migrations skip it.
- The backup helper, systemd template and narrow sudoers entries are installed manually because
  application deploys cannot write `/etc` or `/usr/local/sbin`.

### What we accept

Drizzle's all-files transaction is an implementation behavior covered by a live PostgreSQL
regression test, not a cross-version API guarantee. A dependency upgrade that changes it will
fail that experiment and must revisit this ADR before merging.

The pre-migration dump is a recovery tool, not zero-data-loss point-in-time recovery. Writes
after its snapshot must be reconciled or explicitly accepted as loss before a full cutover.

## Alternatives considered

| Option                                       | Why not                                                                                                                                              |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Down-migration for every forward migration   | Reverse DDL can destroy data written since the forward step and gives false confidence that checking out old code restores schema.                   |
| One transaction per migration file           | Leaves a prefix committed when a later file fails—the exact state OPS-05 must eliminate.                                                             |
| Wrap Drizzle in another explicit transaction | Drizzle already owns one transaction across the batch; nesting adds no guarantee and still cannot admit concurrent/non-transactional operations.     |
| Expand/contract without a check              | A convention invisible to CI is forgotten under time pressure. The marker and deny-list make the decision reviewable while admitting their limits.   |
| Upload every pre-migration dump off-box      | Nightly off-box backups already cover host loss. Per-preview uploads add cost, retention and alerting complexity to a local schema-recovery control. |
| Automatically restore on failure             | A restore can erase valid concurrent writes and an uncertain commit can already have applied everything. Recovery requires inspection, not reflex.   |

## Revisit when

- Drizzle ORM changes the PostgreSQL migrator or the standing failure experiment changes;
- a migration needs `CREATE INDEX CONCURRENTLY`, a non-transactional operation or a transform
  whose lock time is unacceptable;
- PostgreSQL moves off-host under OPS-11, so the local backup service or peer authentication no
  longer applies; or
- write volume makes a dump-and-cutover recovery point too lossy, at which point WAL archiving
  and point-in-time recovery should replace it.
