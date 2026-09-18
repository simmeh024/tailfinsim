# ADR-0029: Gates and stands

- **Status:** Accepted
- **Date:** 2026-09-18
- **Deciders:** @simmeh024
- **Constrains:** M7-06 and everything downstream of it — the airport map (M7-07), stand
  subleasing (→ MARKET), gate assignment as an optimisation problem (post-MVP), and any NPC
  stand consumption
- **Sits beside:** [ADR-0025](0025-airport-slots.md), which decides the same questions for the
  other scarce airport resource. Read them together: App. B.8 exists to say they are different.

## Context

App. B.6 is the second half of App. B.8's pair. A slot is permission to _move_ at a time; a gate
is somewhere to _park_. ADR-0025 made the first real. The second was entirely absent: nothing
leased a stand, `computeTurnaround` had taken a `stand: 'contact' | 'remote'` parameter since
M2-04 with every caller passing `'contact'`, and `settlement.ts` listed `gate` among the period
costs it deliberately does not charge — accurately, because there was nothing to charge.

The appendix asks for four things: five **stand types**, three **contract types**, a
**requirement calculation**, and a **utilisation floor** to counter gate hoarding. It also gives
the mechanic its purpose in one sentence — _"a banked hub needs roughly five times the gates of a
rolling point-to-point operation for the same fleet"_ — which is the systems link between §8.2's
two grand strategies and something a player pays for.

## Decision

### 1. A stand is held per position, not per count

A `gate_holding` row is one airline's lease on one **labelled stand** at one airport: `A7`, `R3`,
`P12`. Not a count of gates held, which would have been simpler and is wrong for the reason App.
B.7 gives — the airport map draws piers and lets a player see whose aeroplanes are on which one,
and _"you can see exactly who holds what, which makes gate competition legible and personal"_
needs a stand to be a thing rather than a quantity. Exclusivity needs it too: denying _a stand_
to a rival is only meaningful if the stand has an identity.

This is the one place this ADR departs from ADR-0025's shape. A slot is held per band because a
band is when; a stand is held per position because a stand is where.

### 2. The apron is computed from the airport's tier, not stored

`standInventory(tier)` derives how many of each stand an airport has and what they are called.
Same call ADR-0025 makes about per-band capacity, same reasons: it prices nothing, so it is not
an `EconomyConfig` coefficient; and a hundred thousand rows of stand reference data would be a
dataset nobody could ever check, for airports most worlds never touch.

The consequence to accept: **an airport's apron changes if `data:classify` re-tiers it.** A lease
addresses a stand by label, so a stand that stops existing is a lease pointing at nothing. This
is tolerable today because reclassification is a manual data job and the failure is a lease the
UI stops listing rather than a broken query — and it is the same trade `airline_hub.tier` names
from the other side. If reference refreshes ever become routine, the inventory becomes rows.

### 3. Common use is not a lease, and the schema says so

App. B.6's common-use column is _"per-turn fee, first come, and you can be bumped at peak"_. It
reserves nothing, so it writes no row: `gate_holding` carries a check constraint refusing
`common_use`, and the walk-up is billed at the flight that caused it. The enum keeps the value
because the **price table** needs all three — the client is shown what a turn costs beside what a
lease costs, which is the comparison the contract table exists to provoke.

### 4. Exclusivity is enforced in the handler, with a partial index behind it

Two rules, and only one of them is an index. `gate_holding_one_exclusive_per_stand_idx` is
partial on `contract = 'exclusive'` and stops two exclusive leases racing onto one stand. The
wider rule — an exclusive lease over a stand somebody already holds, or a preferential lease over
one somebody holds exclusively — is a statement about two different rows and lives in
`leaseStand`, inside the transaction that writes.

The partial index is deliberately one `ON CONFLICT` cannot infer from target columns alone, which
is why the lease selects and inserts rather than upserting. That trap is in CLAUDE.md and cost a
session once.

### 5. Being "bumped" is modelled as the stand you get, not as a fight over a gate

App. B.6 says a common-use stand can be bumped at peak. Bumping a named aeroplane off a named
stand needs the gate allocator App. B.7 files under post-MVP, and inventing one here would be the
accidental decision ADR-0019's boundary exists to prevent. So `resolveStands` answers the
question a turn actually asks:

1. a contact gate you lease → baseline turn, no fee;
2. a remote stand you lease → App. B.6's +10–12 minutes, no fee;
3. a spare unleased contact gate → baseline turn, walk-up fee;
4. nothing spare → a remote stand, walk-up fee.

Step 3 is what keeps a quiet regional field from suddenly costing every airline eleven minutes a
turn, and step 4 is what makes an exclusive lease bite on a rival who never opens the gates page:
every exclusive lease shrinks the spare pool, and when it empties everyone without a lease starts
turning eleven minutes slower.

This is the first thing that ever set `computeTurnaround`'s `stand` parameter to anything but
`'contact'`.

### 6. The requirement is the doc's formula, capped at the peak

```
ContactGates = min( ceil( P95(concurrent aircraft in turnaround) × 1.2 ), peak )
```

The first half is transcribed from App. B.6. The cap is this ADR's, and it exists because the
appendix's own worked example contradicts its own formula: one aircraft with one aircraft ever on
the ground has a P95 of 1, `ceil(1 × 1.2)` is 2, and the table says **1**. A second gate at a
station that never has two aeroplanes on it at once is not headroom, it is a bill. So the buffer
buys headroom out of the gap between P95 and the peak and never past it.

**The absolute figures in the growth table do not reproduce, and are not fitted to.** The table is
close to 1.4× the aircraft on the ground in both columns — 23 gates for 16 based aircraft banked,
171 for 120 — and for the banked column nothing can produce that: concurrency at one airport is
bounded by the aircraft based there. The headline finding does reproduce, at 5.3× for sixteen
aircraft and 5.5× for a hundred and twenty, and that is the finding the mechanic rests on.
`route/gates.test.ts` records both and it is reported on the issue.

### 7. A lease is billed monthly and lost to a utilisation floor — so this has a worker

Unlike a slot holding, which is standing state and works identically on a world with no worker, a
lease is **money** and **use it or lose it**. Both are worker sweeps on the world's game clock,
and the consequence is stated at length in `network/gate-upkeep.ts`: production has no worker, so
there a lease is free and permanent, and an exclusive lease over every gate at a flagship is a
costless blockade. Every other missing-worker symptom reads as broken; this one reads as generous
balance to the one airline denying a resource to everybody else.

The floor is **5%**, below App. B.6's own worked example at 12%, because the appendix calls that
12% gate _"the correct one"_ and a floor that withdrew it would punish exactly the player the
example is teaching. It applies only to the two **turn** stands: an overnight position, a cargo
stand and a maintenance stand all report zero against a 06:00–23:00 operating day, and a floor
that counted them would withdraw every one on the first sweep.

Neither sweep needs a watermark. The bill is idempotent by AIR-06 reference; the floor is a pure
function of current state. ADR-0005 would require a "last reviewed" column to be reset on a world
reset, and forgetting would leave a fresh world believing it had already reviewed.

### 8. Stand holdings are a public projection, with the same limits as slots

`GET /api/airports/:icao/gates` names every airline holding a stand, with its contract. The
reasoning is ADR-0025's amendment and one degree stronger: an exclusive lease **denies** the
stand to everybody else, and a denial nobody can attribute is indistinguishable from a bug.

What is **not** disclosed: what a rival's lease cost, and how busy their stands are. The
`utilisation` block is null on every stand but the caller's own, because how busy an airline's
gates are is a commercial fact about its schedule. The authorization matrix carries the rows.

## Consequences

- `computeTurnaround`'s stand parameter is live. An airline with no lease at a station where every
  contact gate is leased turns eleven minutes slower there, visible the next time it saves a
  rotation. At a quiet airport with spare gates nothing changes — which is most airports and every
  new world.
- `settlement.ts` gains a `stand` cost source. Its module note said `gate` was absent because it
  is a period cost; that stays true of a lease, and a walk-up turn is the case that note asks for —
  a cost somebody decided the flight causes.
- `gate_lease` is a new `cash_movement_cause` and a new `ledger_category`, deliberately not
  folded into `airport_slot`: App. B.8's point is that the two are different purchases, and an
  airline reading one line for both could not tell which its money went on.
- §14.5's gate-lease alert is now possible. `alerts-and-digest.md` records that _"nothing leases a
  gate"_ was why §9.3's contract-lapse warning stood in its place; that is no longer true, and
  wiring the alert is deliberately not this milestone's work.
- Stand **subleasing** stays with MARKET, and gate **assignment** stays post-MVP, exactly as App.
  B.7 files them.
