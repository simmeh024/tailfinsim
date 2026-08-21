# ADR-0003: Deploy by git checkout and systemd, not a container pipeline

- **Status:** Accepted
- **Date:** 2026-08-17
- **Amended:** 2026-08-19 — revisited under OPS-06 and kept, for a different reason than
  it was originally taken. See [Revisited](#revisited-august-2026--decision-kept).
- **Amended:** 2026-08-20 — OPS-05 resolved migration failure under ADR-0016; production
  promotion remains manual until this ADR is explicitly changed.
- **Deciders:** @simmeh024

## Context

`tailfinsim.com` is registered at DreamHost, and the decision was to keep hosting there
too. Three questions followed, and they are worth separating because only the first has an
objectively correct answer.

### Can Tailfin run on shared hosting by uploading files?

No. Verified rather than assumed:

- **No PostgreSQL.** DreamHost shared hosting provides MySQL only; PostgreSQL requires a
  server with root. All persistence (M0-05 onward) is Postgres, including `jsonb` for
  livery documents and versioned economy config.
- **Long-running processes are killed.** DreamHost's monitor service reaps processes on
  shared hosting that exceed CPU or memory limits. Tailfin's premise is a tick loop that
  never stops (§3.1, "the sim never pauses") — precisely that shape of process.
- **It is actively discouraged.** DreamHost's own guidance warns against Node.js on shared
  hosting, and their security scanning will lock an account that appears to be compiling
  Node. Passenger, their supported Node path, also handles WebSockets poorly, and M12-01 is
  real-time WebSocket sync.

### Which DreamHost product, then?

**DreamCompute** (OpenStack IaaS, full root). Not "DreamHost VPS" — sudo was removed from
VPS plans, so Postgres, Docker and systemd units are all unavailable there. The name is the
trap.

### Container pipeline or plain git checkout?

This is the actual decision, and it is a trade rather than a constraint.

A container pipeline was built first: multi-stage Dockerfile, images to GHCR on merge, and
a GitHub environment with a required reviewer gating promotion. It worked — 236 MB image,
verified running and draining correctly. It was then removed in favour of the simpler
approach, deliberately.

## Decision

Deploy by checking out a commit on the server and restarting a systemd unit:

```
./deploy/deploy.sh [ref]   →   fetch · checkout · install · build · migrate · restart · health check
```

Postgres and Caddy come from `apt`. No Docker on the server, no registry, no CI
involvement in deployment. **Running the command is the approval step.**

Local development keeps using Docker Compose for Postgres (root `docker-compose.yml`) —
that is a convenience for the developer machine and unrelated to how production runs.

## Consequences

### What this makes easier

- Far fewer moving parts to understand or debug. The server runs `node dist/main.js` under
  systemd; there is no image, layer cache, registry auth or container network in the way.
- No credential anywhere that lets GitHub reach production. Nothing to leak, nothing to
  rotate, no deploy key.
- `git -C /srv/tailfin log -1` answers "what is running" directly.
- Smaller instance. Without Docker overhead, `lightspeed` (4 GB, $24/mo) is a reasonable
  start rather than `warpspeed`.

### What this makes harder

- **Builds run on the production box.** A deploy needs dev dependencies and a few hundred
  MB of `node_modules`, and a broken build is discovered on the server rather than in CI.
  Mitigated by ordering: build, migration preflight, a verified recovery point when files are
  pending, atomic migrate, then restart. A failure before restart leaves the running service
  untouched and ADR-0016 requires the resulting schema to remain compatible with it.
- **Rollback is slower and can itself fail.** Re-checkout plus rebuild takes minutes and
  depends on the build working, where moving an image tag took seconds and pointed at an
  artefact already known to build.
- **The box accumulates state** and is not reproducible from source. Rebuilding it means
  following `deploy/README.md` again by hand.
- **No deploy audit trail** beyond shell history and the systemd journal.

### What we accept

That a bad merge is recovered from by rebuilding rather than by reverting to a known-good
artefact. This is a real cost given the backlog is largely worked by coding agents, where
"roll back to the last thing that definitely built" has more value than usual. It is
accepted in exchange for a system one person can hold in their head.

## Alternatives considered

| Option                                       | Why not                                                                                                                                                                |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Container pipeline with approval gate        | Built and verified, then removed. Correct for a team or for traffic that makes rollback speed matter; more machinery than a solo pre-MVP project needs to carry today. |
| Push-based deploy over SSH from CI           | Requires an SSH private key in repository secrets. Anything that compromises the repo or a workflow gets shell on production.                                          |
| Serverless                                   | Structurally incompatible with a continuous tick loop and long-lived WebSockets.                                                                                       |
| A non-DreamHost host (Fly, Railway, Hetzner) | Better regions and managed Postgres, but the explicit preference was to keep everything with DreamHost.                                                                |

## Revisit when

- A bad deploy causes real downtime that a tag move would have avoided.
- The instance is too small to build on, or a build on the box degrades live service.
- More than one person deploys, at which point an audit trail and a gate start earning
  their keep.
- Latency becomes the complaint: DreamCompute is US-only and the instance is in US-East 2,
  which is roughly 90–110 ms from European players.

## Revisited, August 2026 — decision kept

Two of the conditions above were met: a deploy that a tag move would have avoided was
missed, and the backlog began being worked by an agent producing frequent merges.
[OPS-06](https://github.com/simmeh024/tailfinsim/issues/174) proposed reversing this ADR
so that merging to `main` deployed production automatically. **That proposal was itself
reversed**, and this decision stands. The reasoning is recorded here because it is a
different reasoning from the original one.

The original argument was about credentials: push-based deployment needs an SSH key in
repository secrets, the repository is public, and anything compromising a workflow would
get a shell on production. That argument is unchanged and still holds.

### GitHub credential boundary re-verified under OPS-06

This was checked against the repository and GitHub APIs on 2026-08-20 rather than inferred
from the absence of a deploy workflow:

| GitHub surface                                           | Observed state |
| -------------------------------------------------------- | -------------- |
| Actions, Dependabot and Codespaces secrets               | 0 each         |
| Actions variables and environments                       | 0 each         |
| Deploy keys, repository webhooks and self-hosted runners | 0 each         |
| Default workflow token                                   | Read-only      |

All three workflows run on GitHub-hosted `ubuntu-latest`. None requests an OIDC token,
contains an SSH/deploy step or names the production host. The only job-level token writes
are CodeQL security results and Dependency Review failure comments on pull requests. The
production checkout fetches the public repository outbound; GitHub holds no private key,
secret, environment, webhook or runner connection that can initiate access to the box.

That is the invariant, not just a point-in-time inventory: adding any GitHub environment,
secret, deploy key, webhook, self-hosted runner or OIDC trust capable of reaching production
changes this ADR and requires a new explicit decision.

The argument that kept it in 2026 is about **the database**:

- A deploy runs migrations. Applying a schema change to production with nobody watching is
  a different risk class from applying code.
- At the time, [OPS-05](https://github.com/simmeh024/tailfinsim/issues/173) was still open, so
  there was no migration-failure strategy. Automating the thing that runs migrations before
  deciding what happens when one fails would have been the wrong order. OPS-05 is now resolved
  by [ADR-0016](0016-migration-failure-strategy.md): atomic batches, expand/contract
  compatibility, a verified pre-migration dump and an explicit observed failure state.
- A failed health check does **not** roll back. `deploy.sh` leaves the new code serving and
  exits non-zero, so the failure mode of an unattended deploy is a broken site nobody has
  been told about.

What changed instead is everything either side of the human step. Drift is now visible
without an SSH session ([OPS-02](https://github.com/simmeh024/tailfinsim/issues/170),
shipped), dev is to track `main` automatically
([OPS-17](https://github.com/simmeh024/tailfinsim/issues/320)), and the promotion itself is
to gain a pre-flight that says which migrations are about to run
([OPS-18](https://github.com/simmeh024/tailfinsim/issues/321)). The workflow this defines is
that **merge means _staged_**. On the normal `main` release line, **`dev ≥ prod`** and the
gap between their build numbers is the count of changes tested but not released. A dev
checkout pinned to an unmerged preview branch is explicitly outside that ordering.

OPS-05 has now landed, satisfying this revision's revisit signal. That removes one argument
against continuous deployment; it does not silently reverse the manual-promotion decision.
Revisit this ADR explicitly if OPS-17/OPS-18 or a later issue proposes production automation,
including the still-open fact that a failed post-restart health check does not roll back.
