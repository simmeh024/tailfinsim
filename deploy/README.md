# Production server bootstrap

One-time setup for the DreamCompute instance. Every step here needs the DreamHost
account or root on the box, so it is yours to run — nothing in CI can do it, by design.

Read [`docs/deploy.md`](../docs/deploy.md) first for the topology and the reasoning.

---

## How a deploy works

```
merge to main
      │
      ▼
 Release workflow ── builds image ──► ghcr.io/…/server:sha-<commit>
      │
      ▼
 ┌─────────────────────────┐
 │  waits for YOUR approval│   GitHub environment `production`
 └───────────┬─────────────┘   required reviewer: @simmeh024
             │
             ▼
   retags that digest as :production
             │
             ▼
 systemd timer on the box (every 60s) notices the digest moved
             │
             ├─ starts Postgres if needed
             ├─ runs migrations from the NEW image as a one-off
             │    └─ on failure: stops here, old version keeps serving
             └─ restarts the server
```

**Why pull-based.** GitHub's only capability is moving a tag in a registry. There is no
SSH key in repository secrets, and no inbound path from CI to the server. The trade-off
is that a deploy lands within the poll interval rather than instantly, and the deploy log
lives in the server's journal rather than in the Actions run.

**Migrations run before the new server starts, never on app boot.** A process that
migrates on startup races itself the moment there is a second replica, and turns a bad
migration into a crash loop instead of a failed deploy step that leaves the old version
serving.

---

## 1. Provision

DreamHost panel → **Cloud → DreamCompute**. Activate it (choose a DreamCompute password),
then create an instance:

|        | Recommended                                                                  |
| ------ | ---------------------------------------------------------------------------- |
| Flavor | `warpspeed` — 4 vCPU / 8 GB, $48/mo max                                      |
| Image  | Ubuntu LTS                                                                   |
| Key    | Add your SSH public key at creation — password login should never be enabled |

`supersonic` (2 GB, $12/mo) is fine for a staging box but too tight for Postgres plus the
sim in production. Billing caps at 600 hours/month, so the monthly figure is a ceiling.

Attach a **floating IP** and note it — DNS needs it.

## 2. DNS

DreamHost panel → **Domains → Manage Domains → DNS** for `tailfinsim.com`:

| Type | Host          | Value           |
| ---- | ------------- | --------------- |
| `A`  | _(blank / @)_ | `<floating IP>` |
| `A`  | `www`         | `<floating IP>` |

Do this **before** starting Caddy, or the ACME challenge fails and Let's Encrypt
rate-limits you for repeated failures.

## 3. Harden

```bash
adduser --disabled-password --gecos "" tailfin
usermod -aG docker tailfin
# SSH: PasswordAuthentication no, PermitRootLogin no
systemctl reload ssh
ufw default deny incoming && ufw allow 22,80,443/tcp && ufw --force enable
apt install -y unattended-upgrades
```

## 4. Install Docker Engine

Docker _Engine_ (Apache-2.0), not Docker Desktop:

```bash
curl -fsSL https://get.docker.com | sh
```

## 5. Lay out the stack

```bash
install -d -o tailfin -g docker /opt/tailfin
```

Copy from this directory into `/opt/tailfin/`:

| From                      | To                                            |
| ------------------------- | --------------------------------------------- |
| `docker-compose.prod.yml` | `/opt/tailfin/docker-compose.yml`             |
| `Caddyfile`               | `/opt/tailfin/Caddyfile`                      |
| `tailfin-deploy.sh`       | `/opt/tailfin/tailfin-deploy.sh` (`chmod +x`) |
| `tailfin-deploy.service`  | `/etc/systemd/system/`                        |
| `tailfin-deploy.timer`    | `/etc/systemd/system/`                        |

## 6. Secrets

Create `/opt/tailfin/.env`, owned by `tailfin`, mode `600`. **Never commit this.**

```bash
POSTGRES_USER=tailfin
POSTGRES_PASSWORD=<long random string>
POSTGRES_DB=tailfin
PUBLIC_ORIGIN=https://tailfinsim.com
ACME_EMAIL=<your email>
LOG_LEVEL=info
```

Generate the password on the box so it never travels: `openssl rand -base64 36`

## 7. Make the image pullable

The `server` package under the repo's **Packages** settings must be **public**, so the box
can pull anonymously and needs no registry credentials at all.

If you would rather keep it private, create a token with `read:packages` only and
`docker login ghcr.io` once as the `tailfin` user. Never reuse the token you push with.

## 8. Start the timer

```bash
systemctl daemon-reload
systemctl enable --now tailfin-deploy.timer
```

Verify:

```bash
systemctl list-timers tailfin-deploy.timer
journalctl -u tailfin-deploy -f
```

## 9. First deploy

Merge to `main`, then approve the **Promote to production** job in the Actions tab. Within
about a minute:

```bash
curl -si https://tailfinsim.com/healthz
```

---

## Operating notes

**Deploy a specific version / roll back.** The timer follows the `:production` tag, so
rolling back means moving that tag, not editing the server. Re-run the Release workflow
against the older commit and approve it, or move the tag directly:

```bash
docker buildx imagetools create \
  --tag ghcr.io/simmeh024/tailfinsim/server:production \
  ghcr.io/simmeh024/tailfinsim/server:sha-<older-commit>
```

The box picks it up on the next tick. Note this rolls back _code_, not _schema_ — a
migration that dropped a column is not undone by shipping the old image.

**Force a check now:** `systemctl start tailfin-deploy.service`

**Pause deploys** (during an incident): `systemctl stop tailfin-deploy.timer`

**Back up before you need it.** M13-11 covers this properly, but a nightly `pg_dump` to
off-instance storage costs nothing to set up now, and a backup that has never been
restored is not a backup.
