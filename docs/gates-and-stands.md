# Gates and stands

How an airline gets somewhere to park, what it costs, and what happens when it stops using it.
M7-06, App. B.6. The decisions behind it are [ADR-0029](adr/0029-gates-and-stands.md); this is
the mechanism.

**A slot is not a gate.** App. B.8 sets them side by side and the difference is the point: a slot
is permission to _move_ at a time, a stand is somewhere to _park_. You need both to fly a
schedule. [`docs/adr/0025-airport-slots.md`](adr/0025-airport-slots.md) owns the other one.

|                | Slot                       | Stand                                 |
| -------------- | -------------------------- | ------------------------------------- |
| Exists at      | IATA Level 3 airports only | **every** airport                     |
| Held per       | hourly band, 0–23          | labelled position — `A7`, `R3`, `P12` |
| Costs          | nothing                    | an annual lease, **billed monthly**   |
| Lost by        | nothing yet (→ SEASON)     | the **utilisation floor**             |
| Blocks a rival | no                         | yes, under an exclusive lease         |
| Needs a worker | no                         | **yes** — see below                   |

---

## The five stands

App. B.6's table, with what each one actually does in the game.

| Stand                 | Label | Cost vs a contact gate | Turnaround                      |
| --------------------- | ----- | ---------------------- | ------------------------------- |
| **Contact gate**      | `A1`… | 1 (the quoted price)   | baseline                        |
| **Remote stand**      | `R1`… | 0.35                   | **+11 min** — passengers bussed |
| **Overnight parking** | `P1`… | 0.122                  | n/a — nobody is aboard          |
| **Cargo stand**       | `C1`… | 0.6                    | §12's process, not a turn       |
| **Maintenance stand** | `M1`… | 0.5                    | n/a                             |

Only the first two are turnarounds and only they change how long one takes. The `+11 min` is the
midpoint of the appendix's "+10–12 minutes"; it has been in `computeTurnaround` since M2-04 and
M7-06 is the first thing that ever triggers it.

**The apron is computed from the airport's tier**, not stored — a flagship has 48 contact gates
and a 20-stand remote apron, a regional field has 2 and 3. Contact gates are lettered by pier in
twelves (`A1`–`A12`, then `B1`), because that is how an airport numbers them and because App.
B.7's map draws piers.

## The three contracts

| Contract         | What you pay        | What you get                                    |
| ---------------- | ------------------- | ----------------------------------------------- |
| **Common use**   | per turn            | nothing reserved — first come, bumpable at peak |
| **Preferential** | annual lease        | priority; the stand is yours when you want it   |
| **Exclusive**    | annual lease, ~2.5× | **nobody else can hold the stand at all**       |

An exclusive lease buys **no operational advantage whatever** — the same aeroplane parks on the
same stand and turns in the same time. The 1.5× premium over preferential buys exactly one thing:
that a rival cannot have it. That is App. B.6's _"where the shared-world conflict lives"_, and if
a player reads exclusivity as a better gate rather than as a denial, the price is what should tell
them otherwise.

**Common use writes no row.** It is not a lease and the database refuses one; the fee is charged
at the flight that caused it, as a `stand` line on the settlement.

### Being bumped

App. B.6 says a common-use stand can be bumped at peak. Fighting over a named gate needs the gate
allocator App. B.7 files under post-MVP, so what is modelled is the consequence a player feels:

1. **a contact gate you lease** → baseline turn, no per-turn fee;
2. **a remote stand you lease** → +11 minutes, no per-turn fee;
3. **a spare unleased contact gate** → baseline turn, walk-up fee;
4. **nothing spare** → a remote stand, walk-up fee.

Step 3 is why a quiet regional field does not suddenly cost everybody eleven minutes a turn. Step
4 is why an **exclusive lease bites on a rival who never opens the gates page**: every exclusive
lease shrinks the spare pool, and when it empties, everyone without a lease starts turning eleven
minutes slower.

## How many stands do you need?

```
ContactGates = min( ceil( P95(concurrent aircraft in turnaround) × 1.2 ), peak )
```

The first half is App. B.6's. **P95 rather than the peak**, because a hub sized to its single
busiest minute buys a gate for a once-a-week overlap. **×1.2**, because gates are not
interchangeable at the moment you need one and schedules slip.

The cap is ours, and it is why App. B.6's worked example works: one aircraft with one aircraft ever
on the ground has a P95 of 1, `ceil(1 × 1.2)` is 2, and the appendix's table says **1**. The buffer
buys headroom out of the gap between P95 and the peak, and never buys a stand no aeroplane could
be on.

The requirement is read off the **next game day** of scheduled flights, not the last one — it is a
decision about what to lease, so it has to look at the schedule you are about to fly.

### What reproduces, and what does not

App. B.6's headline finding reproduces closely:

> _"A banked hub needs roughly five times the gates of a rolling point-to-point operation for the
> same fleet."_

Against the appendix's own simulation parameters — 4 rotations per aircraft, 70-minute sectors,
40-minute hub turns — the model gives **5.3×** at sixteen aircraft and **5.5×** at a hundred and
twenty. A bank puts every aircraft on the ground at once; that _is_ the mechanism, and the formula
counts it.

**The absolute figures in the growth table do not reproduce.** The table is close to 1.4× the
aircraft on the ground in both columns (23 gates for 16 based aircraft banked, 171 for 120), and
`ceil(P95 × 1.2)` cannot reach that — for the banked column nothing can, because concurrency at one
airport is bounded by the aircraft based there. The appendix's own calibration note points the same
way: without towing aircraft to remote stands between waves, it says, the model _"slightly
overstates flagship-hub gate needs"_. `packages/sim/src/route/gates.test.ts` records the divergence
beside the assertion rather than fitting a coefficient to it.

## Utilisation, and losing a stand

App. B.6 reports utilisation **per gate**, not per airline:

> _"Gate utilisation: 3 turns/day · 2.0 h occupied of 17 h → 12%"_

Seventeen hours is a 06:00–23:00 operating day. Measuring against 24 would report the same gate at
8% and would be measuring the airline against hours the airport is shut.

Per-gate needs the turns placed on gates, so the day's intervals are coloured greedily onto the
lowest-numbered free stand. That is **not** a gate allocator — it invents no policy about which
aeroplane deserves which gate, and uses exactly as many stands as the peak concurrency, which is
the fewest any assignment could. What it adds is that **the first gate carries the work and the
last one is visibly idle**, which is the reading a player needs before giving one back.

**The floor is 5%.** Deliberately below the worked example's 12%, because the appendix calls that
12% gate the correct answer for a first hub — _"your gate is nearly idle… and the fix is more
rotations, not more gates"_ — and a floor that withdrew it would punish exactly the player being
taught. A new lease gets **90 game days** before the floor applies at all, because a stand is
leased in order to build a schedule onto it.

Only the two **turn** stands are measured. An overnight position, a cargo stand and a maintenance
stand all report zero against an operating day, and a floor that counted them would withdraw every
one of them on the first sweep.

## What it costs

Every price is `EconomyConfig.gates`, retunable per world like everything else. The appendix
states one absolute figure and describes the rest relatively, so the config does the same: one
price for a **preferentially leased contact gate** per airport tier, and multipliers off it.

| Flagship, preferential | Annual   | Monthly     |
| ---------------------- | -------- | ----------- |
| Contact gate           | $216,000 | **$18,000** |
| Overnight position     | ~$26,350 | **~$2,196** |

Both are App. B.6's worked example, which quotes $18,000 and $2,200. A flagship contact turn on
common use is **$252**, so a lease starts paying at about **71 turns a month** — two and a half a
day. The appendix's first hub flies three a day and is shown holding a lease, which is the right
side of that line and only just. That is what makes a 12% gate a decision rather than an obvious
mistake.

Leases are billed **monthly**, at a twelfth of the annual figure **pinned on the row** — a retune
does not re-price a lease somebody already signed. A new lease gets one grace month, billed only
for a month it was held before that month began.

## Where it runs

**Two worker sweeps, and production has no worker.**

| Sweep                | Counter                           | What it does                       |
| -------------------- | --------------------------------- | ---------------------------------- |
| `billGateLeases`     | `gateFeesBilled`, `gateFeesMinor` | a month of every lease held        |
| `withdrawIdleStands` | `gateLeasesWithdrawn`             | takes back a stand below the floor |
| both                 | `gateErrors`                      | either one failing                 |

Without a worker, a lease is **signed once and then held free and for ever**: no monthly fee, no
floor, and an exclusive lease over every gate at a flagship is a costless permanent blockade of
every rival. That reads as **generous balance** rather than as a missing process — worse than the
usual version of this trap, because the airline it is generous to is the one denying a resource to
everybody else. `gateFeesBilled` rising with `gateLeasesWithdrawn` at zero is the healthy reading:
leases billed, everybody using what they hold.

The **requirement** has the same shape from the other side. It is read off `flight` rows, which
only the worker produces, so on a production world it reports zero — and `sampledGameDate` is null
rather than a date, which is what lets the page say _"nothing is scheduled through here"_ instead
of _"you need no gates"_.

The rest — leasing, releasing, prices, who holds what, exclusivity — is HTTP and works on every
node.

## The API

| Route                                        | What                                            |
| -------------------------------------------- | ----------------------------------------------- |
| `GET /api/airports/:icao/gates`              | the apron, who holds what, your use, your needs |
| `POST /api/airports/:icao/gates`             | take a stand, echoing the quoted fee back       |
| `DELETE /api/airports/:icao/gates/:position` | give one back — idempotent, no penalty          |

Who holds what is a **deliberate public projection**, for the reason a slot holding is one and one
degree stronger: an exclusive lease denies the stand to everybody else, and a denial nobody can
attribute reads like a bug. What a rival's lease cost, and how busy their stands are, is not
disclosed. The authorization matrix carries the rows.

Refusals: `409 exclusively_held` (a rival's exclusive lease is in the way), `409 contested` (you
want it exclusively and somebody is already on it), `409 fee_changed` (the quote moved),
`422 not_leasable` (common use is paid per turn), `404` for an airport or a stand that does not
exist.

## What M7-06 deliberately did not build

- **The airport map.** App. B.7's 2D schematic with liveries on stand and a utilisation heat
  overlay is M7-07. The API it needs — the whole apron, per position, with holders — is what this
  milestone returns.
- **Gate assignment.** App. B.7 files _"gate assignment as an optimisation puzzle"_ under
  post-MVP, and the greedy colouring here is a measurement device, not a policy.
- **Subleasing to other players.** App. B.8's trading row, deferred to MARKET with slot trading.
- **Towing between waves.** The appendix's own calibration note suggests it as the thing that
  would stop the model overstating flagship-hub gate needs. It trades cheap tugs for expensive
  contact gates and is a real mechanic; it is not this one.
- **§14.5's gate-lease alert.** `alerts-and-digest.md` records that _"nothing leases a gate"_ was
  why §9.3's contract-lapse warning stood in its place. That is no longer true and the alert is
  now buildable; it is deliberately not here.
