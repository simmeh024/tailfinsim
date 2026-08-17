# Deployment & connections

Status: **planned, not yet provisioned.** This document is the target topology and the
exact records to create. Nothing here is live until the DreamCompute instance exists.

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
     static build     Fastify          WebSocket
                          │
                          ▼
                    Postgres 16
```

**One origin, deliberately.** The client and API share `tailfinsim.com` rather than
splitting into `app.` and `api.` subdomains. This is not laziness — M0-11 specifies
session auth with httpOnly secure cookies, and same-origin means `SameSite=Lax` works
with no CORS configuration, no cookie-domain juggling and no preflight on every call.
Split them only when there is a reason, and take the cookie complexity on knowingly.

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

**Status (2026-08-17):** DreamCompute is **activated** — region `US-East 2` (`iad2`), tenant
`7407e2e12e9241fb81e6e083d00eab79`, project `dhc2993840`, user `passle`. **No instance
exists yet**; a launch is configured but not submitted. Creating it and generating the SSH
keypair are account actions.

Note for the launch wizard: attaching the instance to the **`public`** network gives it a
routable IPv4 directly, so **no floating IP is involved**. And if booting from a new volume,
the wizard's default volume size of 4 GB is smaller than the Ubuntu 24.04 image — see
[`deploy/README.md`](../deploy/README.md) for the full wizard settings and why.

## 3. DNS records to create

In the DreamHost panel: **Domains → Manage Domains → DNS** for `tailfinsim.com`.

Current state (verified 2026-08-17): the domain resolves to DreamHost nameservers
(`ns1/ns2/ns3.dreamhost.com`) with **no A, MX or TXT records at all**. Clean slate.

Once the instance exists, take its public IPv4 from the Instances list and add:

| Type | Host          | Value                   | Purpose                      |
| ---- | ------------- | ----------------------- | ---------------------------- |
| `A`  | _(blank / @)_ | `<instance IP>`         | Apex → the app               |
| `A`  | `www`         | `<instance IP>`         | Caddy redirects `www` → apex |
| `A`  | `staging`     | `<staging instance IP>` | Only if a staging box exists |

Leave everything else empty for now. In particular:

- **No MX record yet.** Only needed if M0-11 chooses email magic-link auth over GitHub
  OAuth, and even then the sending provider (Resend/Postmark/SES) supplies its own
  SPF/DKIM/DMARC records. Adding mail DNS before choosing the provider means redoing it.
- **No CAA record yet**, but consider adding one once TLS is live to restrict which CAs
  may issue for the domain.

### TLS

Caddy obtains and renews Let's Encrypt certificates automatically. DreamHost's own free
certificate offer applies to DreamHost-_hosted_ sites and does **not** cover DreamCompute
instances — do not wait for it.

DNS must resolve to the instance **before** Caddy starts, or the ACME HTTP-01 challenge
fails. Propagation on a fresh domain with no prior records is usually minutes.

## 4. Environment variables

Required by the server. Nothing here has a default that is safe in production; the
process should refuse to boot on a missing value rather than guess (M0-08).

| Variable                      | Example                                       | Required | Notes                                                  |
| ----------------------------- | --------------------------------------------- | -------- | ------------------------------------------------------ |
| `NODE_ENV`                    | `production`                                  | yes      | `development` \| `test` \| `production`                |
| `PORT`                        | `3000`                                        | yes      | Caddy proxies to this                                  |
| `DATABASE_URL`                | `postgres://tailfin:…@localhost:5432/tailfin` | yes      | M0-05. Never hardcoded, never committed                |
| `DATABASE_POOL_MAX`           | `10`                                          | no       | Defaults to 10                                         |
| `DATABASE_CONNECT_TIMEOUT_MS` | `5000`                                        | no       | Defaults to 5000. `pg`'s own default waits forever     |
| `LOG_LEVEL`                   | `info`                                        | no       | Pino level; defaults to `info` in prod, `debug` in dev |
| `WEB_SURFACE`                 | `app`                                         | no       | `holding` (default) or `app`. What `/` serves          |
| `PUBLIC_ORIGIN`               | `https://tailfinsim.com`                      | yes      | OAuth redirect base; also decides `Secure` on cookies  |
| `GOOGLE_CLIENT_ID`            | `….apps.googleusercontent.com`                | no       | M0-11. All three auth vars together, or none           |
| `GOOGLE_CLIENT_SECRET`        | `GOCSPX-…`                                    | no       | Never logged, never echoed                             |
| `SESSION_SECRET`              | _(32+ random bytes, base64)_                  | no       | Rotating it invalidates every session                  |
| `SESSION_TTL_HOURS`           | `720`                                         | no       | Defaults to 30 days                                    |
| `ALLOW_REGISTRATION`          | `false`                                       | no       | **Defaults to false.** Closed unless explicitly opened |
| `WORLD_TICK_MS`               | `1000`                                        | no       | Coarse tick for position interpolation (§21)           |

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

```
ssh tailfin@<ip> → cd /srv/tailfin → ./deploy/deploy.sh
                          │
                          ├─ fetch · checkout the target commit (detached)
                          ├─ pnpm install --frozen-lockfile
                          ├─ build      ── fails here? nothing was touched
                          ├─ migrate    ── fails here? old service still serving
                          ├─ systemctl restart tailfin
                          └─ poll /healthz, print the rollback command on failure
```

**Running the command is the approval step.** Nothing automated can push to production,
and no credential exists that lets GitHub reach the instance.

Rollback is the same command with an older commit: `./deploy/deploy.sh <sha>`. That rolls
back _code_, not _schema_ — a migration that dropped a column is not undone by checking out
the old commit.

Postgres and Caddy are installed from `apt`. Docker is used **only** for local development
Postgres (root `docker-compose.yml`), which is a developer-machine convenience and has
nothing to do with how production runs.

Full step-by-step server setup: [`deploy/README.md`](../deploy/README.md).

### The trade-off, stated plainly

Builds run on the production box. A deploy needs dev dependencies and a few hundred MB of
`node_modules`, and a broken build is found on the server rather than in CI. `deploy.sh`
orders itself to limit the damage — build, then migrate, then restart, so a failure at any
step leaves the running service alone — but rollback means rebuilding, which takes minutes
and can itself fail.

## 6. What is still open

- **Static web assets.** The server currently serves the API only. M0-09 decides whether
  the built client is served from the server's static route or from a CDN; the Caddyfile
  routes everything to the server today, which works either way.
- **Staging.** There is one environment. A second box is worth it once there is a reason.
- **Backups.** M13-11. A nightly `pg_dump` off-instance is cheap to add now, and a backup
  that has never been restored is not a backup.
- **Auth provider** (M0-11) — GitHub OAuth is far simpler to stand up but restricts
  players to people with GitHub accounts, which is wrong for a public game. Email
  magic-link needs a sending provider and DNS records. Decide before M0-11, not during.
- **Region.** DreamCompute is US-only and the instance is in US-East 2 — roughly 90–110 ms
  from European players. Acceptable for a sim where a flight takes hours, but it is a real
  cost of staying with DreamHost and worth revisiting if latency becomes a complaint.
