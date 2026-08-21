# Deployment & connections

Status: **live.** The DreamCompute instance exists and serves both `tailfinsim.com` (the
holding page) and `dev.tailfinsim.com` (the application). This document is the reasoning —
why this hosting, this topology, these records. The step-by-step runbook for building the
box is [`deploy/README.md`](../deploy/README.md); the operational rules are
[`CLAUDE.md`](../CLAUDE.md).

---

## 1. The hosting constraint, stated plainly

Tailfin is not a website. It is a stateful, always-on process:

- a **continuous tick loop** that must keep running when nobody is connected (§3.1 — "the
  sim never pauses");
- **long-lived WebSocket connections** for real-time state sync (M12-01);
- **Postgres** as the system of record.

That rules out two of DreamHost's four products:

| DreamHost product | Verdict               | Why                                                                                                                         |
| ----------------- | --------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Shared hosting    | ✗ Cannot run Tailfin  | PHP and static files. No persistent process, no Postgres.                                                                   |
| VPS (managed)     | ✗ Cannot run Tailfin  | DreamHost **removed sudo from VPS plans**. Without root you cannot install Postgres, Docker, or register a systemd service. |
| **DreamCompute**  | ✓ **This is the one** | OpenStack IaaS. Full root on your own Ubuntu VM.                                                                            |
| Dedicated server  | ✓ Works               | Also root, but heavy overkill and expensive for MVP.                                                                        |

**Do not buy a DreamHost VPS for this.** The name is the trap — it is the one product
whose name suggests it would work and which specifically will not. Confirm current
product capabilities at purchase time; DreamHost's lineup does change.

## 2. Target topology

A single DreamCompute instance running everything behind one reverse proxy:

```
                    tailfinsim.com
                          │
                          ▼
              ┌───────────────────────┐
              │  Caddy (TLS, :443)    │   automatic Let's Encrypt
              └───────────┬───────────┘
                          │
          ┌───────────────┼────────────────┐
          ▼               ▼                ▼
     /  → web        /api → server    /ws → server
     built client     Fastify          WebSocket —
     (WEB_SURFACE)                     M12-01, not built
                          │
                          ▼
                    Postgres 16
```

The security trust-boundary view—including dev, SSH, Google OAuth, GitHub and the backup
path—is in [ADR-0012](adr/0012-tailfin-threat-model.md). This topology and that threat model
must be updated together when OPS-08 splits web and worker or OPS-11 moves PostgreSQL; a new
node or provider is a new trust boundary, not just a deployment detail.

**One origin, deliberately.** The client and API share `tailfinsim.com` rather than
splitting into `app.` and `api.` subdomains. This is not laziness — M0-11 specifies
session auth with httpOnly secure cookies, and same-origin means `SameSite=Lax` works
with no CORS configuration, no cookie-domain juggling and no preflight on every call.
Split them only when there is a reason, and take the cookie complexity on knowingly.

**Browser security policy lives at the edge.** Caddy applies the same CSP, frame denial,
Permissions Policy, HSTS, content-type and referrer controls to the holding page, application,
API and error responses on both hosts. Google OAuth needs no CSP exception because it is a
top-level navigation; the one external resource exception is
`https://lh3.googleusercontent.com` for player avatars. The exact policy, rollout decision
and rejected HSTS preload option are in
[ADR-0014](adr/0014-browser-security-policy.md).

The source default is enforced, while the first installation deliberately overrides the
header name to `Content-Security-Policy-Report-Only`. The operator removes that override
only after the real dev sign-in/avatar journey is clean, then repeats it with enforcement.
This is an edge-config rollout, not an application deploy: neither deploy script copies
`deploy/Caddyfile`. [`deploy/README.md`](../deploy/README.md#first-security-policy-rollout-sec-hard-05)
has the commands, and `pnpm security:headers` asserts exact values against the running hosts.

### Sizing

DreamCompute flavours and prices, read from the panel on 2026-08-17. The monthly figure
is a **ceiling** — billing caps at 600 hours (25 days) per month, and further hours in
that cycle are free.

| Flavor       | vCPU | RAM    | Hourly    | Max monthly | Verdict for Tailfin                           |
| ------------ | ---- | ------ | --------- | ----------- | --------------------------------------------- |
| `semisonic`  | 1    | 512 MB | $0.0075   | $4.50       | Too small — Postgres alone will not be happy. |
| `subsonic`   | 1    | 1 GB   | $0.01     | $6.00       | Too small.                                    |
| `supersonic` | 1    | 2 GB   | $0.02     | $12.00      | Fine for **staging**.                         |
| `lightspeed` | 2    | 4 GB   | **$0.04** | **$24.00**  | **Recommended start.**                        |
| `warpspeed`  | 4    | 8 GB   | $0.08     | $48.00      | Headroom if builds on the box feel tight.     |
| `hyperspeed` | 8    | 16 GB  | $0.16     | $96.00      | Only once load testing (M13-04) says so.      |

Postgres wants 2–4 GB before the sim gets any, which is what rules out the bottom two.
There is no Docker on the server (ADR-0003), so `lightspeed` is enough to start — but note
that deploys build on the box, so if `pnpm install && build` starts contending with live
traffic, that is the signal to move up.

All accounts include 100 GB of block storage and free bandwidth.

**Status (2026-08-19):** running on one `lightspeed` instance in `US-East 2` (`iad2`),
serving production and dev from the same box — separate checkout, port, database and
service. 2 GB of swap was added because deploys build on the machine and 4 GB is tight
while bundling.

Splitting dev from production, and web from worker, is
[OPS-08 – OPS-16](https://github.com/simmeh024/tailfinsim/issues/195). That plan raises a
question this section does not answer: **where Postgres lives** once the app is on more
than one node. Today it is local, reached over a loopback socket, and `backup.sh` depends
on that through peer authentication.

Note for the launch wizard: attaching the instance to the **`public`** network gives it a
routable IPv4 directly, so **no floating IP is involved**. And if booting from a new volume,
the wizard's default volume size of 4 GB is smaller than the Ubuntu 24.04 image — see
[`deploy/README.md`](../deploy/README.md) for the full wizard settings and why.

## 3. DNS records to create

In the DreamHost panel: **Domains → Manage Domains → DNS** for `tailfinsim.com`.

These records exist and resolve. Kept here because a rebuild — or the multi-node split —
means recreating them, and because the omissions below are deliberate rather than forgotten.

| Type | Host          | Value           | Purpose                      |
| ---- | ------------- | --------------- | ---------------------------- |
| `A`  | _(blank / @)_ | `<instance IP>` | Apex → the app               |
| `A`  | `www`         | `<instance IP>` | Caddy redirects `www` → apex |
| `A`  | `dev`         | `<instance IP>` | Dev — the same box today     |

Leave everything else empty for now. In particular:

- **No MX record yet.** M0-11 chose Google OAuth ([ADR-0004](adr/0004-google-oauth.md)), so
  sign-in needs no mail. Transactional email is **M14**, and its provider will supply its
  own SPF/DKIM/DMARC records (M14-02) — adding mail DNS before choosing the provider means
  redoing it.
- **No CAA record yet**, but consider adding one once TLS is live to restrict which CAs
  may issue for the domain.

### TLS

Caddy obtains and renews Let's Encrypt certificates automatically. DreamHost's own free
certificate offer applies to DreamHost-_hosted_ sites and does **not** cover DreamCompute
instances — do not wait for it.

DNS must resolve to the instance **before** Caddy starts, or the ACME HTTP-01 challenge
fails. Propagation on a fresh domain with no prior records is usually minutes.

## 4. Environment variables

Read by the server at boot from a `.env` beside the bundle.

**Only `DATABASE_URL` is genuinely required** — everything else has a default, and the
defaults are chosen to be safe rather than convenient: `WEB_SURFACE` serves a holding page,
`ALLOW_REGISTRATION` is closed, and `ENVIRONMENT_LABEL` is `local` because a box that
forgot to say which it is should not claim to be the live one. The "required" column below
reflects that; earlier versions of this table overstated it.

The three auth values are all-or-nothing: set together, or left unset. Setting only some is
refused at boot, because a half-configured sign-in looks like a working one and fails at
the callback, after the player has been sent to Google. Production also refuses a plain-HTTP
`PUBLIC_ORIGIN`; otherwise its session cookies would silently lose the `Secure` attribute.

| Variable                      | Example                                       | Required | Notes                                                  |
| ----------------------------- | --------------------------------------------- | -------- | ------------------------------------------------------ |
| `NODE_ENV`                    | `production`                                  | no       | `development` \| `test` \| `production`                |
| `PORT`                        | `3000`                                        | no       | Caddy proxies to this. Defaults to 3000                |
| `DATABASE_URL`                | `postgres://tailfin:…@localhost:5432/tailfin` | yes      | M0-05. Never hardcoded, never committed                |
| `DATABASE_POOL_MAX`           | `10`                                          | no       | Defaults to 10                                         |
| `DATABASE_CONNECT_TIMEOUT_MS` | `5000`                                        | no       | Defaults to 5000. `pg`'s own default waits forever     |
| `LOG_LEVEL`                   | `info`                                        | no       | Pino level; defaults to `info` in prod, `debug` in dev |
| `WEB_SURFACE`                 | `app`                                         | no       | `holding` (default) or `app`. What `/` serves          |
| `ENVIRONMENT_LABEL`           | `dev`                                         | no       | `local` (default), `dev`, `production`. Build badge    |
| `PUBLIC_ORIGIN`               | `https://tailfinsim.com`                      | no       | OAuth base; HTTPS is mandatory on production           |
| `GOOGLE_CLIENT_ID`            | `….apps.googleusercontent.com`                | no       | M0-11. All three auth vars together, or none           |
| `GOOGLE_CLIENT_SECRET`        | `GOCSPX-…`                                    | no       | Never logged, never echoed                             |
| `SESSION_SECRET`              | _(32+ random bytes, base64)_                  | no       | Signs the temporary OAuth state/PKCE cookie            |
| `SESSION_TTL_HOURS`           | `720`                                         | no       | Player TTL: 30 days for a persistent-world account     |
| `ADMIN_SESSION_TTL_HOURS`     | `12`                                          | no       | Admin TTL: one shift; must be shorter than player TTL  |
| `ALLOW_REGISTRATION`          | `false`                                       | no       | **Defaults to false.** Closed unless explicitly opened |
| `BACKUP_STATUS_FILE`          | `/var/lib/tailfin/backup-status.json`         | no       | Written by `backup.sh`, read by the admin overview     |

#### Worker-only (OPS-08)

Read by `worker.js` and by nothing else. A web node may hold them; they do nothing there.

| Variable                  | Example     | Required | Notes                                         |
| ------------------------- | ----------- | -------- | --------------------------------------------- |
| `WORKER_HEALTH_PORT`      | `3100`      | no       | Defaults to 3100. Deliberately **not** `PORT` |
| `WORKER_HEALTH_HOST`      | `127.0.0.1` | no       | Loopback only. Never proxy this through Caddy |
| `WORKER_TICK_INTERVAL_MS` | `1000`      | no       | Defaults to 1000, the coarse tick of §21      |

`WORKER_HEALTH_PORT` is a separate variable from `PORT` on purpose: one `.env` copied to a
worker node would otherwise bind the web port, or two services on one box would fight over 3000. 3100 keeps it clear of both 3000 (production web) and 3001 (dev web).

`WORKER_HEALTH_HOST` is loopback and is not read from `HOST`. The endpoint is
unauthenticated and describes the shape of the simulation; the web process's variable must
not be able to expose it.

### Build numbers (M0-12)

Every deploy carries a build number: `git rev-list --count HEAD`, stamped into
`packages/server/dist/build-info.json` by `build.mjs` and served from
`GET /api/version` alongside the short commit SHA and `ENVIRONMENT_LABEL`. The client
renders it bottom right on every screen.

Not a semantic version, deliberately. Nothing here is released to anyone, so there is
no compatibility to promise, and a hand-maintained version drifts the first time someone
forgets to bump it. This one is derived, so it cannot drift. A build made from a modified
working tree gets a `+dirty` suffix on the commit — that is the moment you most want to
know the running code is not the commit it claims to be.

The badge asks the **server**, not the bundle. A cached client reporting its own build
number would say what the browser last downloaded rather than what it is talking to.

**`/api/version` also reports `ref` and `deployedAt`** (OPS-02), written by `deploy.sh`
into `packages/server/dist/deploy-info.json` — a second file beside the build stamp,
because they are different facts. The build knows its commit; only the deploy knows that
somebody asked for `origin/main`, and when. `startedAt` cannot stand in for the latter:
it resets on every restart, including a crash loop, so it answers "how long has this
process been up" and never "how long has this code been live".

The ref is **recorded, not derived**. The box checks out with `--detach` deliberately, so
there is no branch on disk to read back, and reconstructing one afterwards
(`git describe --all --contains`) answers confidently and wrongly once a branch is
deleted. Both fields are `null` outside a deploy — a local `pnpm dev` has never been
deployed anywhere, and that reads as "not from a deploy" rather than as a wrong answer.

`ENVIRONMENT_LABEL` is separate from `NODE_ENV` because `NODE_ENV=production` on **both**
boxes — dev runs a production build of the same code, and that is the point of it. It
defaults to `local`, so a box that forgot to declare itself does not claim to be the live
one.

### Auth configuration (M0-11)

The three auth variables are **optional together**. Set all three and Google sign-in
works; set none and it is switched off — `/api/me` still answers, and the sign-in routes
return `503 auth_not_configured` rather than 404, so a client can tell "not configured
here" from "no such feature". Setting only some of them is refused at boot: a
half-configured server looks like working sign-in right up to the callback, by which
point the player has already been sent to Google.

That optionality is what lets production run this build today with no OAuth client of its
own. Each environment needs its **own** client, because Google matches the redirect URI
exactly:

    https://tailfinsim.com/api/auth/google/callback
    https://dev.tailfinsim.com/api/auth/google/callback

`ALLOW_REGISTRATION=false` refuses a Google account that has no player record, redirecting
to `/?auth_error=registration_closed`. Note the consequence: **the first account on a new
environment cannot be created while it is false**, because nobody's Google subject is
known until they have signed in once. Open it, sign in, close it again.

Secrets live in the instance's environment or a `.env` file readable only by the service
user — **never in the repository**. `.env` is gitignored; commit `.env.example` instead.

## 5. How deployment works

**No containers in production, and no CI involvement.** The server holds a git checkout;
deploying is one command run on the box. See
[ADR-0003](adr/0003-deployment-approach.md) for the reasoning and the costs.

OPS-06 defines the release boundary around that command. A green merge stages the next
release on `main`; OPS-17 will make dev track it automatically, and OPS-18 will make the
human promotion pre-flight explicit. The normal invariant is **`dev ≥ prod`**. A positive
`dev build − prod build` gap is tested work waiting for production, zero is alignment, and
a negative gap is an incident. An explicitly pinned unmerged dev preview is not comparable
to the `main` release line and is marked with `*` by `pnpm ops:status`.

OPS-17 and OPS-18 remain open, so today neither environment changes merely because a merge
completed. Production will continue to require a human unless this ADR is changed again.

```
ssh tailfin@<ip> → cd /srv/tailfin → ./deploy/deploy.sh
                          │
                          ├─ fetch · checkout the target commit (detached)
                          ├─ pnpm install --frozen-lockfile
                          ├─ build               ── fails here? nothing was touched
                          ├─ migration preflight ── actual database + policy + pending count
                          ├─ verified local dump ── only when migrations are pending
                          ├─ atomic migrate      ── classify rollback / commit / unknown
                          ├─ systemctl restart tailfin
                          └─ poll /healthz, print the rollback command on failure
```

**Running the command is the approval step.** Nothing automated can push to production,
and no credential exists that lets GitHub reach the instance.

Rollback is the same command with an older commit: `./deploy/deploy.sh <sha>`. That rolls
back _code_, not _schema_. OPS-05 therefore makes every new schema backward-compatible with
the previously deployed release instead of pretending checkout reverses SQL. Drizzle applies
the complete pending batch in one PostgreSQL transaction, and the deploy reports whether a
failed client left it rolled back, fully applied or unknown. See
[ADR-0016](adr/0016-migration-failure-strategy.md).

Postgres and Caddy are installed from `apt`. Docker is used **only** for local development
Postgres (root `docker-compose.yml`), which is a developer-machine convenience and has
nothing to do with how production runs.

Full step-by-step server setup: [`deploy/README.md`](../deploy/README.md).

### The trade-off, stated plainly

Builds run on the production box. A deploy needs dev dependencies and a few hundred MB of
`node_modules`, and a broken build is found on the server rather than in CI. `deploy.sh`
orders itself to limit the damage — build, preflight, verified recovery point, migrate, then
restart. A database failure leaves the old process serving a schema it is required to support,
but rollback still means rebuilding, takes minutes and can itself fail. A long migration also
holds its strongest lock for the whole pending batch; the 100,000-row OPS-05 experiment made
that cost visible rather than hypothetical.

## 6. Since settled

Four of the five questions this section used to list have answers. They are kept here,
answered, because the reasoning is more useful than the fact.

- **Static web assets** — settled. The server serves the built client from
  `packages/web/dist/client` when `WEB_SURFACE=app`, on the same origin as the API. No CDN.
  Production still has `WEB_SURFACE` unset and serves the holding page; promoting the app
  is that one variable plus a deploy.
- **Staging** — settled, though not as a second box. `dev.tailfinsim.com` shares this
  instance: separate checkout, port, database and service. Splitting it onto its own
  machine, along with a web/worker split, is [OPS-08 – OPS-16](https://github.com/simmeh024/tailfinsim/issues/195).
- **Backups** — settled by OPS-03, well ahead of M13-11. Nightly `pg_dump` at 03:15 UTC,
  verified by reading each archive's table of contents back, uploaded to DreamObjects with
  7 nightly and 12 monthly copies retained, and **an upload failure is a backup failure** —
  both the dump and its SHA-256 sidecar must leave the box. **The restore was rehearsed on
  2026-08-18** — which is how a 9.3 MB dump shrinking to 47 KB was noticed, and the dev
  airport dataset recovered. OPS-04 made that sequence repeatable: the command accepts only
  a `_test` target, downloads the newest off-box nightly, verifies it, migrates the restored
  schema, boots an isolated server, checks domain data and the Flagship clock, records RTO/RPO,
  and cleans up. The command-by-command procedure is in `deploy/README.md`.

  That first rehearsal also enabled a real selective recovery: a destructive test had removed
  the dev airport/runway dataset, while unrelated admin, world and audit changes continued.
  The pre-damage object was preserved outside automatic retention and only the empty dataset
  tables were restored. The runbook records the constraints; selective restore is an incident
  technique, not the default recovery procedure.

  Failure reaches a human three ways, because each covers what the others cannot: the
  script pings a dead-man's-switch on finishing, `OnFailure=` catches a run that died
  before it could report, and the switch's own grace period catches the run that never
  happened at all. Nothing on a dead box can report that the box is dead — which is why
  the third layer is a service _expecting_ a ping rather than an alert on an error.

- **Migration failure** — settled by OPS-05 and
  [ADR-0016](adr/0016-migration-failure-strategy.md). The actual Drizzle/PostgreSQL behavior
  was tested with a deliberately failing second migration: all pending files rolled back,
  while an `AccessExclusiveLock` was held across the batch. Future migrations declare expand
  or a separately staged contract and are checked for obvious incompatibility and
  non-transactional SQL. A non-empty deploy batch first takes a verified local dump through a
  root-owned systemd unit. The abnormal half-applied recovery path was rehearsed into a new
  `_test` database; the runbook has the exact inspection and cutover procedure.

- **Auth provider** — settled by [ADR-0004](adr/0004-google-oauth.md): Google OAuth, with
  an account model that tolerates more than one identity per player so adding a second
  provider is not a migration over live accounts.

## 7. What is still open

- **Region.** DreamCompute is US-only and the instance is in US-East 2 — roughly 90–110 ms
  from European players. Acceptable for a sim where a flight takes hours, but it is a real
  cost of staying with DreamHost and worth revisiting if latency becomes a complaint.
- **Where the simulation runs.** Nothing runs the tick loop today — `createTickLoop` and
  the event queue are built, tested, and called by no process. Where the engine lives is
  [OPS-08](https://github.com/simmeh024/tailfinsim/issues/187), and it should be a worker
  rather than the web process.
- **Where Postgres lives after the split.** The four-node topology in OPS-08 – OPS-16 has
  no home for the database, which today is local to the box and reached over a loopback
  socket — including by `backup.sh`, which uses peer authentication.
  [OPS-11](https://github.com/simmeh024/tailfinsim/issues/190) forces that decision.
- **Real-money payments.** Settled in principle by [ADR-0006](adr/0006-stripe-for-real-money.md)
  — Stripe, hosted checkout, no card data on Tailfin's servers. Nothing is integrated: the
  first product that needs it is the poster shop
  ([POD milestone](https://github.com/simmeh024/tailfinsim/milestone/21)), which is
  post-launch. No Stripe environment variables exist yet, and none should until then.
