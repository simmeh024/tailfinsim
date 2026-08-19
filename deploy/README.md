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

## 10. Populating a new box

A deploy migrates the schema and starts the service. It does **not** load any data — a
freshly deployed box has an empty database and a running server that can serve a holding
page and nothing else.

Each job below is a bundled entry point under `packages/server/dist`, so the deploy above
has to have run first. **The order matters**: each reads what the previous one wrote.

```bash
cd /srv/tailfin/packages/server

sudo -u tailfin pnpm data:airports    # ~86,000 aerodromes from OurAirports (M1-01)
sudo -u tailfin pnpm data:classify    # tiers over the ~4,400 with scheduled service (M1-02)
sudo -u tailfin pnpm data:catchment   # population and the wealth/tourism/business indices (M1-03)
sudo -u tailfin pnpm data:distances   # the packed great-circle matrix (M1-04)
sudo -u tailfin pnpm world:seed       # the flagship world from config (M1-09)
sudo -u tailfin pnpm demand:generate <worldId>   # App. A.2's demand pools (M3-01)
```

The first four are global reference data and are shared by every world — geography does
not vary, and era worlds filter this set by opening and closing date rather than owning a
copy of it. Only `demand:generate` is per world, because the gravity coefficients are
economy config and a world pins its version.

`demand:generate` is also the only one worth re-running: retuning `k` or `α` means
regenerating, and it takes `--regenerate` to clear first. Without that flag a re-run is a
no-op, which is the safe default — changing a coefficient and re-running without clearing
would leave a world holding a mixture of two economies.

Grant yourself admin once there is a world and you have signed in at least once:

```bash
sudo -u tailfin pnpm admin list
sudo -u tailfin pnpm admin grant --email you@example.com
```

The grant needs a `player` row, which only exists after that account has signed in through
Google at least once — so sign in first, then grant.

---

## Operating notes

| Task                        | Command                                                |
| --------------------------- | ------------------------------------------------------ |
| **What is deployed where?** | `pnpm ops:status` — **from anywhere, no SSH**          |
| What is running here?       | `sudo -u tailfin git -C /srv/tailfin log -1 --oneline` |
| Deploy latest               | `./deploy/deploy.sh`                                   |
| Roll back                   | `./deploy/deploy.sh <older-sha>`                       |
| Rebuild in place            | `./deploy/deploy.sh --force`                           |
| App logs                    | `journalctl -u tailfin -f`                             |
| Proxy logs                  | `journalctl -u caddy -f`                               |
| Restart                     | `sudo systemctl restart tailfin`                       |

Run the git command **as `tailfin`**. The checkout is owned by `tailfin`, so git's
dubious-ownership guard rejects it from any other account.

`pnpm ops:status` (OPS-02) is the one to reach for first, because it needs none of this
— no SSH, no credentials, no VPN. It reads both boxes' public `/api/version` and asks
GitHub where `main` is, and prints the three together:

```
main   abeee40

environment build   commit    behind  ref             deployed
production  101     ecf90e7   28      origin/main     16h ago
dev         129     abeee40   0       origin/main     4m ago

!  production is 28 commits behind main
```

`behind` is commits `main` has that the box does not. A `*` beside it means the box is
running something **not on `main`** — normal for dev, which exists to preview branches,
and a klaxon for production, which OPS-01 refuses. An unreachable box says so on its own
row rather than vanishing from the table.

It always exits zero, including when it reports problems: drift is what it exists to
show, not a failure of the tool. It needs the server package built (`pnpm build:apps`),
like every other CLI here.

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

A nightly `pg_dump` of every Tailfin database at 03:15 UTC, verified, kept locally for 14
days, and **copied to DreamObjects** so a lost volume does not take the backups with it.

### Install

The script is installed by hand, like the Caddyfile and the unit files — `deploy.sh` does
not sync anything outside the checkout, and backups must not stop improving because a
deploy has not happened.

```bash
install -o root -g root -m 0755 /srv/tailfin/deploy/backup.sh /usr/local/sbin/tailfin-backup
cp /srv/tailfin/deploy/tailfin-backup.{service,timer} /etc/systemd/system/
install -d -o postgres -g postgres -m 700 /var/backups/tailfin
install -d -o root -g postgres -m 0750 /etc/tailfin
apt install -y s3cmd
systemctl daemon-reload
systemctl enable --now tailfin-backup.timer
```

### Credentials

The DreamObjects access key and secret live in `/etc/tailfin/dreamobjects.s3cfg`, owned
`root:postgres` and mode `0640`. **That file is not in this repository and must never be.**

Create it with the helper, which reads the secret without echoing it — it never reaches
the terminal, the shell history, or any log:

```bash
sudo /usr/local/sbin/tailfin-s3-setup
```

It prompts for the two values from **Panel → Cloud Services → DreamObjects**, writes the
config, and verifies it by listing the buckets. To rotate a key, run it again.

If the file is missing the script still takes local dumps and then **fails the run**.
Degrading silently to local-only backups would rebuild exactly the false confidence this
setup exists to remove.

### What ends up where

| Where                               | What                         | Kept          |
| ----------------------------------- | ---------------------------- | ------------- |
| `/var/backups/tailfin/`             | every dump, for fast restore | 14 days       |
| `s3://backupstailfin/nightly/<db>/` | one per night                | **7 runs**    |
| `s3://backupstailfin/monthly/<db>/` | the 1st of each month        | **12 months** |

The monthly copy is a **second upload of the same dump**, not a server-side copy.
`s3cmd cp` against DreamObjects creates the object and _then_ fails: it signs a follow-up
request with a V2 signature, the endpoint rejects it with `400 InvalidRequest`, and the
command exits 1 having actually succeeded. An operation that reports failure while working
is worse than one that plainly does not work, so the copy is paid for in bytes instead. It
still cannot happen unless the nightly upload succeeded — the control flow guarantees that,
not the copy source.

Retention is enforced by the script, not by bucket lifecycle rules — a rule that silently
stops applying looks exactly like one that is working, whereas an explicit delete says in
the log what went.

Tunable through the environment: `KEEP_NIGHTLY`, `KEEP_MONTHLY`, `MONTHLY_ON_DAY`,
`RETAIN_DAYS`, `S3_BUCKET`.

| Task          | Command                                                                                      |
| ------------- | -------------------------------------------------------------------------------------------- |
| Run one now   | `sudo systemctl start tailfin-backup.service`                                                |
| See the log   | `journalctl -u tailfin-backup -n 40`                                                         |
| Next run      | `systemctl list-timers tailfin-backup.timer`                                                 |
| Local dumps   | `sudo ls -lh /var/backups/tailfin`                                                           |
| Remote copies | `sudo -u postgres s3cmd --config=/etc/tailfin/dreamobjects.s3cfg ls -r s3://backupstailfin/` |
| Last result   | `sudo cat /var/backups/tailfin/last-run.json`                                                |

Dumps are custom-format (compressed, selectively restorable) with a `.sha256` sidecar each.
Every dump's table of contents is read back immediately after writing — a dump that cannot
be listed is renamed `.corrupt` and the run fails, because an unreadable archive is worse
than no archive: you will believe you are covered.

**An upload failure is a backup failure.** A dump that did not leave the box is not a
backup, and the run exits non-zero to say so.

`Persistent=true` on the timer means a run missed while the box was off happens on next
boot rather than being skipped.

### Restoring

Practise into a scratch database — never straight over a live one. The `_test` suffix is
not decoration: `packages/server/src/test-setup.ts` refuses to let the test suite near a
database without one.

From the local copy:

```bash
sudo -u postgres createdb tailfin_restore_test --locale=C --template=template0
sudo -u postgres pg_restore --dbname=tailfin_restore_test --no-owner --no-privileges \
  /var/backups/tailfin/tailfin-<stamp>.dump
sudo -u postgres psql -d tailfin_restore_test -c '\dt'
sudo -u postgres dropdb tailfin_restore_test
```

From the off-box copy — which is the one that will exist on the bad day, and therefore the
one worth practising:

```bash
sudo -u postgres s3cmd --config=/etc/tailfin/dreamobjects.s3cfg \
  ls s3://backupstailfin/nightly/tailfin/
sudo -u postgres s3cmd --config=/etc/tailfin/dreamobjects.s3cfg \
  get s3://backupstailfin/nightly/tailfin/<object>.dump /tmp/restore.dump
sudo -u postgres pg_restore --dbname=tailfin_restore_test --no-owner --no-privileges /tmp/restore.dump
```

The dumps use `--no-owner --no-privileges` precisely so they restore into a
differently-named role without editing.

### Rehearsed, 2026-08-18

Restoring from the **off-box copy** into a disposable database, with the app booted against
the result. Measured on the box, not estimated:

| Step                                   | `tailfin_dev` (9.3 MB) |
| -------------------------------------- | ---------------------- |
| Download from DreamObjects             | 0.1 s                  |
| `pg_restore` into a fresh database     | 4 s                    |
| Server healthy against it (`/healthz`) | 2 s                    |
| **Total**                              | **~6 s**               |

Verified rather than assumed: the downloaded dump's SHA-256 matched the sidecar written at
backup time; the restored database held **85,915 airports and 47,926 runways** with all
4,359 scheduled-service airports still tiered; and the `admin_audit` append-only triggers
came back with the schema and still refused a `DELETE`.

**Worst-case data loss is up to 24 hours**, because backups are nightly. Reducing it means
either a second daily run or WAL archiving — a decision, not an oversight.

Two things the rehearsal caught, both now fixed above: `find` fails the whole run if it
cannot return to its starting directory (hence `cd /`), and `s3cmd cp` creates the object
and _then_ reports failure.

A caution learned the same day: `/healthz` reports `db: up` against a database with **no
tables at all** — it proves the connection, not the schema. Do not read a green health check
as "the restore worked"; assert the row counts, as the procedure below does.

### Still outstanding

- **The rehearsal is not yet repeatable on its own** — [OPS-04] asks for a documented,
  re-runnable procedure rather than a one-off. The commands are below; automating them is
  the remaining half.
- **A failed backup is only visible in the journal.** `last-run.json` gives something
  machine-readable to build on, but nothing yet reads it. [OPS-03] carries the alerting
  decision; with no mail infrastructure until M14, a dead-man's-switch that expects a daily
  ping is the likely answer.

## The dev environment

`dev.tailfinsim.com` is where work in progress gets looked at on a real server before it
reaches the front door. It shares the box with production and nothing else:

|              | Production                          | Dev                              |
| ------------ | ----------------------------------- | -------------------------------- |
| Host         | `tailfinsim.com`                    | `dev.tailfinsim.com`             |
| Checkout     | `/srv/tailfin`                      | `/srv/tailfin-dev`               |
| Service      | `tailfin`                           | `tailfin-dev`                    |
| Port         | 3000                                | 3001                             |
| Database     | `tailfin`                           | `tailfin_dev`                    |
| Deploy       | `./deploy/deploy.sh`                | `./deploy/deploy-dev.sh`         |
| Access       | public                              | Google sign-in, `noindex`        |
| Registration | `ALLOW_REGISTRATION` unset → closed | `ALLOW_REGISTRATION=true` → open |

Dev takes any ref, which is the point of it:

```bash
./deploy/deploy-dev.sh my-branch
./deploy/deploy-dev.sh origin/main
```

Production takes `origin/main` by default, and **refuses any commit that is not on main** —
`deploy.sh` checks `git merge-base --is-ancestor` before it touches the checkout (OPS-01).
Rolling back to an older commit still works, because an older commit on main is still on
main. Dev is exempt: `deploy-dev.sh` sets `ALLOW_UNMERGED_REF=1`, which is the whole point
of dev.

### What guards dev

**The application, not the proxy.** `RequireSession` in the client and `requireAuth` /
`requireAdmin` on the server. There is no password prompt in front of dev.

Dev sat behind HTTP basic auth until August 2026, imported from a literal path in the
Caddyfile so that a missing credentials file stopped Caddy rather than serving dev open.
That gate came out once Google sign-in (M0-11) reached dev: two prompts to look at one
page, the first of which the browser re-asked on every refresh. `/etc/caddy/dev-auth.caddyfile`
no longer exists and the import is gone.

Two consequences worth being deliberate about:

- **`X-Robots-Tag: noindex, nofollow, noarchive` is now the only thing keeping dev out of
  search results.** It was belt-and-braces when a 401 sat in front of it. Do not remove it.
- **`ALLOW_REGISTRATION=true` on dev is a deliberate choice**, confirmed 2026-08-18: it is
  how people are invited to look at work in progress, and the only way to exercise the
  sign-up path at all. So dev is knowingly an open Google sign-up on a public hostname —
  and the subdomain is discoverable through certificate transparency whatever the robots
  header says.

That is the right trade for a pre-launch preview environment holding disposable data. It
stops being the right trade the moment dev holds anything that matters. Production is a
different question: it defaults to `ALLOW_REGISTRATION=false` and stays that way until
launch.

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

**Back up before you need it.** Nightly dumps go to DreamObjects as well as to local disk
(see [Backups](#backups)). M13-11 covers the wider data-protection story. The half that is
still outstanding is the important half: **a backup that has never been restored is not a
backup** — [OPS-04] is that rehearsal.
