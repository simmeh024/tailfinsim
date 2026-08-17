# Production server setup

One-time setup for the DreamCompute instance, then one command per deploy.

Everything here needs the DreamHost account or root on the box, so it is yours to run.
Read [`docs/deploy.md`](../docs/deploy.md) for the topology and the reasoning, and
[ADR-0003](../docs/adr/0003-deployment-approach.md) for why it is this shape and not a
container pipeline.

---

## How a deploy works

```
you:  ssh tailfin@<ip>
      cd /srv/tailfin && ./deploy/deploy.sh
             │
             ├─ git fetch, checkout the target commit (detached)
             ├─ pnpm install --frozen-lockfile
             ├─ build            ── fails here? nothing was touched
             ├─ migrate          ── fails here? old service still serving
             ├─ systemctl restart tailfin
             └─ poll /healthz, print the rollback command if it never comes up
```

**Running the command is the approval step.** There is no CI involvement in deploys, no
registry, and no credential anywhere that lets GitHub reach this machine.

Rollback is the same command with a commit: `./deploy/deploy.sh <older-sha>`. That rolls
back _code_, not _schema_ — a migration that dropped a column is not undone by checking
out the old commit.

---

## 1. Create the instance

DreamCompute is already activated (region **US-East 2**). In the panel: **Cloud Services →
DreamCompute → View Dashboard** to reach OpenStack Horizon.

|          | Recommended                                                                          |
| -------- | ------------------------------------------------------------------------------------ |
| Flavor   | `lightspeed` (2 vCPU / 4 GB, $24/mo) or `warpspeed` (4 vCPU / 8 GB, $48/mo)          |
| Image    | Ubuntu LTS                                                                           |
| Key pair | Generate on **your** machine (`ssh-keygen -t ed25519`) and upload the **public** key |

Without Docker the box needs less headroom, so `lightspeed` is a reasonable start —
Postgres and one Node process fit in 4 GB. Monthly prices are ceilings; billing caps at
600 hours.

Then attach a **floating IP** and note it.

## 2. DNS

Panel → **Domains → Manage Domains → DNS** for `tailfinsim.com`:

| Type | Host          | Value           |
| ---- | ------------- | --------------- |
| `A`  | _(blank / @)_ | `<floating IP>` |
| `A`  | `www`         | `<floating IP>` |

Do this **before** installing Caddy. Let's Encrypt rate-limits repeated failed challenges,
so a premature start costs you an hour of waiting.

Confirm it resolves before continuing:

```bash
dig +short tailfinsim.com
```

## 3. Harden

```bash
adduser --disabled-password --gecos "" tailfin
# SSH: PasswordAuthentication no, PermitRootLogin no
systemctl reload ssh
ufw default deny incoming && ufw allow 22,80,443/tcp && ufw --force enable
apt update && apt install -y unattended-upgrades
```

Copy your public key to `/home/tailfin/.ssh/authorized_keys` (owned by `tailfin`, mode
`600`; the `.ssh` directory `700`).

## 4. Install the runtime

```bash
# Node — match .nvmrc (24.x)
curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
apt install -y nodejs git postgresql caddy
corepack enable pnpm
```

## 5. Database

```bash
sudo -u postgres createuser tailfin --pwprompt
sudo -u postgres createdb tailfin --owner=tailfin --locale=C --template=template0
```

`--locale=C` matters and is not cosmetic: Postgres sorts differently under different
locales, and ordering must not diverge between your machine and this one. `--template0`
is required for a locale that differs from the cluster default.

Postgres listens on localhost only by default. Leave it that way — nothing outside the box
should reach it.

## 6. Check out the repository

```bash
install -d -o tailfin -g tailfin /srv/tailfin
sudo -u tailfin git clone https://github.com/simmeh024/tailfinsim.git /srv/tailfin
```

## 7. Configuration

Create `/srv/tailfin/.env`, owned by `tailfin`, mode `600`. **Never commit this.**

```bash
NODE_ENV=production
PORT=3000
DATABASE_URL=postgres://tailfin:<password>@127.0.0.1:5432/tailfin
PUBLIC_ORIGIN=https://tailfinsim.com
LOG_LEVEL=info
```

Generate the password on the box so it never travels: `openssl rand -base64 36`

The app resolves this file relative to its own location, which is the same mechanism local
development uses — there is one way config loads, not two.

## 8. Service and proxy

```bash
cp /srv/tailfin/deploy/tailfin.service /etc/systemd/system/
cp /srv/tailfin/deploy/Caddyfile /etc/caddy/Caddyfile
echo 'ACME_EMAIL=<your email>' >> /etc/default/caddy
install -d -o caddy -g caddy /var/log/caddy
systemctl daemon-reload
systemctl enable tailfin
systemctl restart caddy
```

`deploy.sh` restarts the service via `sudo`, so allow just that one command:

```bash
echo 'tailfin ALL=(root) NOPASSWD: /usr/bin/systemctl restart tailfin' \
  > /etc/sudoers.d/tailfin-deploy
chmod 440 /etc/sudoers.d/tailfin-deploy
```

Narrow on purpose — the deploy user gets to restart one service, not become root.

## 9. First deploy

```bash
sudo -u tailfin bash -c 'cd /srv/tailfin && ./deploy/deploy.sh'
curl -si https://tailfinsim.com/healthz
```

---

## Operating notes

| Task             | Command                                 |
| ---------------- | --------------------------------------- |
| What is running? | `git -C /srv/tailfin log -1 --oneline`  |
| Deploy latest    | `./deploy/deploy.sh`                    |
| Roll back        | `./deploy/deploy.sh <older-sha>`        |
| Logs             | `journalctl -u tailfin -f`              |
| Proxy logs       | `tail -f /var/log/caddy/tailfinsim.log` |
| Restart          | `sudo systemctl restart tailfin`        |

**Builds happen on this box.** That is the main trade-off of this setup: a deploy needs dev
dependencies and a few hundred MB of `node_modules`, and a broken build is discovered here
rather than in CI. `deploy.sh` builds before migrating and before restarting, so a failure
leaves the running service alone — but the checkout will have moved, so `git log -1` can
disagree with what is actually serving until you deploy again.

**Back up before you need it.** M13-11 covers this properly. A nightly `pg_dump` to
off-instance storage costs nothing to set up now, and a backup that has never been
restored is not a backup.
