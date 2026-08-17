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

| Wizard step     | Set to                                                                                                            | Why                                                                  |
| --------------- | ----------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Details         | name `Tailfin`, count 1                                                                                           |                                                                      |
| Source          | Image **Ubuntu-24.04**, Create New Volume **Yes**, Volume Size **50 GB**, Delete Volume on Instance Delete **No** | see the disk trap below                                              |
| Flavor          | **`gp1.lightspeed`** (2 vCPU / 4 GB, $24/mo)                                                                      | no Docker on the box, so 4 GB is enough to start                     |
| Networks        | **`public`**                                                                                                      | gives a routable IP directly — no floating IP needed on DreamCompute |
| Security Groups | `default`, then add inbound **22, 80, 443**                                                                       | see below                                                            |
| Key pair        | generate on **your** machine (`ssh-keygen -t ed25519`) and **Import** the public key                              |                                                                      |

Monthly prices are ceilings; billing caps at 600 hours.

### The disk trap

The Flavor step advertises "Total Disk 80 GB", but if you boot from a new volume then the
**volume** is your root disk and the flavor's disk is not used. The wizard defaults the
volume to **4 GB**, and the Ubuntu 24.04 image alone is 3.5 GB — so the default leaves
roughly half a gigabyte for Postgres, `node_modules` and logs. Since deploys build on this
box, that is nowhere near enough.

**50 GB.** Block storage includes 100 GB, so it costs nothing and leaves room for a
snapshot.

`Delete Volume on Instance Delete = No` is what lets you destroy and rebuild the instance
without losing the database. Keep it off.

### Key pair

Prefer **Import Key Pair** with a key you generated locally. If you use _Create Key Pair_,
the dashboard offers the private key as a one-time download — miss it and you cannot log
in, and the only fix is deleting the key and starting again.

### Security group rules

The `default` group does not necessarily permit inbound HTTP. After launch:
**Network → Security Groups → `default` → Manage Rules**, and ensure ingress on **22**
(SSH), **80** (ACME challenge) and **443**. Without 80, Caddy cannot obtain a certificate.

Rules take effect immediately, so this can be fixed after the instance is running.

## 2. DNS

Panel → **Domains → Manage Domains → DNS** for `tailfinsim.com`.

Use the instance's public IPv4 from the Instances list. Because it is attached to the
`public` network it has a routable address from creation — there is no floating IP to
allocate or attach.

| Type | Host          | Value           |
| ---- | ------------- | --------------- |
| `A`  | _(blank / @)_ | `<instance IP>` |
| `A`  | `www`         | `<instance IP>` |

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
apt update
apt install -y ca-certificates curl gnupg git postgresql unattended-upgrades \
               debian-keyring debian-archive-keyring apt-transport-https

# Node — match .nvmrc (24.x)
curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
apt install -y nodejs
corepack enable pnpm

# Caddy is NOT in Ubuntu's repositories; it needs its own.
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
  | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
  > /etc/apt/sources.list.d/caddy-stable.list
apt update && apt install -y caddy
```

Verified on Ubuntu 24.04.1: Node 24.19.0, pnpm 11.22.0, Postgres 16.14, Caddy 2.11.4.

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
install -d -o caddy -g caddy /var/log/caddy
systemctl daemon-reload
systemctl enable tailfin
caddy validate --config /etc/caddy/Caddyfile   # check before restarting
```

**Do not start Caddy until DNS resolves to this host.** Let's Encrypt rate-limits
repeated failed challenges. Once `dig +short tailfinsim.com` returns the instance IP:

```bash
systemctl restart caddy
```

Optional — for certificate expiry emails:

```bash
install -d -o root -g caddy -m 750 /etc/caddy/conf.d
printf '{\n\temail you@example.com\n}\n' > /etc/caddy/conf.d/acme.caddyfile
```

The committed Caddyfile globs `/etc/caddy/conf.d/*.caddyfile`, which tolerates matching
nothing. It is kept off-repo so a personal address is not committed to a public repository.

> A **glob** matters here: an `import` of a single literal path fails outright when the
> file is absent (`File to import not found`).

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

| Task             | Command                                                |
| ---------------- | ------------------------------------------------------ |
| What is running? | `sudo -u tailfin git -C /srv/tailfin log -1 --oneline` |
| Deploy latest    | `./deploy/deploy.sh`                                   |
| Roll back        | `./deploy/deploy.sh <older-sha>`                       |
| Rebuild in place | `./deploy/deploy.sh --force`                           |
| App logs         | `journalctl -u tailfin -f`                             |
| Proxy logs       | `journalctl -u caddy -f`                               |
| Restart          | `sudo systemctl restart tailfin`                       |

Run the git command **as `tailfin`**. The checkout is owned by `tailfin`, so git's
dubious-ownership guard rejects it from any other account.

## Swap

`lightspeed` has 4 GB of RAM, which is enough to _run_ Tailfin but tight while building it:
deploys install dev dependencies and bundle on the box (ADR-0003), and two environments now
share the machine. Without swap, a build that peaks over the limit is killed by the OOM
reaper rather than merely being slow — and it takes whatever else the kernel picks with it.

2 GB of swap on the root volume, which has ~45 GB free, so it costs nothing:

```bash
fallocate -l 2G /swapfile
chmod 600 /swapfile
mkswap /swapfile
swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab

# Use it as a safety net, not as routine memory. Postgres in particular gets
# slow and hard to diagnose if the kernel starts paging it out eagerly.
sysctl -w vm.swappiness=10
echo 'vm.swappiness=10' > /etc/sysctl.d/99-swappiness.conf
```

Check with `free -h` and `swapon --show`. Sustained swap **use** — as opposed to swap being
available — is the signal to move up a flavor, not to add more swap.

## Backups

A nightly `pg_dump` of every Tailfin database, at 03:15 UTC.

```bash
cp /srv/tailfin/deploy/tailfin-backup.{service,timer} /etc/systemd/system/
install -d -o postgres -g postgres -m 700 /var/backups/tailfin
systemctl daemon-reload
systemctl enable --now tailfin-backup.timer
```

| Task        | Command                                       |
| ----------- | --------------------------------------------- |
| Run one now | `sudo systemctl start tailfin-backup.service` |
| See the log | `journalctl -u tailfin-backup -n 40`          |
| Next run    | `systemctl list-timers tailfin-backup.timer`  |
| List dumps  | `sudo ls -lh /var/backups/tailfin`            |

Dumps are custom-format (compressed, selectively restorable), retained **14 days**, with a
`.sha256` sidecar each. Every dump's table of contents is read back immediately after
writing — a dump that cannot be listed is renamed `.corrupt` and the run fails, because an
unreadable archive is worse than no archive: you will believe you are covered.

`Persistent=true` on the timer means a run missed while the box was off happens on next
boot rather than being skipped.

### Restoring

Practise into a scratch database first — never straight over a live one:

```bash
sudo -u postgres createdb tailfin_restore_test --locale=C --template=template0
sudo -u postgres pg_restore --dbname=tailfin_restore_test --no-owner --no-privileges \
  /var/backups/tailfin/tailfin-<stamp>.dump
sudo -u postgres psql -d tailfin_restore_test -c '\dt'
sudo -u postgres dropdb tailfin_restore_test
```

The dumps use `--no-owner --no-privileges` precisely so they restore into a
differently-named role without editing.

### This does not yet protect against losing the instance

The dumps sit on the same volume as the database. That covers the likely failures — a bad
migration, a wrong `DELETE`, a corrupted table — but **not** the loss of the instance or the
volume itself.

Closing that needs off-instance storage, which needs credentials and so is yours to set up.
DreamObjects is the natural fit since everything else is DreamHost:

```bash
# after configuring an S3-compatible client with DreamObjects credentials
aws --endpoint-url https://objects-us-east-1.dream.io \
    s3 sync /var/backups/tailfin s3://tailfin-backups/
```

Add that as a second `ExecStart=` line on `tailfin-backup.service` once it works by hand.
Until then, treat the current setup as protection against mistakes, not against disasters.

## The dev environment

`dev.tailfinsim.com` is where work in progress gets looked at on a real server before it
reaches the front door. It shares the box with production and nothing else:

|              | Production                          | Dev                      |
| ------------ | ----------------------------------- | ------------------------ |
| Host         | `tailfinsim.com`                    | `dev.tailfinsim.com`     |
| Checkout     | `/srv/tailfin`                      | `/srv/tailfin-dev`       |
| Service      | `tailfin`                           | `tailfin-dev`            |
| Port         | 3000                                | 3001                     |
| Database     | `tailfin`                           | `tailfin_dev`            |
| Deploy       | `./deploy/deploy.sh`                | `./deploy/deploy-dev.sh` |
| Access       | public                              | HTTP basic auth          |
| Registration | `ALLOW_REGISTRATION` unset → closed | closed                   |

Dev takes any ref, which is the point of it:

```bash
./deploy/deploy-dev.sh my-branch
./deploy/deploy-dev.sh origin/main
```

Production only ever gets `origin/main` or an explicit older SHA for rollback.

### Dev credentials

Basic auth credentials live off-repo in `/etc/caddy/dev-auth.caddyfile`:

```
basic_auth {
	someuser $2a$14$…bcrypt hash…
}
```

Generate a hash with `caddy hash-password`, then reload Caddy. To change the password:

```bash
caddy hash-password            # prompts, prints a hash
sudo nano /etc/caddy/dev-auth.caddyfile
sudo caddy validate --config /etc/caddy/Caddyfile && sudo systemctl reload caddy
```

**That import is deliberately a literal path, not a glob.** If the file goes missing,
Caddy refuses to start rather than serving dev unauthenticated — an auth gate should fail
closed. The optional ACME contact snippet uses a glob precisely because it is safe for it
to be absent.

### Promoting dev to the front door

When the app is ready to be public, the "copy to the front door" step is just pointing
production at the same commit:

```bash
./deploy/deploy.sh              # production takes origin/main
```

The holding page is replaced by whatever the client build serves at that point (M0-09).
Production and dev run the same code from the same repo — the only differences are the
database, the port and who is allowed in.

### `deploy.sh` does not sync anything under /etc

It updates the checkout, builds, migrates and restarts the app. It deliberately cannot
write to `/etc` — the sudoers grant is exactly one command, `systemctl restart tailfin`.
So editing `deploy/Caddyfile` or `deploy/tailfin.service` in the repo does **not** reach
the running system on deploy. Apply those by hand, as root:

```bash
cp /srv/tailfin/deploy/Caddyfile /etc/caddy/Caddyfile
caddy validate --config /etc/caddy/Caddyfile && systemctl reload caddy

cp /srv/tailfin/deploy/tailfin.service /etc/systemd/system/
systemctl daemon-reload && systemctl restart tailfin
```

Widening the grant so deploys could do this automatically would hand the deploy user most
of root, which is the opposite of the point.

`deploy.sh` exits early only when the checkout is already at the target **and** the
service is running. If the service is down it rebuilds regardless — that is what makes a
first-ever deploy and crash recovery work without a flag.

## Two gotchas worth knowing

**Deleting a keypair in OpenStack does not change a running instance.** cloud-init injects
the public key into `~/.ssh/authorized_keys` on _first boot only_. Replacing the keypair in
Horizon leaves the old key authorised and the new one unknown, and because the OS lives on
the boot volume, relaunching from that same volume carries the old key with it. To rotate
for real: log in with the existing key, replace `authorized_keys`, then confirm the old key
is refused.

**The `default` security group blocks all inbound traffic.** It permits egress anywhere but
ingress only from other instances in the same group, so SSH times out rather than refusing.
Rules must be added explicitly — see step 1.

**Builds happen on this box.** That is the main trade-off of this setup: a deploy needs dev
dependencies and a few hundred MB of `node_modules`, and a broken build is discovered here
rather than in CI. `deploy.sh` builds before migrating and before restarting, so a failure
leaves the running service alone — but the checkout will have moved, so `git log -1` can
disagree with what is actually serving until you deploy again.

**Back up before you need it.** M13-11 covers this properly. A nightly `pg_dump` to
off-instance storage costs nothing to set up now, and a backup that has never been
restored is not a backup.
