# Alerts and the offline digest

§14.5's alert rules and §3.2's offline arrival digest, as built by M8-13
([#85](https://github.com/simmeh024/tailfinsim/issues/85)).

The design doc asks for nine alerts and one feed:

> Delivered in the offline digest and on the dashboard:
>
> `route loss-making 7 days running` · `cash runway < 30 days` · `DSCR approaching covenant` · `crew shortfall at base in 5 days` · `C-check due, no slot booked` · `gate lease expiring` · `competitor entered your route` · `event announced affecting your network` · `spill > 15% on a route`

Seven of the nine are here. §9.3's own contract-lapse warning stands where the
eighth would be, and the ninth has nothing to fire against — both are
[named below](#named-as-absent-rather-than-invented) rather than approximated.

---

## An alert is a stored row

The tempting implementation recomputes the conditions on every read. It cannot
satisfy either criterion that matters.

- **"Alerts are deduplicated, not repeated every tick"** needs to know whether
  this alert has already been raised, which is a memory.
- **"The digest covers the exact period since last seen"** needs to know _when_
  each one was raised, which is the same memory with a timestamp on it.

So the worker raises rows in `alert` and every read projects them.
`raised_at` and `resolved_at` are **game time**
([ADR-0026](adr/0026-in-world-spans-are-game-time.md)): everything an alert is
about — a loss-making week, a runway in days, a lapsing term — is measured on the
world's clock, and a digest window that mixed the two calendars would select a
set that depended on which world speed the player left running. `created_at`
stays real, as it does everywhere: _when did this row appear_ is a different
question from _when did this happen in the world_.

### The deduplication is a constraint

`alert_open_subject_key` is a **partial** unique index on
`(airline_id, kind, subject_key) WHERE resolved_at IS NULL` — the same pattern
`operations_task` uses, and for the same reason: one open row per subject,
enforced by the database rather than by application logic that has to be right on
every restart and through every handover between two racing workers.

It is keyed on `subject_key` rather than on a nullable `subject_id`, and that is
load-bearing. **A unique index treats NULLs as distinct**, so an airline-wide
alert — a cash runway, a coverage ratio — would stack a fresh row on every sweep
behind an index that looked like it prevented exactly that. Every rule supplies a
`subject_key`, so there is no null case to get wrong.

`subject_key` is separate from `subject_id` because two rules need the identity
finer than the link:

| Rule                       | `subject_id` (the link) | `subject_key` (the identity) |
| -------------------------- | ----------------------- | ---------------------------- |
| `crew_shortfall`           | the airline             | `crew:<family>:<rank>`       |
| `competitor_entered_route` | the player's own route  | `<routeId>:<rivalAirlineId>` |
| everything else            | the subject             | the same as `subject_id`     |

Folding either into `subject_id` would lose the link or lose the distinction. A
second rival arriving on a route is a second decision, and one alert per route
would mean the player was never told.

`reconcileAlerts` in `@tailfin/sim` decides what is new; the index enforces it.
Both, deliberately — the reconciliation is what makes the **counters** honest (a
raise the index silently swallowed would be counted as news), and the index is
what survives concurrency. The insert is `ON CONFLICT DO NOTHING` **without a
target**, because Postgres cannot infer a partial unique index from the target
columns alone and answers `42P10` as though the index were missing.

### Resolution is the other half

An open alert whose condition no longer evaluates is **resolved**, dated at the
sweep's game time. That is what makes the digest's "Cleared" section real: a feed
that only ever reported problems would show a player who fixed three routes
exactly what it shows one who fixed none.

A `kind` the running build no longer recognises is **left alone** rather than
resolved. Dropping a rule would otherwise mass-resolve every row it ever raised
on the first tick after the deploy, and dropping it by accident — a typo in an
enum — would do the same thing silently.

---

## The rules

Every threshold lives in `server/src/alerts/thresholds.ts` as a named constant
with its reason. `@tailfin/sim`'s `alerts/rules.ts` takes them as an argument and
holds none of its own.

**Not `EconomyConfig`, and that was a decision.** §22.3's payload is _balance_ —
what things cost, how demand responds, what a lender will advance — and it is
immutable, versioned and pinned per world so a `flight_result` can always be
re-derived under the numbers it was billed with. These are none of that. They move
when an alert turns out to be too noisy or too quiet, which is a UX judgement,
and shipping such a change as a new economy version would force every world to
re-pin its balance in order to stop a warning firing a week early. It is the same
call M8-08 made for `CRITICAL_DAYS` and M8-11 for `RIVAL_SHARE_THRESHOLD`.

| Kind                       | Severity           | Fires when                                                                                                     | Links to                 |
| -------------------------- | ------------------ | -------------------------------------------------------------------------------------------------------------- | ------------------------ |
| `route_loss_making`        | critical           | Every day the route flew in the trailing 7 game days lost money, over at least 3 flown days                    | the route, on `/network` |
| `cash_runway`              | critical           | §13.6's projection is below 30 game days                                                                       | `/finance`               |
| `dscr_headroom`            | critical / warning | Coverage is below §13.1's floor / within 20% of it                                                             | `/finance`               |
| `crew_shortfall`           | critical / warning | A `(family, rank)` is short today / once the aircraft due inside 5 game days arrive                            | `/crew`                  |
| `check_due_unbooked`       | critical / warning | A check is overdue or the airframe is grounded / the interval is 90% used — and the airframe is not in a check | `/fleet`                 |
| `ground_contract_expiring` | critical / warning | An active contract's `term_end` is inside 7 / 30 game days                                                     | `/operations`            |
| `competitor_entered_route` | warning            | A rival's **first settled flight** on the airport pair falls inside the last 14 game days                      | the route, on `/network` |
| `route_spill`              | warning            | Spill exceeds 15% of offered demand over the trailing game month, across at least 5 settled flights            | the route, on `/network` |

There is no `info` severity. An alert nobody has to act on is a statistic, and
§14.3's dashboards are where a statistic goes.

### Three rules that are not what you would guess

**"Loss-making 7 days running" is not seven consecutive negative days.** A route
that flies three times a week can never produce seven of them, so a
consecutive-day test would quietly exempt exactly the thin routes §14.4 exists to
find. The window is seven game days and the test is **no profitable day in it**,
over at least three flown days — one bad Tuesday is not a trend, and a route that
flew once is not seven days of anything. A break-even day counts as not-a-loss:
zero contribution is not money leaving.

**"Competitor entered your route" means started flying, not opened a route.** A
rival can hold an open route it never operates, and that costs the player
nothing; what moves a load factor is an aeroplane in the market. So the test is
the rival's _earliest settled flight_ on the airport pair falling inside the
lookback. That needs no remembered state, is measured entirely on the world's
clock, and **stops being true on its own** once the rival has older history — the
alert resolves with nothing having had to expire it.

**"No slot booked" is `status !== 'in_check'`.** M4-06 has no booking calendar: a
check is booked and starts. So the only two states an airframe can be in are
_working_ and _in a check_, and an aeroplane flying with a due check is precisely
the unbooked case the design doc means. The rule fires for whichever tier is
heaviest and outstanding rather than only the C — an overdue A-check grounds an
aeroplane exactly as firmly, and §7.3's consequence chain starts at the first
skipped check rather than at the second.

### The sentences carry no money

Every rule writes its own detail sentence, in days, counts and ratios. **No
currency appears in any of them**, and that is deliberate: display currency is
the player's choice (M8-02) and conversion happens only at the client's render
boundary, so a sentence with dollars baked into it would be the one string on
screen that ignored the setting.

---

## The digest

`GET /api/digest` answers §3.2's promise:

> **Offline arrival digest** — you come back to a readable feed of what happened.

It carries the window, the airline's activity inside it, the alerts **raised**
and **resolved** inside it, and the alerts **open** right now.

### "Since last seen" is not `session.last_seen_at`

That is the obvious column and it cannot do the job:

- `findSessionPlayer` touches it on **every authenticated request**, so by the
  time a digest handler runs it already reads _now_ and the window is empty;
- it is per **device** — a player with a phone and a laptop has two rows, each
  telling a different story;
- and every row is deleted when a privilege change rotates session authority
  ([ADR-0015](adr/0015-session-authority.md)), which would silently erase the
  fact that the player had ever been here at all.

So _last seen_ means **the last digest the player acknowledged**, stored on
`alert_state.digest_covered_through_at`. That is a stronger reading of the
criterion rather than a weaker one: the window is the exact period whose events
the player has not yet been shown, and it survives a new device, a cleared cookie
and an admin grant.

### The read does not advance it

`GET /api/digest` reads the watermark and does not move it. Two consequences,
both wanted:

- it stays a **safe `GET`** under [ADR-0025](adr/0025-no-csrf-token.md), which
  `security/csrf.test.ts` enforces; and
- a page refresh shows the same feed rather than an empty one. A player's week of
  news must not be destroyed by a stray reload.

`POST /api/digest/read` is what says _I have seen this_. It carries the
`window.toAt` the client was shown, so it can never acknowledge past an event
nobody saw, and the server clamps it twice: **never backwards**, so a stale
acknowledgement arriving late cannot replay a dismissed period, and **never past
the world's own game time**, so a forged or wildly future value cannot swallow
the next real digest.

### Three window cases

| Case                                          | Window                             | Flags             |
| --------------------------------------------- | ---------------------------------- | ----------------- |
| First visit — no watermark                    | one capped span back from game-now | `first: true`     |
| A long absence — watermark older than the cap | truncated to the cap               | `truncated: true` |
| A normal return                               | exactly the watermark to game-now  | neither           |

The cap is a game month. §3.2 asks for _"a readable feed"_, and a player away for
a game year does not have one; the flag says so rather than the digest quietly
pretending the earlier part never happened.

A watermark **ahead** of the world clock is possible and is not an error: a world
can be reset ([ADR-0005](adr/0005-world-epoch-and-reset.md)), which winds the
clock back to the epoch while the acknowledgement stays where it was. The window
collapses to zero days rather than going negative, which would select every row
ever written.

### The activity is two reads, not one

Cancellations are counted from `flight`, not `flight_result` — a cancelled flight
never settles, so it has no result row at all, and counting only what settled
would report a perfect week to an airline that cancelled everything. The same
decision M8-12 made for the Operations dashboard, and it has to match: two
surfaces disagreeing about last week's cancellations is worse than either being
wrong alone.

`cashChangeMinor` sums the AIR-06 ledger over the window rather than differencing
two balances. The ledger is the record and the balance is the consequence — and
`cash_movement.occurred_at` has been game time for every cause since TIME-02, so
a window in game time selects the movements it should.

`onTimeRate` is **null over an empty window, never 0**. Zero reads as _every
flight was late_, a claim about a bad week rather than about an absent one — the
same rule M8-09 applies to every ratio it reports.

---

## The sweep, and what it costs on a node without a worker

`sweepWorldAlerts` runs on each world's game clock, inside the tick, after
schedule materialisation. Each airline carries its own watermark
(`alert_state.swept_at`, game time, **nullable meaning never**) and is
re-evaluated at most once per game hour; the sweep processes at most 25 airlines
per tick, oldest watermark first so nothing can be starved.

The interval and the cap exist because the rules are cheap to decide and
expensive to read: a runway projection and a coverage ratio each walk a year of
the ledger, and none of §14.5's conditions can move faster than a game hour
anyway. A sweep that threw leaves the watermark where it was, so the airline is
simply evaluated on the next tick.

**Production has no worker.** So there `swept_at` stays null for ever: no alert is
ever raised, no digest records anything as having happened, and `GET /api/alerts`
answers `200` with an empty list. **That reads as an airline with nothing wrong
rather than as a missing process** — the same trap as the empty used market, the
fleet page at `0.0 h/day` and the empty sky on the world map, and this one is the
most reassuring version of it.

Two things make the difference visible rather than silent:

- `AlertsResponse.evaluatedAt` is **null** when the rules have never run, and the
  status strip renders that as an em dash rather than as "None". An empty list and
  an unevaluated airline are different statements and the interface makes both.
- `alertsSwept`, `alertsRaised`, `alertsResolved` and `alertErrors` are the
  heartbeat counters. `alertsSwept` rising with `alertsRaised` at zero is a world
  where the rules ran and found nothing; `alertsSwept` at zero is a world where
  nothing ran.

---

## Named as absent rather than invented

**`gate lease expiring`** — nothing in the game leases a gate. A `slot_holding`
(M7-05) is a per-band operating right with **no term at all**, so there is no
countdown to run. The expiring commitment a player actually has is a §9.3
handling contract, and §9.3 asks for that alert in its own words —
`ground_contract_expiring` is here, and its sentence says _contract_ rather than
_lease_ so it cannot be mistaken for the thing that does not exist. See
[`ground-handling.md`](ground-handling.md).

**`event announced affecting your network`** — `world_event` is the flight
transition queue (§21), not §18's announced world events. There is no
announcement model, so there is nothing to be affected by. Inventing one would
put a fabricated headline in a feed whose entire value is that it describes what
actually happened.

**The crew shortfall is not per base.** M5-01's demand is a legal complement per
`(family, rank)` summed over the whole fleet, so there is no per-base requirement
to be short of; the alert names the family and rank, which is what a player hires
against. The _5 days_ is the **fleet's** horizon rather than the roster's: what
makes a shortfall forecastable in this game is an aeroplane arriving, because it
raises the complement on the day it lands and both hiring and conversion take
longer than that. A rostering forecast would need duty and rest projected forward,
which §9.2 defers and M5-01 explicitly does not build. See
[`crew.md`](crew.md).

**No push, no email, no notification.** The digest is delivered when the client
asks for it, which is on the alerts page and — as a count — in the status strip on
every screen. §2's check-in session is _"one glance at cash, alerts, and aircraft
airborne"_, and the strip is that glance. Anything that reached a player who was
not in the game would be a new outbound dependency and a new personal-data class,
which is [ADR-0012](adr/0012-tailfin-threat-model.md)'s decision rather than
this milestone's.

---

## The surfaces

| Route                   | Answers                                                                                         |
| ----------------------- | ----------------------------------------------------------------------------------------------- |
| `GET /api/alerts`       | Every open alert for the player's airline, critical first then oldest first, plus `evaluatedAt` |
| `GET /api/digest`       | The window, the activity, and the raised / resolved / open alerts                               |
| `POST /api/digest/read` | Moves the watermark forward to the `throughAt` the client was shown                             |

`/alerts` in the client carries all three. Every row is a link to the screen that
can act on it, which is M8-13's third criterion; `alerts-ui.test.tsx` fails on any
`AlertScreen` the map does not cover **and** on any path the router does not
serve — the second of which nothing else catches, because the link would render,
the click would navigate, and the player would land nowhere.

Ordering is the server's: critical before warning, then **oldest first** inside a
severity. Oldest rather than newest deliberately — an alert open for three game
weeks is a decision the player keeps not taking, and burying it under this
morning's is how it stays untaken.
