# ADR-0024: Local aircraft-generation approval and credit history

- **Status:** Accepted
- **Date:** 2026-08-28
- **Scope:** M6-25 (#791), operator tooling only

## Context

The offline preflight cannot authorize spending. A pure budget object also cannot prevent two
processes from both reserving the same allowance, or remember a paid submission after its process
crashes. The user approved one first-run ceiling, not a new ceiling for every command or worktree.
No shared livery/aircraft admission schema changes are needed to solve this local boundary.

## Decision

Use one SQLite store under the repository's **Git common directory**, at
`tailfin-aircraft-factory/a320neo-first-run.sqlite`. The CLI resolves this from its own repository,
not the invoking directory, and exposes neither a state-root override nor another run ID. Linked
worktrees share the store. Initialization exclusively creates the file and refuses every existing
file, including an incomplete initialization; it is not a reset command.

The first snapshot records the explicit user-confirmation reference, consent-artifact hash, exact
specification hash, whole-number ceiling and scope. Fallback and production-publication authority
are false. That audit record does not authenticate a user: the local operator must actually have
the referenced consent. Keep its source evidence privately alongside other factory evidence.

SQLite `BEGIN IMMEDIATE` serializes writers. `journal_mode=DELETE` and `synchronous=EXTRA` are
checked at runtime before writing; EXTRA includes the rollback-journal directory synchronization
that FULL alone can omit. Transactions contain only local validation and append-only snapshots.
The expected future sequence is:

```text
reserve + COMMIT → submit once → persist returned task ID → reconcile terminal charge
                       ↓ uncertain result/crash
             retain reservation; do not resubmit
```

The store rejects changed ceilings/specifications, duplicate operation/task IDs, disappearing
history, regressed observations and replaced human selections. Reservations remain consumed for
budget purposes even if a task fails or reports zero charge. An unexpected charge is recorded,
not discarded; any price increase halts further reservations. Selection requires four terminal
candidates and a successful chosen task, with an evidence hash, before retexture reservation.
It does not itself perform the human review or verify the evidence's contents.

Snapshots have a canonical SHA-256 chain, sequential indices and strict schemas; ordinary SQL
UPDATE/DELETE is refused by triggers. Every open revalidates history. Duplicate identical
observations do not append another snapshot. The first-run store is bounded to 256 snapshots,
64 KiB per snapshot and a 32 MiB file; reaching a limit fails closed, never truncates history.

Use the pinned Node runtime's built-in `node:sqlite`, avoiding a separate native dependency.
Node 24 documents this API as release-candidate stability; the repository runtime pin and real
process-level tests are part of the compatibility gate. This is a local-disk, single-host design,
not a network-share or distributed ledger. Cross-process locking and process-exit recovery are
tested; hardware power-failure behavior depends on SQLite, the OS and honest storage flushes.
[Node API source](https://github.com/nodejs/node/blob/v24.x/doc/api/sqlite.md),
[SQLite synchronization](https://www.sqlite.org/pragma.html#pragma_synchronous),
[SQLite atomic commit](https://www.sqlite.org/atomiccommit.html).

## Read-only provider access and quarantine

`assets:meshy-run account` requires the stored approval, matching current spec/ceiling and a local
credential. It only GETs the fixed HTTPS balance endpoint: redirects are refused; each request has
a ten-second abort deadline; transient failures have at most three attempts; decoded JSON is
limited to 4 KiB. Only the numeric balance and fixed readiness fields escape. Authentication errors,
transport errors and provider bodies cannot echo a credential. Neither the key nor its file path is
persisted. Balance is not a plan/private-license check or permission to publish.

Candidate provenance is a separate, quarantine-only descriptor. It binds the exact spec, approval,
task/input-task IDs, generation date and content digests for the reference, rights, terms, private
plan evidence and untouched export. Missing artifacts stay explicit. A digest descriptor is not
proof that bytes were downloaded or verified, and cannot become an accepted runtime asset.

The read-only `sync` follow-up recovers only already recorded Image-to-3D candidate IDs. It commits
terminal charges before output retrieval, deduplicates status/charge updates inside the transaction,
and never adopts an uncertain request. Task GETs have three attempts, 10-second deadlines and 64 KiB
decoded bodies. Output GETs allow only HTTPS `assets.meshy.ai`, without credentials or redirects,
with three attempts, 30-second deadlines and 64 MiB decoded GLBs. The container envelope is checked;
no embedded/external resource is evaluated and no geometry/licence admission is implied.

Archives are adjacent to the shared ledger. Unique temporary files are flushed, then hard-linked
to immutable final names without replacement; the temporary link is removed. The sanitized manifest
is published last. Existing blobs/manifests must match, or recovery fails closed. On Windows the
file contents are flushed but Node cannot flush a directory; interrupted/missing/corrupt archives
require inspection, never an automatic overwrite. POSIX also flushes the directory. A process crash
can leave an orphan temporary link; preserve it for inspection. Duplicate polling cannot change an
archived receipt's timestamp. Signed URLs remain ephemeral and no raw task JSON is persisted.

No paid generation transport, candidate promotion or registry mutation is enabled by this decision.
Complete provenance and paid orchestration remain #791 follow-ups; authoring/selection belongs to #792 and
admission/licensing to #793. Paid submission must validate actual reference/evidence bytes and
fresh provider pricing before using a durable reservation.
Serialize paid candidates until prior charges are terminal: nonterminal `consumed_credits` is only
an observation and the ledger does not certify its final value. Separate texture maps, thumbnails
and retexture outputs are outside this GLB-only recovery increment.

## Recovery and limitations

Never delete/recreate, rewind, copy an older backup over, or move this store to obtain more credit.
An incomplete/corrupt store or uncertain submission requires operator reconciliation with Meshy
before any paid transport is enabled. Preserve the database and any journal together; there is no
automatic repair or reset command. Do not migrate active runs between independent clones/hosts.

The chain and SQL guards detect accidental edits, not a malicious workstation owner who can
replace the entire database or executable. No local implementation can prove a deleted history
never existed. Private evidence and filesystem permissions remain the operator's responsibility;
Windows inherits ACLs, while newly created POSIX directories/files request 0700/0600. Nothing is
installed on Web/Worker nodes and no application database is involved.
