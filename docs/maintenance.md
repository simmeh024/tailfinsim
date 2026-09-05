# Maintenance (M4-06)

§7.3's two bullets, made real: hours and cycles accumulate, A/C/D checks fall due,
deferring one degrades the aeroplane, and deferring it far enough grounds it.

§24 lists maintenance as **MVP-blocking** with _"§7.3 is two bullets"_ against it, so almost
every number here is authored rather than quoted. All of them live in
`EconomyConfig.maintenance`, which means a retune is an `INSERT` and a deliberate re-pin, and
no airframe already flying changes underneath its owner. `packages/sim` holds none of them.

---

## Two intervals, whichever comes first

Every tier has an hour limit **and** a cycle limit, and the closer one decides. This is the
single decision that makes types feel different to own:

|                                               | reaches its limit by                       |
| --------------------------------------------- | ------------------------------------------ |
| Regional turboprop, eight short sectors a day | **cycles** — 400 landings before 500 hours |
| ULH widebody, one long sector a day           | **hours** — 900 hours before 400 landings  |

One interval would have made every aeroplane the same shape of problem, and would have wasted
the cycle counts the used market already generates. The API reports which limit is `binding`,
because _"210 cycles from an A-check"_ is a plan and _"an A-check soonish"_ is not.

A heavier check subsumes the lighter ones — a D covers the C and A work. Without that, a
player would emerge from a five-week D-check with an A-check immediately due, which is wrong
about aeroplanes and would read as a bug.

---

## Deferring a check

§7.3's second bullet is a chain: _"skipped maintenance → reliability decay → delays and
cancellations → reputation damage."_ The first link is a number M2-08 reserved for exactly
this — `DisruptionRisk.technical`, documented there as _"the inverse of condition … M4-06 owns
what moves it."_ Nothing else in the codebase writes that field.

```
technicalRisk = baseline + Σ (overdueRisk[tier] × ramp(hours past due))    capped
```

**Ramped, not stepped.** A step would make a deferred check either free or catastrophic with
nothing in between; the acceptance criterion asks for a rise a player can _measure over a few
game weeks_, and a ramp is what makes the degradation observable and worth reacting to. The
shipped ramp is 300 block hours — about six weeks for a narrowbody at eight hours a day, so
it is visibly worse within two or three.

**Tiers add rather than max**, because deferring all three is genuinely worse than deferring
the D alone.

The cap is `0.3`, and it binds. The first value was `0.35`, which was above the sum of the
baseline and all three penalties (`0.304`) and could therefore never be reached — dead
configuration dressed as a safety limit. A test now asserts the ceiling is reachable, so it
cannot quietly become decoration again after a retune.

### The gap this leaves, stated plainly

`technicalRisk` is computed, stored and exposed. **It does not yet cause a delay**, because
`rollDisruption` is not called anywhere on the server — M2-08 built the pure model and nothing
wires it into the flight lifecycle. Disruption would naturally roll at departure, and
`FLIGHT_DEPART` has no handler (CLAUDE.md says so).

So the honest reading of the first acceptance criterion today is: **deferring a check
measurably raises the technical risk the flight path will consume when it is wired**, proved
by test over four game weeks of flying. Making it raise the observed disruption _rate_ needs
`FLIGHT_DEPART` handled, which is a separate piece of work and not this milestone's.

---

## Grounding, and what it deliberately is not

Fly past `groundingOverdueMultiple` — 1.5 — times a check's interval and the aeroplane stops.
It cannot be scheduled, and an attempt surfaces as a conflict.

**That is the only grounding here.** Real AOG is mostly unscheduled: a failed part, a bird
strike. §24 lists _"Safety, incidents & insurance"_ as its own unaddressed area with no
incident definition, severity ladder or investigation, so inventing one would be answering
that milestone's question. What M4-06 grounds is an aeroplane whose owner deferred maintenance
past the limit — a decision the player made, and one they can reverse.

**A grounded airframe can still be booked into a check.** That is the point: grounding is a
state you clear by doing the work, not a dead end. Refusing the booking would leave a player
with an aeroplane they could neither fly nor fix.

The philosophy is §7.2b's, applied to maintenance: _"your beloved fleet becomes uneconomic
before it becomes illegal."_ Risk rises long before anything stops.

### And again at departure, because authoring is not the last word (IMPROVE-03)

`createSchedule` can only ask whether the aeroplane can fly **now**. A flight departs later,
and between the two the sweep can ground the airframe or the player can book it into a check.
Nothing enforced that until IMPROVE-03: the queued `FLIGHT_DEPART` released the flight, opened
a crew duty period and scheduled an arrival, in an aircraft that was in a hangar.

`departFlight` now reads the airframe under `FOR UPDATE` before anything is committed —
`lockDispatchAvailability`. The lock is the load-bearing part: `bookCheck` takes the same one
before it writes a status, so a booking racing a dispatch waits for it rather than
interleaving with it. Without the lock the departure reads `in_service`, the booking commits
`in_check`, and the flight leaves anyway.

Two outcomes, because the two states say different things about the future:

| Aircraft state                                       | Outcome                                           | Why                                                                                                                                               |
| ---------------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `in_check`, ending at a known instant, first attempt | **Delayed** to `check_completes_at`, retry queued | A check ends. Cancelling a flight over a scheduled check that finishes in an hour would be worse than holding it.                                 |
| `grounded`                                           | **Cancelled**                                     | A grounding has no end date — it clears when the player books the work. Delaying to an instant that does not exist is how a flight gets stranded. |
| Still unavailable on the retry                       | **Cancelled**                                     | See below.                                                                                                                                        |

Both record `disruption_cause = 'technical'` and raise a `disruption_review` operations task
whose detail names the state and, for a hold, the instant it waits for. The player reads it in
the same task list the automation ladder writes to; no new vocabulary was invented for it.

**The retry cancels rather than delaying again, and that is deliberate.** `scheduleEvent` is
idempotent by key and the retry key is the instant, so a second delay to the same
`check_completes_at` would queue _nothing_ — leaving the flight `delayed` for ever with nothing
due to look at it. And **production has no worker** ([OPS-12](https://github.com/simmeh024/tailfinsim/issues/191)),
so a check booked there never completes at all: one hold, then a decision, is the only bounded
shape. A flight is never silently stranded.

**An unknown airframe id is available, not refused.** `flight.airframe_id` has no foreign key
until the M4/HIST boundary (#508) and M2's suites materialise flights against placeholder ids,
so a missing row means _"nothing here says it cannot fly"_ — the same reading
`airframeUnavailability` documents for the scheduler. Turning it into a refusal would enforce
an integrity rule the column does not have.

### Why it is a rotation conflict, and the type split behind it

`createSchedule` refuses with `airframe_unavailable`, in the same channel as
`not_positioned` — because to the player that is exactly what it is: the schedule is unflyable
for a reason about the aircraft.

It is **not** in `RotationProblem`, and a failing test is why. `ROTATION_PROBLEMS` carries a
contract that every value is reachable from `validateRotation`, asserted so a problem cannot be
added without a rule that produces it. Availability is a database row, so the first attempt
broke that contract. `SchedulingProblem = RotationProblem | 'airframe_unavailable'` keeps the
pure contract intact and still gives the player one vocabulary.

---

## Reading a null history

`airframe.maintenance_state` is nullable, and how a null is read is the most consequential
decision in the implementation. It means **"every tier was last completed at the hours this
airframe has now"**, not "last completed at hour zero".

The alternative is not merely wrong, it is destructive. Every airframe delivered before the
migration would read as tens of thousands of hours overdue, and the first worker tick after
the deploy would ground an entire live fleet for maintenance nobody had deferred. A fleet is
not punished for a schema change. There is a database test for exactly this.

A used aircraft is the same problem seen from the other side: a twelve-year-old airframe has
flown 30,000 hours, and `inferredHistory` places each tier somewhere inside its own interval
so a flying aeroplane reads as one that was being maintained.

---

## Where it runs

|                              |                                                                                                       |
| ---------------------------- | ----------------------------------------------------------------------------------------------------- |
| **Accrual**                  | inside the settlement transaction, on `FLIGHT_ARRIVE`. Money and hours move together or neither does. |
| **Booking**                  | `POST /api/fleet/maintenance/checks` — cash, status and completion time in one transaction.           |
| **Completion and grounding** | the **worker**, once per world per tick, on that world's **game** clock.                              |

A check's downtime is game days, so a world at 4× returns its aeroplanes to service twice as
fast in real time as one at 2×. Factory lead time used to be the one fleet thing measured in
real weeks (§7.2); TIME-01 ([ADR-0026](adr/0026-in-world-spans-are-game-time.md)) put it on the
world's clock as well, so the fleet now has one time domain rather than two.

> **Production has no worker**, so a production world's checks would never complete and
> nothing would ever be grounded. An aeroplane booked into a check there would stay in it for
> ever. Same shape as flight settlement, the NPC review and the used market until OPS-12
> (#191). `checksCompleted`, `airframesGrounded` and `maintenanceErrors` are the counters that
> distinguish _nothing ran_ from _nothing needed to_.

Both sweeps are idempotent by their `WHERE` clause rather than by a lock: a check completes
only from `in_check` with a past completion time, and the update clears both, so a second call
finds nothing. Two workers racing through a handover cannot complete the same check twice.

---

## Deliberate boundaries

- **Facilities and outsourced slots.** The issue mentions both. App. B.5 turns out to be hubs,
  and hangar facilities are named in §24's debt list — so a check costs money and takes time,
  and _where_ it happens is left to whoever specifies hangars.
- **Retrofits** (App. C.3 rule 5) are a fleet action, not a check. M4-03 owns the option rules.
- **Lender repossession** (§13.5) reads maintenance state but is M8's.
- **Unscheduled AOG, incidents, insurance** — §24's own area, untouched.
- **The maintenance readout** now has a home: M4-07's fleet table quotes the next check by the
  limit that binds, and the aircraft detail shows all three tiers with their cost and downtime
  ([`fleet-management.md`](fleet-management.md)). Booking a check from that page is still not
  wired — `POST /api/fleet/maintenance/checks` works, but the fleet views are read-only.
