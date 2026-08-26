# ADR-0023: The automation ladder — manual, policy and delegated

- **Status:** Accepted
- **Date:** 2026-08-27
- **Deciders:** @simmeh024
- **Constrains:** M5-05 and every crew/ground system that later grows a mode — disruption
  response first, then reserve crew, revenue rules, ground handling; and the §3.1 rule that
  decides what a worker is allowed to finish while the player is away.

## Context

Tailfin is real-time (§3.1's 2× clock), and §9.5 is blunt about the consequence: _"depth without
delegation becomes a chore."_ The design's answer is a ladder every crew/ground system climbs —
**Manual, Policy, Delegated** — and one hard promise from §3.1: _"flights complete offline,
decisions never do,"_ with delegation the single, deliberate exception (_"a delegated Ops
Controller executes the policy you already wrote, and any situation outside that policy waits for
you"_).

Two things make this an ADR rather than a feature. First, it is **load-bearing for the whole
milestone**: PR 1 and PR 2 gave the world disruptions that happen and cost money, but nothing yet
decides what to _do_ about one, and M5-05's acceptance criteria are all about that decision — a
delegated Ops Controller handling a disruption strictly within policy, an out-of-policy situation
queued rather than guessed, and delegation measurably but modestly worse than ideal manual play.
Second, the offline boundary is exactly the accident [ADR-0019](0019-web-worker-boundary.md)
exists to prevent: a worker that "helpfully" resolves something the player never authorised is a
decision completing offline, which §3.1 forbids. The line has to be drawn once, here, so every
system that later grows a mode draws it the same way.

The recovery _actions_ a controller might take — rebooking passengers onto another flight,
swapping an airframe, calling out reserve crew across a base — are mostly not built yet. So this
ADR settles the **ladder** (the modes, the policy model, the offline boundary, the storage) and
names the **first decision it governs**; the actions it can take grow as their systems land, the
same way `DisruptionRisk`'s inputs fill in one at a time.

## Decision

### 1. Three modes, and what each is allowed to finish offline

A mode is held **per airline, per system** — not globally — so a player can delegate disruption
response while keeping revenue manual. The mode decides what the worker does when it detects a
_situation_ (a disruption needing a response, a base short of reserve crew, a fare due a review):

- **Manual** — the worker **raises** the situation as a pending decision (§4) and does nothing
  else. Resolution is always the player's, online or offline. Full control, best result, highest
  attention cost. This is the default, and the only mode before a player opts in.
- **Policy** — the worker evaluates the player's **declarative rules** (§3) against the situation.
  A situation a rule covers is resolved **per that rule**; a situation no rule covers falls back
  to Manual — raised, and waits. Free. Optimal _within the rules the player wrote_; the gaps are
  theirs to write or to handle. Policy resolutions **do** complete offline, because they are the
  player's own instructions executing verbatim — not a decision the game invented.
- **Delegated** — Policy, plus three things. It **requires the relevant office hire** (the Ops
  Controller for disruption response) and stops resolving if that seat is vacated; it **costs that
  hire's salary**, already billed by the office payroll; and its resolutions carry a **modelled
  shortfall of ~10%** against ideal manual handling (§5). It is the mode the design sizes for —
  _"run a 200-aircraft airline on policy and delegation, and beat it by 10% with attention"_ — and
  the shortfall is what keeps that promise: never 0%, so the game is not a chore; never 100%, so
  it never punishes a player for having a life.

The rung the §3.1 exception opens is **Policy and Delegated for situations the player's own policy
covers**. Everything else — a situation outside policy, an airline in Manual — is **raised and
waits**. The worker never invents a resolution.

### 2. The first system: disruption response (the Ops Controller)

The ladder is generic, but it ships governing one decision, the one M5-05's criteria name: **how
the airline responds to a flight disruption**. The mechanical outcome of a disruption (delay or
cancel, and its passenger cost) is the world's, decided by PRs 1–2; the **response** — accept the
delay, or cut losses and cancel to protect the rotation behind it — is the decision the mode
governs, and the Ops Controller is its office seat (`role = 'ops-controller'`).

Concretely, the first policy rule is a **delay ceiling**: _"cancel a delay longer than N hours,
otherwise let it run."_ It is exactly the shape §9.5 gives as an example (_"auto-rebook delays
under 2h"_), it needs no mechanic that does not exist, and it is a real strategic choice —
cancelling early frees the aircraft and crew for the next rotation at the price of the passengers
aboard. As reserve-crew, rebooking and airframe-swap mechanics land, they become further rule
types and further systems on the same ladder, without re-deciding any of this.

### 3. Policy is a versioned declarative document, not code

A policy is **data** — a small JSON document of typed rules, parsed on the way out against
today's schema, exactly as [`EconomyConfig`](../../packages/shared/src/economy-config.ts) is.
Never a script, never a stored expression to evaluate: a rule the worker runs offline against a
live airline must be inspectable, diffable and impossible to make Turing-complete by accident. The
first schema is a single typed rule (`disruptionResponse: { cancelDelaysOverMinutes: number }`);
new rule types are additive fields with defaults, so an older policy stays parseable after a new
one ships — the same expand discipline the database and the economy config already hold.

The document is owned by the player and edited through the API; the worker only **reads** it. A
malformed or absent policy is read as **no rule** (fall back to Manual), never as a guessed
default — an unparseable policy must not silently start cancelling flights.

### 4. Out-of-policy situations queue, they do not resolve

The §3.1 promise needs somewhere for _"waits for you"_ to live. A new **operations task** is the
queue: one row per situation the worker detected but is not authorised to resolve — a disruption
under Manual, or one under Policy/Delegated that no rule covers. It names the airline, the world,
the kind, the subject (the flight), a human sentence, and when it was raised; it is resolved when
the player acts, or when the thing it describes is overtaken by events. The admin console's health
view and the player's own surfaces read it; nothing in the worker _acts_ on it. It is the visible
proof that a decision waited rather than being guessed — the counterpart to the AIR-06 ledger for
money, for decisions.

### 5. Delegation's shortfall is modelled, not emergent

Delegated is _"slightly sub-optimal"_ by design, and the target is **10%** (owner's call). It is
applied as a deliberate degradation of the delegated resolution against the ideal one, not left to
emerge — an emergent gap cannot be promised to stay near 10%, and the promise is the point. For
the delay-ceiling rule the lever is conservatism: the delegated controller holds to a safe,
slightly-too-eager cancellation margin rather than the player's optimum, so it recovers about 90%
of the value ideal manual timing would. Each future rule type names its own 10% lever the same
way; the number itself lives with the balance config, not in the code, so it can be retuned like
any other.

## Data model

Two tables, both keyed by the airline (owner-scoped, resolved from the session — never accepted
from the client, per ADR-0010/ADR-0020), both cascade-deleted with the airline and the world.

**`automation_setting`** — one row per `(airline_id, system)`, unique on that pair. Absence of a
row means Manual with no policy, so the default costs no row and a world reset that deletes it
restores the default (ADR-0005). Columns:

- `system text` — the governed system. `'disruption'` first; the enum of systems grows.
- `mode text` — `'manual' | 'policy' | 'delegated'`.
- `policy text` — the declarative document (§3) as JSON text, parsed on read against today's
  schema like the economy config and the maintenance state; null when none is written.
- `updated_at timestamptz`.

**`operations_task`** — the queue of situations awaiting the player (§4). Columns:

- `world_id`, `airline_id` — FKs, cascade.
- `system text`, `kind text` — what raised it and what sort it is.
- `subject_type text`, `subject_id uuid` — what it is about (a flight), nullable for a base-wide task.
- `detail text` — the human sentence the console shows.
- `raised_at timestamptz`, `resolved_at timestamptz` nullable.
- A partial unique index on `(airline_id, system, subject_id) where resolved_at is null`, so the
  worker raising the same situation twice — after a restart, or two workers racing — makes one open
  task, not a pile. The same idempotency-by-constraint the queue and the used market already use.

Neither table stores a mode or a policy for a system that does not exist yet; a new system is a new
`system` value plus its rule type in the policy schema, added when its milestone lands.

## Consequences

- The worker gains the right, in Policy/Delegated only and only within written rules, to complete a
  decision offline. That is a real widening of [ADR-0019](0019-web-worker-boundary.md)'s boundary,
  and it is drawn narrowly on purpose: the engine reads the setting and the policy, applies a
  covered rule, and raises an `operations_task` for everything else. `engine/boundary.test.ts`
  gains a case that an uncovered situation is queued, never resolved.
- Delegated is the first gameplay reason the **Ops Controller hire has teeth** beyond its salary —
  it is the seat that unlocks offline disruption response, the way Safety & Compliance unlocks
  long-haul. Vacating the seat drops the airline back to Policy (rules still run) but stops it
  being _run for you_.
- A pending `operations_task` is a new thing the player must be shown, or delegation's "waits for
  you" is invisible and reads as the game doing nothing. The admin health view and a player surface
  read the queue; building those is part of the milestone, not a follow-on.
- Money and decisions now have symmetric audit trails: AIR-06 says every movement of cash was
  authorised and explicable; `operations_task` says every decision the worker did _not_ take was
  deliberately left for the player. A world can be inspected for both.

## Revisit when

- A recovery mechanic lands that a controller could take autonomously (rebooking onto another
  flight, an airframe swap, a base-wide reserve call-out). Each is a new rule type and possibly a
  new `system`; none re-opens the mode model or the offline boundary.
- The 10% target is retuned. It is a balance number and moves through the config, not this ADR;
  this ADR only fixes that the shortfall is _modelled and non-zero_, not its exact size.

## Alternatives considered

- **A single global mode per airline.** Rejected: a player who trusts the Ops Controller with
  disruptions has no reason to also hand over revenue, and forcing the choice all-or-nothing makes
  delegation an all-or-nothing gamble rather than a dial. Per-system is the whole point of a ladder.
- **Policy as a stored expression the worker evaluates.** Rejected outright: a language the worker
  runs offline against a live airline is an injection surface and an un-auditable one. Typed rules
  are less expressive and that is a feature — the expressiveness a player needs is a short list of
  named levers, not a scripting language.
- **Let the delegation shortfall emerge from a simpler controller.** Rejected: an emergent gap
  cannot be held near a target, and "modestly worse, never much worse" is a promise to the player,
  not an accident to observe. The gap is a modelled 10%, retunable, so it stays a promise.
- **No queue; an unresolved situation just reverts to the mechanical default.** Rejected: that is a
  decision completing offline by omission, and it hides from the player that anything needed them.
  The queue is what makes §3.1's "waits for you" true rather than aspirational.
