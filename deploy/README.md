# Production server setup

One-time setup for the DreamCompute instance, then one command per deploy.

Everything here needs the DreamHost account or root on the box, so it is yours to run.
Read [`docs/deploy.md`](../docs/deploy.md) for the topology and the reasoning, and
[ADR-0003](../docs/adr/0003-deployment-approach.md) for why it is this shape and not a
container pipeline.

---

## Release flow

```
PR merged to main  →  CI green  →  dev tracks main automatically   (OPS-17)
                                           ↓ reviewed on dev
                              human promotes to production          (OPS-18)
```

OPS-06 makes the boundary explicit: **merge means staged, not released**. The normal
release-line invariant is **`dev ≥ prod`**. A positive `dev build − prod build` gap is work
tested on dev and awaiting promotion; zero means the environments are aligned; a negative
gap is an operational incident. A deliberate unmerged branch preview is the exception: its
build is not ordered against `main`, and `pnpm ops:status` marks it with `*`.

OPS-17 and OPS-18 are not built yet. Until they are, dev tracking and production promotion
are both commands run on the server; production still moves only when a human invokes
`./deploy/deploy.sh`. The decision and the dated GitHub credential audit are in
[ADR-0003](../docs/adr/0003-deployment-approach.md).

---

## How a deploy works

```
you:  ssh tailfin@<ip>
      cd /srv/tailfin && ./deploy/deploy.sh
             │
             ├─ git fetch, checkout the target commit (detached)
             ├─ pnpm install --frozen-lockfile
             ├─ build                 ── fails here? nothing was touched
             ├─ migration preflight  ── database name, policy, pending count
             ├─ verified local dump  ── only for a non-empty migration batch
             ├─ atomic migrate       ── reports rollback / commit / unknown
             ├─ systemctl restart tailfin
             └─ poll /healthz, print the rollback command if it never comes up
```

**Running the command is the approval step.** There is no CI involvement in deploys, no
registry, and no credential anywhere that lets GitHub reach this machine.

Rollback is the same command with a commit: `./deploy/deploy.sh <older-sha>`. That rolls
back _code_, not _schema_. Every new migration is therefore required to keep the previously
deployed release compatible rather than relying on checkout to reverse SQL. The complete
decision and measured lock cost are in
[ADR-0016](../docs/adr/0016-migration-failure-strategy.md).

## Migration safety and recovery (OPS-05)

Drizzle ORM 0.45.2's PostgreSQL migrator wraps the **complete pending sequence** in one
transaction. This was proved with two migration files over 100,000 rows, where the second
failed deliberately: both files rolled back and no migration journal row remained. The same
experiment observed the cost—an `AccessExclusiveLock` blocked a reader until the whole batch
failed 1,078 ms later. The database-backed regression repeats on every pull request.

Future SQL uses expand/contract and declares it at the top of the file:

```sql
-- tailfin:migration-strategy expand
-- tailfin:migration-strategy contract-safe-after #123
```

The previous release has to keep working against either the old or new schema because it is
the process left serving if migration fails. The migration command and CI reject a missing
marker, obvious destructive SQL labelled expand, required new columns without a default, and
operations such as `CREATE INDEX CONCURRENTLY` that cannot run in the transaction. A contract
marker means an earlier released version already stopped using the object; its issue is the
evidence. There are no down-migrations.

### What the failure message means

The migration command reads `drizzle.__drizzle_migrations` before and after an error. Trust
the printed database state, not the process exit alone:

| Message                   | Database state and next action                                                                                  |
| ------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `DATABASE ROLLED BACK`    | Pending batch is unapplied. Old service is on the matching schema. Fix forward and deploy again.                |
| `ALL PENDING ... APPLIED` | PostgreSQL committed before the client failed. Old service is compatible; inspect the cause, then retry deploy. |
| `UNKNOWN/PARTIAL`         | Journal is between states or unreadable. Do not retry migration or roll code back; use the procedure below.     |
| `DATABASE NOT TOUCHED`    | Preflight or policy failed before migration SQL. Fix that refusal; no schema recovery is needed.                |

When migrations are pending, deploy first starts
`tailfin-migration-backup@tailfin.service` (or `@tailfin_dev`). It runs as `postgres`, creates
a custom-format dump under `/var/backups/tailfin/pre-migration/`, proves the archive can be
listed, writes its SHA-256 sidecar and records the exact filename in
`/var/lib/tailfin/migration-backup-<database>.json`. Only the latest eight per database are
kept, so dev previews cannot evict production's recovery points. A backup failure stops the
deploy before migration.

This recovery point is local on purpose: it covers a schema failure while PostgreSQL and the
host still exist. Nightly DreamObjects backups cover volume/host loss. A restore from either
copy can discard good writes after its snapshot, so never automate it over the failed database.

### Install before the first protected migration

Application deploys cannot write `/usr/local/sbin` or `/etc`. Install the reviewed helper and
unit manually from a checkout containing OPS-05:

```bash
install -o root -g root -m 0755 /srv/tailfin/deploy/backup.sh \
  /usr/local/sbin/tailfin-backup
install -o root -g root -m 0755 /srv/tailfin/deploy/migration-backup.sh \
  /usr/local/sbin/tailfin-migration-backup
cp /srv/tailfin/deploy/tailfin-migration-backup@.service /etc/systemd/system/
install -d -o postgres -g postgres -m 0700 /var/backups/tailfin/pre-migration
systemctl daemon-reload
```

Then install the four exact sudo grants described under [Service and proxy](#8-service-and-proxy)
and prove both unit instances before allowing a later commit to carry migrations:

```bash
sudo -u tailfin sudo systemctl start tailfin-migration-backup@tailfin.service
sudo -u tailfin sudo systemctl start tailfin-migration-backup@tailfin_dev.service
cat /var/lib/tailfin/migration-backup-tailfin.json
cat /var/lib/tailfin/migration-backup-tailfin_dev.json
```

The OPS-05 commit itself has no migration, so deploy it after installing these files. Because
`deploy.sh` re-executes a copy before checkout, the version already on disk controls that one
run; the new protection controls the next run, which is why installation comes first.

### Recovery for `UNKNOWN/PARTIAL`

The ordinary rolled-back case does **not** need a restore. Use these commands only after the
failure explicitly reports unknown/partial state. Examples below show production; substitute
`tailfin_dev` consistently for dev.

1. Keep the old service running and record the two commits and backup artifact:

   ```bash
   cd /srv/tailfin
   git rev-parse HEAD
   curl -fsS http://127.0.0.1:3000/api/version
   cat /var/lib/tailfin/migration-backup-tailfin.json
   sudo -u postgres psql -XAtd tailfin -c \
     'select id, created_at from drizzle.__drizzle_migrations order by id'
   ```

2. Preserve the unexpected state before changing anything:

   ```bash
   stamp=$(date -u +%Y%m%dT%H%M%SZ)
   sudo -u postgres pg_dump --format=custom --compress=9 --no-owner --no-privileges \
     --dbname=tailfin --file="/var/backups/tailfin/pre-migration/tailfin-failed-${stamp}.dump"
   sudo -u postgres pg_restore --list \
     "/var/backups/tailfin/pre-migration/tailfin-failed-${stamp}.dump" >/dev/null
   ```

3. Resolve the pre-migration filename from the recorded JSON, then verify it. Do not choose a
   file by memory:

   ```bash
   status=/var/lib/tailfin/migration-backup-tailfin.json
   artifact=$(node -e \
     'const fs=require("node:fs"); const s=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); const m=s.databases.match(/local-only:([^ ]+\.dump)/); if(!m) process.exit(1); process.stdout.write(m[1]);' \
     "${status}")
   dump="/var/backups/tailfin/pre-migration/${artifact}"
   test "$(sudo -u postgres sha256sum "${dump}" | cut -c1-64)" = \
     "$(sudo -u postgres cat "${dump}.sha256")"
   sudo -u postgres pg_restore --list "${dump}" >/dev/null
   ```

4. Restore into a new scratch database. The `_test` suffix is the destructive safety boundary;
   refuse an existing target rather than deleting it:

   ```bash
   recovery_db=tailfin_migration_recovery_test
   if sudo -u postgres psql -XAtqc \
     "select 1 from pg_database where datname='${recovery_db}'" | grep -q 1; then
     echo 'REFUSED: recovery database already exists' >&2
     exit 1
   fi
   sudo -u postgres createdb --owner=tailfin --locale=C --template=template0 "${recovery_db}"
   sudo -u postgres pg_restore --exit-on-error --single-transaction --role=tailfin \
     --no-owner --no-privileges --dbname="${recovery_db}" "${dump}"
   sudo -u postgres psql -Xd "${recovery_db}" -c \
     'select id, created_at from drizzle.__drizzle_migrations order by id'
   ```

5. Inspect the failed SQL against this copy and choose explicitly:

   - prefer a reviewed forward repair in one transaction when it preserves writes made after
     the backup;
   - otherwise restore and verify a **new non-live database**, stop the service, change only
     its `DATABASE_URL`, then restart and poll health/domain checks. Never restore over
     `tailfin` in place, and never mix selected tables without proving their foreign-key
     closure and preserving a second backup first.

6. After the incident is resolved, stop every process connected to the scratch copy, recheck
   the suffix beside the destructive command, and remove only that database:

   ```bash
   [[ "${recovery_db}" =~ ^[A-Za-z0-9_]+_test$ ]] || false
   sudo -u postgres dropdb "${recovery_db}"
   ```

This path was rehearsed on 2026-08-20 against disposable PostgreSQL 16. A fake committed table
simulated the half-applied state; the verified pre-migration dump restored into a new `_test`
database with all 20 real migration records and `airline`, without the fake table. The scratch
database and probe table were removed. No dev or production database participated.

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
SESSION_TTL_HOURS=720
ADMIN_SESSION_TTL_HOURS=12
```

Generate the password on the box so it never travels: `openssl rand -base64 36`

The app resolves this file relative to its own location, which is the same mechanism local
development uses — there is one way config loads, not two.

`ENVIRONMENT_LABEL=production` refuses to boot unless `PUBLIC_ORIGIN` is HTTPS. Player
sessions default to 30 days because this is a persistent world; admin sessions expire after
12 hours. Granting or revoking admin deletes the target's existing sessions, so they must
sign in again under the new authority. Both lifetimes and the revocation controls are
documented in `docs/adr/0015-session-lifecycle.md`.

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

### First security-policy rollout (SEC-HARD-05)

The committed Caddyfile defaults to an **enforced** Content Security Policy. Do not copy it
over a running edge for the first time and skip straight to that default. Install it in
report-only mode first so the real Google redirect and Google-hosted avatar are exercised,
not merely inferred from the policy text.

The policy contains one SHA-256 style hash for the holding page's inline stylesheet. The
automated check recomputes it; if the holding page changes, update the hash named by the
failure instead of adding `unsafe-inline`.

Create one narrowly scoped systemd override before the first reload:

```bash
install -d -m 755 /etc/systemd/system/caddy.service.d
printf '%s\n' \
  '[Service]' \
  'Environment=TAILFIN_CSP_HEADER=Content-Security-Policy-Report-Only' \
  > /etc/systemd/system/caddy.service.d/tailfin-csp.conf
cp /srv/tailfin/deploy/Caddyfile /etc/caddy/Caddyfile
TAILFIN_CSP_HEADER=Content-Security-Policy-Report-Only \
  caddy validate --config /etc/caddy/Caddyfile
systemctl daemon-reload
systemctl reload caddy
```

From a checkout containing this change, prove what the running edge is returning:

```bash
pnpm security:headers --mode report-only \
  https://tailfinsim.com/ https://dev.tailfinsim.com/
```

Then use a real browser on dev and check all of these while its console is open:

1. sign out and complete Google sign-in from the login wall;
2. load the signed-in shell and confirm the Google avatar renders;
3. navigate between application routes and make a real same-origin API request;
4. confirm there are no legitimate CSP violations (the holding page must also stay clean).

The browser proof is mandatory even when the automated header check passes. The check proves
delivery and exact values; it cannot prove that a browser journey needs no additional source.
Record the observation with SEC-HARD-05, then remove only the temporary override and reload
the enforced default:

```bash
rm /etc/systemd/system/caddy.service.d/tailfin-csp.conf
systemctl daemon-reload
caddy validate --config /etc/caddy/Caddyfile
systemctl reload caddy
pnpm security:headers --mode enforced \
  https://tailfinsim.com/ https://dev.tailfinsim.com/
```

Repeat the browser sign-in/avatar journey after enforcement. `deploy.sh` and `deploy-dev.sh`
do **not** install or reload Caddy configuration, so an application deploy is not evidence
that this policy reached the edge. The decision, policy rationale and the deliberate choice
not to add HSTS preload are in [ADR-0014](../docs/adr/0014-browser-security-policy.md).

Optional — for certificate expiry emails:

```bash
install -d -o root -g caddy -m 750 /etc/caddy/conf.d
printf '{\n\temail you@example.com\n}\n' > /etc/caddy/conf.d/acme.caddyfile
```

The committed Caddyfile globs `/etc/caddy/conf.d/*.caddyfile`, which tolerates matching
nothing. It is kept off-repo so a personal address is not committed to a public repository.

> A **glob** matters here: an `import` of a single literal path fails outright when the
> file is absent (`File to import not found`).

The deploy user may restart the two application services and start only the two exact
pre-migration backup unit instances. It does not receive a wildcard service grant:

```bash
printf '%s\n' \
  'tailfin ALL=(root) NOPASSWD: /usr/bin/systemctl restart tailfin' \
  'tailfin ALL=(root) NOPASSWD: /usr/bin/systemctl restart tailfin-dev' \
  'tailfin ALL=(root) NOPASSWD: /usr/bin/systemctl start tailfin-migration-backup@tailfin.service' \
  'tailfin ALL=(root) NOPASSWD: /usr/bin/systemctl start tailfin-migration-backup@tailfin_dev.service' \
  > /etc/sudoers.d/tailfin-deploy
chmod 440 /etc/sudoers.d/tailfin-deploy
visudo -cf /etc/sudoers.d/tailfin-deploy
```

Narrow on purpose — the deploy user can restart its applications and ask root's fixed backup
service to dump one of two fixed databases; it cannot supply a command, path or arbitrary unit.

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
install -o root -g root -m 0755 /srv/tailfin/deploy/restore-rehearsal.sh \
  /usr/local/sbin/tailfin-restore-rehearsal
install -o root -g root -m 0755 /srv/tailfin/deploy/migration-backup.sh \
  /usr/local/sbin/tailfin-migration-backup
cp /srv/tailfin/deploy/tailfin-backup.{service,timer} /etc/systemd/system/
cp /srv/tailfin/deploy/tailfin-backup-failed.service /etc/systemd/system/
cp /srv/tailfin/deploy/tailfin-migration-backup@.service /etc/systemd/system/
install -d -o postgres -g postgres -m 700 /var/backups/tailfin
install -d -o postgres -g postgres -m 700 /var/backups/tailfin/pre-migration
install -d -o root -g postgres -m 0750 /etc/tailfin
apt install -y s3cmd
systemctl daemon-reload
systemctl enable --now tailfin-backup.timer
```

`tailfin-backup-failed.service` is the `OnFailure=` target and is **not** enabled or timed
— systemd starts it when the backup unit fails and at no other time. Copying it is enough;
enabling it would be meaningless.

Then set up alerting, below. Prove the whole path once rather than assuming it:

```bash
# A real run, off-box copy included.
sudo systemctl start tailfin-backup && journalctl -u tailfin-backup -n 30 --no-pager

# And that a failure is actually reported. Expect a "fail" ping to arrive.
sudo systemctl start tailfin-backup-failed
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
Every dump's table of contents is read back immediately after writing, and both the dump and
sidecar must reach DreamObjects — a remote archive without its independent checksum is not a
complete recovery set. A dump that cannot be listed is renamed `.corrupt` and the run fails,
because an unreadable archive is worse than no archive: you will believe you are covered.

**An upload failure is a backup failure.** A dump that did not leave the box is not a
backup, and the run exits non-zero to say so.

`Persistent=true` on the timer means a run missed while the box was off happens on next
boot rather than being skipped.

### Restoring

Practise into a scratch database — never straight over a live one. The `_test` suffix is a
hard safety boundary, not decoration: the rehearsal command refuses any other target and
rechecks the suffix immediately beside its only `dropdb`. It also refuses an existing
scratch database instead of guessing that it may delete it.

The procedure below downloads from DreamObjects. It never accepts a local dump path, because
the off-box copy is the copy that survives loss of this volume.

#### Repeatable rehearsal — exact commands

1. Make sure the production checkout is built and see which nightly object will be used:

   ```bash
   sudo -u tailfin git -C /srv/tailfin log -1 --oneline
   test -s /srv/tailfin/packages/server/dist/main.js
   sudo -u postgres s3cmd --config=/etc/tailfin/dreamobjects.s3cfg \
     ls s3://backupstailfin/nightly/tailfin/ | tail -n 4
   ```

   Expect a recent `.dump` and its `.dump.sha256`. Stop if either is absent. The `tailfin`
   in this command is an object prefix; it is never passed to `psql`, `createdb`,
   `pg_restore` or the application.

2. Install the reviewed command from that checkout. Application deploys do not update
   `/usr/local/sbin`:

   ```bash
   sudo install -o root -g root -m 0755 \
     /srv/tailfin/deploy/restore-rehearsal.sh \
     /usr/local/sbin/tailfin-restore-rehearsal
   sudo install -d -o root -g root -m 0755 /var/log/tailfin
   ```

3. Run it with `pipefail` so `tee` cannot hide a failed rehearsal:

   ```bash
   set -o pipefail
   restore_log="/var/log/tailfin/restore-rehearsal-$(date -u +%Y%m%dT%H%M%SZ).log"
   sudo /usr/local/sbin/tailfin-restore-rehearsal 2>&1 \
     | sudo tee "${restore_log}"
   ```

   Expect `RESTORE REHEARSAL PASSED`, followed by the exact object and checksum, domain
   counts, Flagship in-game date, migration/trigger result, per-step seconds, total observed
   recovery time (RTO), and the nightly worst-case recovery point (RPO). Keep this log with
   the operational record; it contains no credential or session secret.

4. Prove cleanup. The query must print nothing:

   ```bash
   sudo -u postgres psql -XAtqc \
     "SELECT datname FROM pg_database WHERE datname = 'tailfin_restore_test'"
   ```

5. If the command failed, read the recorded step, fix the cause, and repeat from step 3.
   The exit trap stops the isolated server, drops only the database it created and removes
   the downloaded files. An already-existing `tailfin_restore_test` is left untouched for a
   human to inspect or remove deliberately.

Under the one command, in order: select the newest remote nightly; download its dump and
sidecar; compare SHA-256 and list the archive; create `tailfin_restore_test` with `C`
collation and owner `tailfin`; restore in one transaction; apply every migration from the
current checkout; boot Fastify on loopback port 3099; require healthy Postgres; verify airport,
runway and world data; derive the Flagship date with the same
`epoch + speed × (now − launchDate)` rule as `currentGameDate`; and prove the restored
`admin_audit` trigger still refuses deletion. A green `/healthz` alone is insufficient — it
also goes green against an empty database, which is why the domain and schema checks follow.

The dump uses `--no-owner --no-privileges`, and the rehearsal restores as the `tailfin`
role. The application therefore exercises the same ownership and permissions it would need
after recovery, rather than merely proving that the `postgres` superuser can read the data.

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
as "the restore worked"; the repeatable procedure above asserts domain data, the Flagship
clock and append-only schema behaviour after applying current migrations.

#### The selective recovery it enabled

The 2026-08-18 rehearsal found a real incident: a destructive test had pruned all **85,915
airports and 47,926 runways** from `tailfin_dev`. The nightly backup predated the damage, but
a whole-database replacement would also have erased the admin grant, Flagship world and 133
audit entries written since that recovery point.

The operator first copied that nightly object to `s3://backupstailfin/preserved/`, outside
both retention prefixes, then restored **data only** for `airport`, `runway` and
`dataset_version`. The recovered tier distribution matched M1-02 exactly: 25 flagship, 113
large, 491 medium, 1,343 small, and 2,387 regional airports.

That is an incident record, not the default command. A selective restore is justified only
after the full archive has passed the `_test` rehearsal, the damaged relations and foreign-key
closure are known, the target service is stopped, the affected live tables are proved empty
or deliberately cleared, and a separate pre-repair backup is preserved outside automatic
retention. Otherwise restore the whole database into a new database and cut over deliberately;
mixing one recovery point into a partially live relational graph can be worse than the loss.

### Alerting

A backup job that fails silently is worse than none, because it manufactures confidence.
Three layers, and each covers something the other two cannot:

| Layer                          | Catches                                                                      |
| ------------------------------ | ---------------------------------------------------------------------------- |
| `backup.sh` pings on finishing | A handled failure — a dump that would not verify, an upload refused          |
| `OnFailure=` on the unit       | A run that died before it could report — OOM, the 30-minute timeout, a crash |
| The switch's own grace period  | A run that **never happened** — timer disabled, box off                      |

The third is the one worth dwelling on: nothing running on a dead machine can report that
the machine is dead. Only something _expecting_ a ping can notice one that never arrives,
which is why a dead-man's-switch rather than an alert-on-error.

Set up with any healthchecks.io-style service — a POST to the URL means success, a POST to
`<url>/fail` means failure. Configure the check for a **1-day period with a 2-hour grace**:
the timer runs nightly with up to five minutes of jitter, so that tolerates a slow dump
and still complains inside the day OPS-03 asks for.

```bash
sudo install -m 0640 -o root -g postgres /dev/null /etc/tailfin/backup.env
sudo tee /etc/tailfin/backup.env >/dev/null <<'ENV'
HEARTBEAT_URL=https://hc-ping.com/your-uuid-here
ENV
```

Read by both units through `EnvironmentFile=-`, so the leading `-` means a box without it
still takes backups — and says so on every run:

```
warning: HEARTBEAT_URL is not set — nothing will notice if this stops running
```

That line is deliberate. A box with no alerting configured otherwise looks exactly like a
box whose alerting is working.

**A failed ping never fails a backup.** A network blip while the dump is safely on disk and
in the bucket is not a backup failure, and treating it as one would make the alerting a
source of false alarms. Ping failures are logged and ignored — and the grace period
notices the missing ping anyway.

The admin console reads `last-run.json` too, and treats a result older than 26 hours as an
alert on its own. That is the passive half; the ping is what reaches somebody who is not
looking.

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
./deploy/deploy-dev.sh origin/my-branch
./deploy/deploy-dev.sh origin/main
./deploy/deploy-dev.sh 1822d3c
```

A bare branch name is resolved against `origin`, and that is worth stating
precisely because it is not the order git would use on its own:

- `origin/<ref>` is tried **first**. The local branches in these checkouts are
  fossils of the original clone — the checkout went detached on the first deploy
  and nothing has updated them since. `/srv/tailfin-dev` held a local `main`
  **188 commits** behind `origin/main` when this was written. Preferring it would
  have deployed that silently while reporting `main`.
- A SHA or a tag has no `origin/` counterpart, so it falls through and is used as
  given. (A tag deliberately named after a remote branch would lose to the
  branch. Do not do that.)
- `HEAD` is excluded from the rule and always means this checkout's current
  commit. `origin/HEAD` exists on both boxes — a clone points it at the remote's
  default branch — so without the exclusion "what is running here" would silently
  become "the tip of main".
- A ref that matches neither is refused by name, saying both forms it tried.

Before this, only the `origin/`-qualified form worked at all: a bare name died
with git's `ambiguous argument`, while this block said otherwise.

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

It updates the checkout, builds, takes a migration backup when needed, migrates and restarts
the app. It deliberately cannot write to `/etc` or `/usr/local/sbin` — its sudoers grants are
the two application restarts and two fixed backup unit instances above. So editing
`deploy/Caddyfile`, a unit or an installed helper in the repo does **not** reach the running
system on deploy. Apply those by hand, as root:

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

## The dev worker node (OPS-09)

`tailfin-dev-worker-01` — `208.113.129.83`, `gp1.lightspeed`, key pair `tailfin2` — runs the
simulation engine and nothing else. It is the first place a Tailfin worker has ever run, which
is the point: production must not be where the engine's operational behaviour gets learned.

|                 | dev web (`208.113.129.131`)      | dev worker (`208.113.129.83`)                                  |
| --------------- | -------------------------------- | -------------------------------------------------------------- |
| Checkout        | `/srv/tailfin-dev`               | `/srv/tailfin-dev-worker`                                      |
| Service         | `tailfin-dev`                    | `tailfin-dev-worker`                                           |
| Entry point     | `dist/main.js`                   | `dist/worker.js`                                               |
| Port            | 3001, proxied by Caddy           | 3100, **loopback only, no vhost**                              |
| Database        | local socket, role `tailfin_dev` | `127.0.0.1:5433` through the tunnel, role `tailfin_worker_dev` |
| Owns migrations | **yes**                          | no (`RUNS_MIGRATIONS=0`)                                       |
| Log in as       | `tailfin@…` directly             | `ubuntu@…`, then `sudo -u tailfin` — see below                 |
| Deploy          | `./deploy/deploy-dev.sh`         | `./deploy/deploy-dev-worker.sh`, **not as `ubuntu`**           |

### Which user the deploy runs as

The two boxes are reached differently, and this is the easiest thing here to get wrong. On the web host the `tailfin` user has its own `authorized_keys` (step 3), so `ssh tailfin@208.113.129.131` puts you straight into the account that owns `/srv/tailfin-dev`, and `./deploy/deploy-dev.sh` needs nothing further. **This box has no `tailfin` login at all** — `ssh tailfin@208.113.129.83` is refused `Permission denied (publickey)`. You arrive as `ubuntu`, the cloud-init account carrying the `tailfin2` key, while `/srv/tailfin-dev-worker` and the service belong to `tailfin`. So the deploy has to hop:

```bash
ssh -i ~/.ssh/tailfin2.pem ubuntu@208.113.129.83 \
  'sudo -n -u tailfin -H bash -lc "cd /srv/tailfin-dev-worker && ./deploy/deploy-dev-worker.sh <ref>"'
```

`-u tailfin` is the whole point of the line. `-n` is the flag worth keeping: it refuses to prompt, so a sudoers grant that is not there fails immediately instead of hanging on a password prompt that a non-interactive SSH has no terminal to answer. `-H` and `-lc` are belt-and-braces — measured on this box, sudo already sets `HOME=/home/tailfin` without `-H`, and `git`, `node` and `pnpm` are all in `/usr/bin`, so a login shell finds the same toolchain a non-login one does. They cost nothing and stop the command depending on this box's `env_reset` and `secure_path` settings, which is why they stay in the documented form.

Run it as `ubuntu` instead and it dies at the first step, describing what looks like a broken checkout rather than a wrong user:

```
==> Fetching
fatal: detected dubious ownership in repository at '/srv/tailfin-dev-worker'
```

**Do not take git's suggested fix.** It offers `git config --global --add safe.directory /srv/tailfin-dev-worker`, which repairs nothing — it silences the guard by declaring that `ubuntu` may operate a `tailfin`-owned tree. The deploy would then get past `Fetching` and carry on as the wrong user, writing `node_modules` and `dist` into a checkout the service account has to run and the next deploy has to overwrite. The guard is reporting the account, not the repository; change the account.

`ubuntu` is right for the [health checks](#checking-on-it) below, because `curl` against loopback touches nothing `tailfin` owns. It is wrong for anything that writes to the checkout.

### Why a tunnel and not a Postgres listener

The two VMs have no private network — both sit on the public `208.113.128.0/21` shared with
other DreamCompute tenants, which a packet capture on the web host makes plain. Opening 5432
onto that segment was rejected; `tailfin-db-tunnel.service` forwards over SSH instead, so
Postgres keeps `listen_addresses = localhost` and ufw keeps allowing only 22/80/443. **Adding
this node created no new listening port anywhere.**

The tunnel account is `tailfin-tunnel` on the web host: `/usr/sbin/nologin`, with

```
restrict,port-forwarding,permitopen="127.0.0.1:5432" ssh-ed25519 AAAA...
```

so the key cannot get a shell (it answers `This account is currently not available.`) and
cannot forward anywhere else.

### Why the worker cannot reach production

Not because its connection string points elsewhere — because the server refuses it.
`pg_hba.conf` carries, **above** the catch-all:

```
host    tailfin_dev    tailfin_worker_dev    127.0.0.1/32    scram-sha-256
host    all            tailfin_worker_dev    all             reject
```

Demonstrated rather than asserted: connecting that role to `tailfin` returns
`FATAL: pg_hba.conf rejects connection for host "127.0.0.1", user "tailfin_worker_dev",
database "tailfin"`. The original file is kept at `pg_hba.conf.pre-ops09`.

### Which keys belong to which role

The worker's `.env` is **not** a copy of the web node's. Absent, not blank:
`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `SESSION_SECRET`, `WEB_SURFACE`, `PORT`. A process
serving no sessions has no business holding the key that signs them, and `loadEnv()` refuses a
half-configured auth setup — so a partial copy fails at boot rather than running degraded.
Worker-only keys are `WORKER_HEALTH_PORT`, `WORKER_HEALTH_HOST` and `WORKER_TICK_INTERVAL_MS`.

### Failure modes

| Symptom                                                     | Cause                                                | What to do                                                                                                                                                   |
| ----------------------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `worker` inactive, `tunnel` inactive                        | The unit `Requires=` the tunnel, so it stops with it | `systemctl start tailfin-db-tunnel` then the worker; the dependency is deliberate — a worker logging connection failures at 1 Hz is worse than a stopped one |
| `/healthz` 503, `engine.status: stopped`                    | Process alive, loop not running                      | The failure `systemctl is-active` cannot see. Read the journal; this is why the endpoint exists                                                              |
| `/healthz` 503, `db: down`, `engine.status: running`        | Tunnel up but Postgres unreachable                   | Counters keep working through it by design — the snapshot needs no database                                                                                  |
| `engine.errors` rising                                      | Each tick is throwing                                | `journalctl -u tailfin-dev-worker`; a failing tick does not stop the clock, so this climbs quietly                                                           |
| `engine.failed` rising                                      | Events drained of a type with no handler             | Check `engine.unhandledEventTypes` — see the warning below                                                                                                   |
| Deploy says "does not own them — deploy the web node first" | Schema change pending                                | Deploy dev web first. Ordering is enforced, not documented                                                                                                   |
| `dubious ownership` at `==> Fetching`                       | Deploy run as `ubuntu`; `tailfin` owns the checkout  | Re-run through `sudo -n -u tailfin -H` — see [Which user the deploy runs as](#which-user-the-deploy-runs-as). **Do not add `safe.directory`**                |
| `Permission denied` running the deploy script               | Checkout is at a commit predating it                 | `git checkout --detach origin/<ref>` once, then deploy normally                                                                                              |

### The warning that matters before scheduling real work

`/healthz` reports `engine.unhandledEventTypes`, and today it is
`["FLIGHT_DEPART", "TURNAROUND_COMPLETE"]`. `drainDueEvents` marks an event of an unhandled
type **failed** rather than done, so a worker started against a queue holding materialised
departures marks every one of them failed on the first tick. It was safe to start here because
`tailfin_dev` had **zero** `world_event` rows, verified first. **Check the queue before
starting a worker anywhere else**, production included.

### Checking on it

```bash
ssh -i ~/.ssh/tailfin2.pem ubuntu@208.113.129.83 'curl -s http://127.0.0.1:3100/healthz'
```

```bash
ssh -i ~/.ssh/tailfin2.pem ubuntu@208.113.129.83 'curl -s http://127.0.0.1:3100/queues'
```

`/queues` asks Postgres per world, so it is deliberately not part of `/healthz`, which a
deploy script polls every second.

---

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
(see [Backups](#backups)). M13-11 covers the wider data-protection story. The off-box copy
was restored into a disposable database on 2026-08-18, and OPS-04 turned that one-off into
the repeatable, measured procedure above. Rehearse it after meaningful schema or backup
changes and at least quarterly; a historic success proves that archive, not every future one.
