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
| `lightspeed` | 2    | 4 GB   | $0.04     | $24.00      | Workable production floor.                    |
| `warpspeed`  | 4    | 8 GB   | **$0.08** | **$48.00**  | **Recommended for production.**               |
| `hyperspeed` | 8    | 16 GB  | $0.16     | $96.00      | Only once load testing (M13-04) says so.      |

Postgres wants 2–4 GB before the sim gets any, which is what rules out the bottom two.

All accounts include 100 GB of block storage and free bandwidth.

Start with staging only. Production does not need to exist until there is something to
deploy.

**DreamCompute must be activated before any of this is available** — the Cloud panel asks
you to choose a DreamCompute password first. That, instance creation, and the floating IP
are all account actions.

## 3. DNS records to create

In the DreamHost panel: **Domains → Manage Domains → DNS** for `tailfinsim.com`.

Current state (verified 2026-08-17): the domain resolves to DreamHost nameservers
(`ns1/ns2/ns3.dreamhost.com`) with **no A, MX or TXT records at all**. Clean slate.

Once the DreamCompute instance has a floating IP, add:

| Type | Host          | Value                   | Purpose                      |
| ---- | ------------- | ----------------------- | ---------------------------- |
| `A`  | _(blank / @)_ | `<floating IP>`         | Apex → the app               |
| `A`  | `www`         | `<floating IP>`         | Caddy redirects `www` → apex |
| `A`  | `staging`     | `<staging floating IP>` | Staging environment          |

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

| Variable            | Example                                       | Required | Notes                                                  |
| ------------------- | --------------------------------------------- | -------- | ------------------------------------------------------ |
| `NODE_ENV`          | `production`                                  | yes      | `development` \| `test` \| `production`                |
| `PORT`              | `3000`                                        | yes      | Caddy proxies to this                                  |
| `DATABASE_URL`      | `postgres://tailfin:…@localhost:5432/tailfin` | yes      | M0-05. Never hardcoded, never committed                |
| `DATABASE_POOL_MAX` | `10`                                          | no       | Defaults to 10                                         |
| `LOG_LEVEL`         | `info`                                        | no       | Pino level; defaults to `info` in prod, `debug` in dev |
| `SESSION_SECRET`    | _(32+ random bytes, base64)_                  | yes      | M0-11. Rotating it invalidates all sessions            |
| `SESSION_TTL_HOURS` | `720`                                         | no       | Defaults to 30 days                                    |
| `PUBLIC_ORIGIN`     | `https://tailfinsim.com`                      | yes      | Cookie domain and OAuth callback base                  |
| `WORLD_TICK_MS`     | `1000`                                        | no       | Coarse tick for position interpolation (§21)           |

Auth-provider variables are added by M0-11 once GitHub OAuth vs. magic-link is decided.

Secrets live in the instance's environment or a `.env` file readable only by the service
user — **never in the repository**. `.env` is gitignored; commit `.env.example` instead.

## 5. Order of operations

Each step is blocked by the one above it.

1. **Provision** a DreamCompute instance (Ubuntu LTS), attach a floating IP. _Manual —
   requires the DreamHost account._
2. **Point DNS** at the floating IP per the table above. _Manual._
3. **Harden**: non-root deploy user, SSH keys only, password auth off, `ufw` allowing
   only 22/80/443, unattended-upgrades on.
4. **Install** Docker Engine and the Compose plugin.
5. **Postgres** via Compose, on a named volume, bound to `127.0.0.1` only — never exposed
   to the public interface.
6. **Deploy** the server image and the static web build (M0-10).
7. **Caddy** in front, with the routing above.
8. **Backups** — `pg_dump` to off-instance storage, with a _restore_ rehearsed before
   launch, not after. This is M13-11, but a backup that has never been restored is not a
   backup, and it costs almost nothing to set up on day one.

Steps 3–8 can be scripted and committed once the instance exists.

## 6. The release pipeline

**Decided and built.** Images go to GitHub Container Registry (free for public repos, no
extra account). Deployment is **pull-based**: CI can only move a registry tag, and the
server decides when to act on it. There is no SSH key in repository secrets and no inbound
path from GitHub to the instance.

```
merge to main → build image → [YOUR APPROVAL] → retag :production → box rolls forward
```

The approval step is a GitHub environment named `production` with `@simmeh024` as a
required reviewer and deployments restricted to `main`. The `promote` job in
`.github/workflows/release.yml` declares `environment: production`, so it will not start
until approved in the Actions tab.

Server-side setup — instance, DNS, hardening, systemd timer, secrets — is in
[`deploy/README.md`](../deploy/README.md).

### What is still open

- **Static web assets.** The image currently serves the API only. M0-09 decides whether
  the built client is served from the server's static route or from a CDN; the Caddyfile
  routes everything to the server today, which works either way.
- **Staging.** The pipeline has one environment. A second (`staging`, no approval
  required, auto-deploying every merge) is worth adding once there is a reason to.
- **Backups.** M13-11. A nightly `pg_dump` off-instance is cheap to add now and a backup
  that has never been restored is not a backup.
- **Auth provider** (M0-11) — GitHub OAuth is far simpler to stand up but restricts
  players to people with GitHub accounts, which is wrong for a public game. Email
  magic-link needs a sending provider and DNS records. Decide before M0-11, not during.
