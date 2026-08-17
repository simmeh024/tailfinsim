# ADR-0003: Deploy by git checkout and systemd, not a container pipeline

- **Status:** Accepted
- **Date:** 2026-08-17
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
  Mitigated by ordering: build, then migrate, then restart — a failure at any step leaves
  the running service untouched.
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
