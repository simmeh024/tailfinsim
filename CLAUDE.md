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

**Never print a secret into the transcript.** Not from `.env`, not from a credential
helper, not "just to check it is set". Generate secrets on the box, write them to
root-only files, and tell the user the command to read them.

**`main` is protected.** Pull request required, `typecheck · lint · test` must pass, force
pushes and deletions blocked, and it applies to admins. So: branch, push the branch, open a
PR. A direct push to `main` will be rejected, and that is working as intended.

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

The consequence is drift nobody sees. In August 2026 production sat 27 commits behind
`main` for a day, unnoticed. [OPS-02] and [OPS-06] exist to fix both halves of this.

**Do not say "deployed" when you mean "merged".**

---

## The two environments

Both run on one DreamCompute box, `208.113.129.131`. Same repo, same build, different
checkout, port, database and audience.

|                   | production               | dev                            |
| ----------------- | ------------------------ | ------------------------------ |
| URL               | `tailfinsim.com`         | `dev.tailfinsim.com`           |
| the user calls it | **front door**           | **back door**                  |
| checkout          | `/srv/tailfin`           | `/srv/tailfin-dev`             |
| service           | `tailfin`                | `tailfin-dev`                  |
| port              | 3000                     | 3001                           |
| database          | `tailfin`                | `tailfin_dev`                  |
| deploy with       | `./deploy/deploy.sh`     | `./deploy/deploy-dev.sh <ref>` |
| accepts           | any ref today ([OPS-01]) | **any ref, deliberately**      |
| `WEB_SURFACE`     | unset → **holding page** | `app` → the real client        |
| access            | public                   | HTTP basic auth, `noindex`     |

**Dev is the preview environment and is meant to run unmerged branches.** That is a
standing decision, not an oversight — it is where the user reviews work before merging.

**`WEB_SURFACE` lives in the box's `.env`, not in the code.** Production still serves the
holding page, and promoting the app is that one variable plus a deploy — not a different
build. Never couple deployment to it.

A deploy runs: fetch → `checkout --detach` → install → build → **migrate** → restart →
health poll. A failure before the restart leaves the running service untouched. A failed
health check does **not** roll back; the new code is already serving.

---

## Conventions

**Branches:** `feat/<issue-key>-<slug>`, `fix/<slug>`, `chore/<slug>`. There is no
`develop`. Everything targets `main`.

**Issues and PRs:** one issue per PR where practical. Issue titles are `[M1-07] Sentence
case`. Reference the key in the branch name and the commit subject.

**GitHub honours one issue per closing keyword.** `Closes #17 and #18` closes **#17 only**,
and a closing keyword in a _comment_ never fires at all. Write `Closes #17` and
`Closes #18` on separate lines, then check both actually closed.

**Architectural decisions get an ADR** in [`docs/adr/`](docs/adr/). If you find yourself
explaining a choice twice, write it down once instead. ADR-0003 (deployment) and ADR-0005
(world epoch and reset) are the two that constrain operations.

**Milestones:** `M0`–`M15` are the game backlog. `M1A` is the admin console core.
`OPS · Delivery & Operations` is deployment, backups and infrastructure — deliberately
outside the feature sequence, since none of it is game behaviour.

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
  raw aggregates like `min()`; the driver returns a string. This typechecked happily and
  threw on real Postgres.
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
