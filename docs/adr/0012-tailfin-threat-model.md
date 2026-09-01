# ADR-0012: Tailfin's threat model

- **Status:** Accepted
- **Date:** 2026-08-20
- **Deciders:** @simmeh024
- **Constrains:** SEC-HARD, AUTH, SEC, OPS and every externally reachable feature

## Context

Tailfin is a persistent shared world. A forged command, stolen admin session or corrupt
settlement does not hurt only one request: it can alter a cumulative economy in which other
players have invested months. Restoring a backup also removes every honest change made
after that backup, so recovery cannot make all players whole automatically.

Security work therefore starts with the integrity of the shared world, then protects the
identities and control paths that can change it. This model is deliberately short enough to
re-read during design and review. It describes the deployed system in
[`docs/deploy.md`](../deploy.md), not the system Tailfin may have later.

## Assets, ranked

The ranks decide priority when time or controls conflict; a lower rank is not permission to
ignore an asset.

| Rank | Asset                                              | What must remain true                                                                                                                                                            |
| ---- | -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | Airlines, world history and the game economy       | Commands and simulation outcomes are authorised, deterministic where promised, durable and attributable. One player cannot manufacture value or change another airline.          |
| 2    | Admin authority, grants and audit history          | Only the intended operator can perform privileged actions, and the durable record of those actions cannot be rewritten.                                                          |
| 3    | Player accounts, ownership and session tokens      | A Google identity resolves to the right player; a session grants no more authority and lasts no longer than intended.                                                            |
| 4    | PostgreSQL, off-box backups and service continuity | The authoritative state stays correct and recoverable. Confidential copies do not become a cheaper route around application controls.                                            |
| 5    | Deployment access and build provenance             | SSH, GitHub access, Actions, dependencies and the code deployed to the VM cannot silently replace the reviewed application.                                                      |
| 6    | Secrets                                            | Database and session secrets, Google OAuth credentials, DreamObjects keys and future Stripe/POD credentials stay out of source, logs and untrusted processes and can be rotated. |
| 7    | Personal and commerce data                         | Email/profile data and future shipping addresses, order identifiers and fulfilment data are disclosed only for their intended purpose. Tailfin never receives card data.         |

Availability is part of ranks 1 and 4: a stopped event queue or exhausted database can make
the persistent world incorrect, not merely slow. Public source code, public airline facts
and public game rules are intentionally not confidential assets.

## Trust boundaries

### Deployed today

```text
Untrusted Internet
    |
    +-- HTTP/HTTPS :80/:443 --> Caddy (TLS and public edge, one DreamCompute VM)
    |                              |
    |                              +-- loopback :3000 --> production Fastify/web
    |                              |                         |
    |                              |                         +--> local PostgreSQL: tailfin
    |                              |
    |                              +-- loopback :3001 --> dev Fastify/web
    |                                                        |
    |                                                        +--> local PostgreSQL: tailfin_dev
    |
    +-- SSH :22 -------------> operator/host boundary
    |                              ^
    |                              |  OPS-09: the dev worker node's only route in
    |                              |  (tailfin-tunnel, forced to one forward)
    |
    +-- (no listener) --------> tailfin-dev-worker-01, a second DreamCompute VM
                                   |
                                   +-- SSH -L 127.0.0.1:5433 -> the web host's
                                   |   loopback :5432, as tailfin-tunnel
                                   |
                                   +--> PostgreSQL: tailfin_dev, as
                                        tailfin_worker_dev (pg_hba refuses it
                                        the production database)

Browser <--------------------> Google OAuth
Tailfin server --------------> Google token/user-info endpoints
operator/deploy checkout ----> GitHub
local backup job ------------> DreamObjects (a full database copy)
dev worker ------------------> open.er-api.com (display FX rates, no key) [M8-02]
```

**The dev worker is a second host, and it is deliberately the quieter side of every link.**
It listens on nothing reachable — ufw allows only :22, its health endpoint binds loopback,
and the unit adds `IPAddressDeny=any` — so it originates connections and accepts none from
the application estate. Its route to the database is an SSH forward rather than a Postgres
listener, which was chosen because both VMs sit on a _shared public segment_ with other
DreamCompute tenants: a packet capture on the web host shows their broadcast traffic. No new
listening port exists anywhere as a result of adding the node.

Two credentials bound it, and neither is trusted further than it must be. The tunnel account
`tailfin-tunnel` has `/usr/sbin/nologin` and an `authorized_keys` entry of
`restrict,port-forwarding,permitopen="127.0.0.1:5432"` — proven by test to refuse a shell
and unable to forward anywhere else. The database role `tailfin_worker_dev` is confined by
`pg_hba.conf` to `tailfin_dev` and is **rejected** for `tailfin`, which is a property of
the server rather than of the connection string the worker was handed. It holds no
`SESSION_SECRET` and no Google credential: a process that serves no sessions has no business
holding the key that signs them.

What this does not buy: the forward is a convenience over a shared segment, not a private
network. Root on the worker node can use the tunnel, so the worker node is inside the dev
trust boundary — it is simply outside production's. WireGuard (OPS-13) is the version that
would make it a network boundary rather than an access-control one.

**The worker's one new outbound is a display-FX read (M8-02).** It fetches USD-based exchange
rates from `open.er-api.com` once a real day, over TLS, with **no credential** — the endpoint is
public, so nothing is at risk of leaking to it. The asset it touches is _display_ only: rates
convert money for the player's eyes and never a stored value, so a forged, stale or unavailable
response cannot move money, only mis-render it, and the code caps the blast radius — a 10-second
timeout, shape validation that discards non-numeric rates, an at-most-hourly attempt throttle so an
outage cannot be turned into a request flood, and a fall-back to the last good (or seeded) rates on
any failure. Production has no worker and so makes no such call at all. It is the worker's only
third-party dependency beyond the database; the web process does not make it.

Caddy, both application processes, both databases, the build checkout and the backup job
share one host. Process, database and environment-file separation reduces accidents; it is
**not** a security boundary against root or host compromise. Dev accepts open Google
registration and unmerged code, so no dev credential or data is trusted by production even
though the current host makes complete isolation impossible.

The browser and every value it sends are untrusted. Caddy terminates public TLS; Fastify is
the authority for validation, authentication and authorisation; PostgreSQL is the authority
for durable invariants. Google proves an external identity but does not decide Tailfin
ownership or admin rights. DreamObjects receives a copy of the whole database and is inside
the data-protection scope. GitHub cannot deploy to production: the operator's SSH session
and manual deploy command are the approval boundary.

### Local aircraft tooling (M6-25)

The offline aircraft preflight may read a Meshy credential from the invoking operator process or an
explicit bounded local file. It returns only a presence/shape status, never the key, credential path
or raw parser/OS errors. It has no network transport, writes, application endpoint or deployed
Web/Worker credential. This reduces accidental disclosure, not workstation-compromise risk.

The separate read-only balance command requires an immutable local approval and exact ceiling.
It GETs one fixed HTTPS endpoint with redirect, retry, timeout and decoded-size bounds; only a
numeric balance projection escapes. ADR-0024 adds a Git-common SQLite ledger with serialized
durable reservations and quarantine-only provenance descriptors. The key is never persisted.

Candidate recovery now accepts untrusted GLB downloads into a private quarantine: fixed HTTPS asset
host, no forwarded API credential, no redirects, bounded decoded bytes/deadlines, container-envelope
validation, immutable hashed objects and a sanitized completion manifest written last. It never
executes embedded/external glTF resources or emits provider errors/signed URLs. Only already recorded
task IDs can be recovered; recovery exposes no arbitrary adoption or paid POST. Corrupt or redirected
local archives fail closed. These controls do not replace conformance, resource, licence or visual QA.

The separate candidate submit command introduces external spending under ADR-0024. It verifies
immutable reference/consent/rights/terms/private-plan bytes, bounded nonanimated PNG decoding,
paid-period and recent operator pricing attestations plus fresh account readiness. Only the PNG
is uploaded; receipt/consent/terms remain private. Request proofs bind all identities and COMMIT
before one fixed-host, bounded POST. Unknown outcomes retain reservations and block further
spending; there are no POST retries or automatic adoption. Sequential terminal charge checks and
archive-before-next-spend prevent speculative concurrency; the transaction arbitrates races.
Operator pricing is not a provider-enforced quote, and subscription/balance is not spending
authority. A workstation owner can still replace code or all history; hashes are not signatures.
Quarantine provenance is not licensing/distribution approval (#793), and Pro/private is not a
training opt-out. No retexture/fallback transport, application endpoint or runtime promotion exists.

### Boundaries that do not exist yet

OPS-08's web/worker split is now deployed on dev and is described above; OPS-11 must still
decide where the database lives when production gets a worker, and OPS-13 must decide whether
the SSH forward becomes a real private network. M12 will add long-lived WebSockets. POD
will add hosted Stripe checkout, signed Stripe and print-provider webhooks, fulfilment data
and shipping addresses. File uploads, object storage, transactional email and any CDN will
also create new boundaries.

None inherits trust merely because it is “internal” or supplied by a provider. The issue
that introduces one must update this ADR and `docs/deploy.md` in the same change.

## Attackers and failure modes

| Actor or failure mode                              | Capability we assume                                                                                                                | Typical objective or damage                                                                                                                                   |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A normal or malicious player                       | Controls their browser, scripts requests, changes identifiers and races/replays commands                                            | Operate on a competitor, manufacture cash or scarce assets, learn private state, or gain speed unavailable to a human player.                                 |
| Automated bots and abusive traffic                 | Create many requests/sessions and choose expensive inputs                                                                           | Farm the economy, enumerate accounts, exhaust the 2-vCPU host, queue or database, or deny service without needing a code exploit.                             |
| A session thief                                    | Possesses a player or admin cookie through device compromise, leakage or future XSS                                                 | Take over an airline or use privileged world/economy operations until the session expires or is revoked.                                                      |
| An opportunistic internet attacker                 | Reads the public source and probes all public ports and endpoints                                                                   | Exploit injection, request forgery, unsafe parsing, exposed services, error detail or stale software.                                                         |
| A credential thief                                 | Finds a secret in source, logs, backups, a workstation or provider account                                                          | Reach GitHub, SSH, PostgreSQL, backups, OAuth or future commerce providers outside normal application checks.                                                 |
| A malicious or compromised dependency/build action | Runs during CI, install or the on-host production build                                                                             | Steal workflow/deploy secrets or replace the code that reads and writes the world.                                                                            |
| A compromised admin account                        | Has legitimate high-impact application permissions                                                                                  | Change world state, grants or balances and attempt to conceal the action.                                                                                     |
| A compromised dev process or branch                | Runs unreviewed code on the shared host with dev configuration                                                                      | Steal dev data/credentials, exhaust the host, or seek a path into production.                                                                                 |
| An ordinary developer/operator mistake             | Can point destructive tests at the wrong database, commit a key, expose a port, misconfigure an environment or deploy the wrong ref | Cause the same confidentiality, integrity or availability loss as an attacker without malicious intent. This is a first-class threat because it has happened. |
| A failed, slow or forged provider interaction      | Delays, replays or fabricates an OAuth/webhook/backup response, or becomes unavailable                                              | Exhaust resources, create false payment/fulfilment state, lose recoverability or leave ambiguous state.                                                       |

Google credential stuffing is handled by Google, but Tailfin still limits what a stolen
Google-backed account or resulting Tailfin session can do. Anti-cheat includes honest-looking
API calls made at machine speed; it is not limited to malformed traffic.

## Security decisions implied by this model

- The client is never an authority. External input is validated at the server boundary,
  ownership is resolved from the session, and economic changes carry database-enforced
  idempotency, reconciliation and audit evidence. ADR-0020 makes another owner's private
  resource indistinguishable from an absent one and requires the owner scope inside the
  database query.
- Controls that preserve world integrity outrank controls that hide already-public source or
  game data. Recovery prefers targeted, attributable correction over restoring the entire
  world to an older snapshot.
- Secrets and full backups are control-plane assets: least privilege, separation, rotation
  and non-disclosure apply even when the application never exposes them directly.
- Dev data is disposable; production data is not. Sharing a host is recorded as risk, not
  treated as isolation.
- Bounded work and honest failure defend the 2-vCPU host against the abusive-traffic
  attacker. A per-client-IP rate limit at the application edge (`@fastify/rate-limit`, keyed
  on the `trustProxy`-resolved caller behind Caddy) caps request floods before they reach a
  handler; loopback is exempt so the worker and local tooling are never throttled. This is the
  first tranche of SEC-HARD-09 and does not, by itself, absorb a volumetric flood (see below).
- Security automation must prove a property and stay readable. A noisy or silently skipped
  control creates false confidence.
- Every SEC-HARD issue names the asset and attacker/failure mode it addresses. A proposed
  control with neither mapping is outside this model until the model is deliberately changed.

## What Tailfin deliberately does not defend against

- **Nation-state or similarly resourced targeted attackers**, including bespoke zero-days
  and prolonged compromise of several providers at once.
- **Volumetric DDoS or upstream bandwidth saturation.** Application-level resource
  exhaustion, bounded work and honest failure remain in scope; absorbing a network flood on
  a single VM does not.
- **Physical, hypervisor or cloud-control-plane compromise at DreamHost/DreamCompute**, or a
  total compromise of Google, GitHub, DreamObjects, Stripe or a future POD provider. Provider
  least privilege, detection, export and recovery are still in scope.
- **A malicious sole operator who simultaneously controls root/SSH, GitHub, the database and
  cloud accounts.** Tailfin reduces mistakes and records application actions, but one-person
  operation cannot enforce organisational separation against that person.
- **Google's password and account-recovery security.** Tailfin does not receive Google
  passwords. It protects its OAuth flow, Tailfin sessions and consequences of account
  takeover.
- **Cardholder-data security inside Tailfin**, because hosted Stripe Checkout is required and
  card data must never reach Tailfin. Stripe keys, payment state, order data, webhook
  authenticity and shipping addresses remain in scope.

These are budget and architecture boundaries, not claims that the events are impossible.
An observed incident is contained and recovered regardless of whether its attacker was a
design target.

## Keeping the model current

Review this ADR when an external provider, public port, privileged role, secret class,
personal-data class or deployment node is added. The topology diagram here,
`CLAUDE.md`'s canonical operational topology and the connection reasoning in
`docs/deploy.md` must change together.

## Consequences

- Security issues can be prioritised by the persistent-world damage they prevent rather
  than by generic checklists.
- The single-host dev/production risk and one-operator trust assumption remain visible.
- Controls outside the stated threats can be declined with a recorded reason.
- The model will become wrong if topology-changing work updates only code; cross-linking it
  to deployment documentation makes that drift reviewable.

## Revisit when

- OPS-11/OPS-12 move production Web, Worker, queue access or PostgreSQL across nodes;
- M12 adds public WebSockets;
- M6/POD add uploads or externally served player content;
- Stripe, POD fulfilment or transactional email first holds real customer data; or
- Tailfin gains another operator and can enforce separation of duties.
