# Working on Tailfin

Instructions for coding agents. [`CONTRIBUTING.md`](CONTRIBUTING.md) covers how the code
is written — the four invariants, the package graph, the commands. This file covers how
the project is **operated**, which is the part that is not visible from the code and where
the expensive mistakes have actually been made.

Everything here was learned by getting it wrong at least once.

---

## The rules that are not negotiable

**Never run the database-backed tests against dev or production.** They are destructive by
design: they create and delete players, and one of them arranges for there to be exactly
one admin in order to prove the last one cannot be revoked. This was run once against the
dev box — by sourcing that box's `.env` for a real `DATABASE_URL` — and it revoked a real
person's admin access. `packages/server/src/test-setup.ts` now refuses any database whose
name does not end in `_test` or `_ci`, but do not rely on the guard to remember the rule
for you. Run them in CI.

**Never `git add -A`.** Stage files explicitly, by path. A `.pem` was committed this way
once. `.claude/` and other untracked directories sit in this working tree routinely.

**Never `git checkout --` a file that has uncommitted work in it.** It restores from the
index, so it does not undo an experiment — it destroys everything not yet committed.
Reached for once to revert a deliberate mutation-test edit, on a file holding an
afternoon's unstaged changes; it silently did nothing that time, which was luck rather
than safety. Reverse the edit you made, or commit before you break something on purpose.

**Never print a secret into the transcript.** Not from `.env`, not from a credential
helper, not "just to check it is set". Generate secrets on the box, write them to
root-only files, and tell the user the command to read them.

**`main` is protected.** Pull request required, `typecheck · lint · test` and
`dependency review` must pass, force pushes and deletions blocked, and it applies to
admins. So: branch, push the branch, open a PR. A direct push to `main` will be rejected,
and that is working as intended. Required approvals are set to **zero** — the PR is the
gate, not a second person — so you can merge your own once the checks are green.

---

## Merging does not deploy anything

This is the single most misleading thing about the setup, and the easiest thing to tell the
user wrongly.

```
merge to main  →  main updates on GitHub  →  CI runs on main  →  nothing else happens
```

Production moves **only** when a human runs `./deploy/deploy.sh` on the server. There is no
webhook, no scheduler, no runner. ADR-0003 chose this deliberately: _"running the command
is the approval step"_, and no credential anywhere lets GitHub reach production.

That was revisited in August 2026 and **kept** — see
[OPS-06](https://github.com/simmeh024/tailfinsim/issues/174), which had previously proposed
the opposite. The workflow it settles on is:

```
merged to main  →  CI green  →  dev deploys automatically   (OPS-17, not built)
                                        ↓  reviewed on dev
                            promoted to production, by a human   (OPS-18, not built)
```

So **merge means _staged_, not released**, and `dev build − prod build` is the count of
changes tested but not shipped. Three things argued against automating the last step:
deploys run migrations, OPS-05 has no migration-failure strategy yet, and a failed health
check does not roll back.

The consequence is drift, and it used to be drift nobody could see — in August 2026
production sat 27 commits behind `main` for a day, unnoticed. **`pnpm ops:status` answers
that now** (OPS-02, shipped), from anywhere and without an SSH session. Run it before
telling the user where anything is.

**Do not say "deployed" when you mean "merged".**

---

## The two environments

Both run on one DreamCompute box, `208.113.129.131`. Same repo, same build, different
checkout, port, database and audience.

|                   | production                 | dev                            |
| ----------------- | -------------------------- | ------------------------------ |
| URL               | `tailfinsim.com`           | `dev.tailfinsim.com`           |
| the user calls it | **front door**             | **back door**                  |
| checkout          | `/srv/tailfin`             | `/srv/tailfin-dev`             |
| service           | `tailfin`                  | `tailfin-dev`                  |
| port              | 3000                       | 3001                           |
| database          | `tailfin`                  | `tailfin_dev`                  |
| deploy with       | `./deploy/deploy.sh`       | `./deploy/deploy-dev.sh <ref>` |
| accepts           | **only commits on `main`** | **any ref, deliberately**      |
| `WEB_SURFACE`     | unset → **holding page**   | `app` → the real client        |
| access            | public                     | Google sign-in, `noindex`      |

**Dev is the preview environment and is meant to run unmerged branches.** That is a
standing decision, not an oversight — it is where the user reviews work before merging.

**`WEB_SURFACE` lives in the box's `.env`, not in the code.** Production still serves the
holding page, and promoting the app is that one variable plus a deploy — not a different
build. Never couple deployment to it.

A deploy runs: fetch → `checkout --detach` → install → build → **migrate** → restart →
health poll. A failure before the restart leaves the running service untouched. A failed
health check does **not** roll back; the new code is already serving.

---

## What is actually running

Two facts that are not visible from the code and cost time to rediscover.

**Nothing runs the simulation.** `createTickLoop` and `drainDueEvents` are built, tested,
and called by **no process** in any environment. There is no cron, no timer, no loop in
`main.ts`. So no world advances beyond its derived clock, no event is ever drained, and
any "ticks: 0, errors: 0" reading means _nothing has run_, not _everything is fine_. The
admin console's health page infers liveness from the queue instead, precisely so it cannot
report a stopped engine as healthy.

Where the engine should live is [OPS-08](https://github.com/simmeh024/tailfinsim/issues/187)'s
decision — a separate worker process, not the web process. Do not wire the loop into
`main.ts` as a convenience; that prejudges it.

**The admin console is real and is the place to look first.** `/admin`, for accounts
holding a grant: overview with server-decided alerts, world creation, speed changes, the
open/lock/archive/reset lifecycle, world health, a read-only player browser, and the audit
log. Anything it can answer is faster than SSH, and every mutation it performs is audited
in the same transaction as the change.

The four-node dev/production web/worker split is planned in
[OPS-08 – OPS-16](https://github.com/simmeh024/tailfinsim/issues/195). Read that sequence
before designing anything infrastructural; it already records the two things that bite —
the database has no home in the four-node diagram, and builds happen on the box.

---

## What runs on a pull request

Three workflows. **Two of them can stop a merge**, and the third deliberately cannot —
see the note in `codeql.yml` about why making an analyser a gate before anyone has read
what it finds is how a security tab fills with dismissed alerts.

| Workflow                | Job / check name          | Asks                                                 | Blocks? |
| ----------------------- | ------------------------- | ---------------------------------------------------- | ------- |
| `ci.yml`                | `typecheck · lint · test` | Does it build, lint, format and pass its tests?      | **Yes** |
| `dependency-review.yml` | `dependency review`       | Did this PR add a known-vulnerable dependency?       | **Yes** |
| `codeql.yml`            | `analyze (…)`             | Does Tailfin's own code contain a dangerous pattern? | No      |

They are separate workflows on purpose. CI needs a Postgres service and takes about two
minutes; CodeQL takes longer than that again; Dependency Review needs no services, no
checkout and no install, and finishes in seconds. Merging them would make the fast checks
wait behind the slow ones.

### Dependency Review (SEC-HARD-03)

Compares the dependency graph of `main` against the graph of the branch and fails on what
the **diff added**. Runtime _and_ development scopes, direct _and_ transitive.

- **Blocks:** high, critical.
- **Does not block:** moderate, low — reported in the run summary only.
- **Comments on the PR only when it fails.** A clean PR gets no comment and no annotation.
- **Overrides are a code change, not a click** — `allow-ghsas` in the workflow, with the
  reason written in the same diff. See CONTRIBUTING.md.

Two things it is _not_. It is not an audit of the existing tree — a package that was
already vulnerable before your branch is invisible to it, by design, because a gate that
fails on pre-existing findings fails every PR equally. And it is not a code scanner: it
reads the GitHub Advisory Database, CodeQL reads the source, and neither finds what the
other finds.

**It works here because the dependency graph parses `pnpm-lock.yaml`.** That was checked
rather than assumed — the SBOM endpoint returns 458 packages at exact versions, so
transitives are covered, not just the manifests. Worth re-checking if the package manager
ever changes.

---

## Conventions

**Branches:** `feat/<issue-key>-<slug>`, `fix/<slug>`, `chore/<slug>`. There is no
`develop`. Everything targets `main`.

**Issues and PRs:** one issue per PR where practical. Issue titles are `[M1-07] Sentence
case`. Reference the key in the branch name and the commit subject.

**GitHub honours one issue per closing keyword.** `Closes #17 and #18` closes **#17 only**,
and a closing keyword in a _comment_ never fires at all. Write `Closes #17` and
`Closes #18` on separate lines, then check both actually closed.

**One-off jobs run from `dist`, not from source.** `data:airports`, `data:classify`,
`data:catchment`, `data:timezones`, `data:distances`, `world:seed`, `demand:generate`,
`admin` and `ops:status` are all bundled entry points, so `pnpm build:apps` has to have
run first. The order matters for a new world — airports, then tiers, then catchment, then
distances, then the world, then its demand pools — because each reads what the last one
wrote. `data:timezones` is the exception and needs only the airports. CONTRIBUTING.md has
the table.

CI builds the bundles on every pull request and asserts that each of those entry points
actually lands in `dist`, so an entry point dropped from `build.mjs` fails the run rather
than being discovered the next time somebody needs the command.

**Architectural decisions get an ADR** in [`docs/adr/`](docs/adr/). If you find yourself
explaining a choice twice, write it down once instead. ADR-0003 (deployment) and ADR-0005
(world epoch and reset) are the two that constrain operations.

**Milestones:** 273 issues across 23 of them. `M0`–`M15` are the game backlog and `M1A`
is the admin console core. The rest are cross-cutting tracks that deliberately sit outside
the feature sequence, because none of them are game behaviour:

| Track      | What it covers                                                        |
| ---------- | --------------------------------------------------------------------- |
| `OPS`      | Deployment, backups, infrastructure                                   |
| `SEC`      | Authorization and ownership                                           |
| `SEC-HARD` | Security hardening                                                    |
| `AUTH`     | Multi-method authentication                                           |
| `E2E`      | Browser and end-to-end testing                                        |
| `POD`      | The poster shop — post-launch, and the first thing needing real money |

Complete so far: **M0**, **M1**, **M1A** and **M2**. `M3 · Demand & Commercial` has
started.

---

## Verification

**Prove mechanisms; do not assert them.** The habit that has caught the most: check that
tests actually _ran_ rather than silently skipped, read the CI log rather than the badge,
and query the live system rather than the config that was supposed to produce it.

Specific traps met so far:

- **Database tests skip without `DATABASE_URL`.** A green local run means very little for
  server work. CI is where they run.
- **Drizzle wraps driver errors.** Asserting on the outer `Failed query: …` message passes
  for _any_ failure. Walk `error.cause` for what Postgres actually said.
- **`sql<Date>` is an assertion, not a conversion.** Column type parsers do not apply to
  raw aggregates like `min()` or `max()`; the driver returns a string. This typechecked
  happily and threw on real Postgres. Drizzle's own `max(column)` helper has the same
  problem with a friendlier face: it types the result as the column's type, which is a
  lie for the same reason. Normalise at the boundary.
- **A correlated subquery in a drizzle `select` list came back empty** against real
  Postgres — zeros and nulls for rows that demonstrably had data — while the _same_
  correlated shape in a `where` clause worked. Not diagnosed. If a count looks
  impossibly low, prefer a grouped query and a lookup, which is the pattern
  `countWorldContents` and `listPlayers` use.
- **Performance measured on a laptop is not the criterion.** M1-08's budget says "on the
  server", and the server is a 2-core Xeon E5-2620 v4 — five times slower than the
  development machine. Measure there, and take the fastest of several runs, because a
  single sample on a shared box measures the neighbours.
- **Effects that arrive in a later React effect race a test that waits for the first
  render.** The build badge's clock has caused this twice.

---

## Before ending a turn

- Did anything change that only exists on the server (a grant, a world, a config)? Say so
  explicitly — it is invisible in the diff and lost to the next session otherwise.
- Did a test or command touch a real database? Say which, and what it changed.
- If a claim was measured, say where it was measured.
