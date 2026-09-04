# The used aircraft market (M4-05)

App. C.5's mechanism, made real: a rolling second-hand inventory per world, priced by age,
hours and — the part the options system exists for — **whose aircraft it used to be**.

Purchase is [M4-04's](aircraft-acquisition.md), and unchanged. This document covers where the
listings come from, what decides their price, and the one operational fact that is invisible
in the diff.

---

## The design document gives principles, not numbers

C.5 is four sentences. A common configuration sells fast at a good price; an unusual one is
cheap to buy and hard to sell; buying used means buying someone else's decisions; and this is
what _"makes every airframe an individual object with a history, rather than an
interchangeable unit of capacity."_

§24 then lists **"used-aircraft supply and depreciation model"** under _needed before launch,
not before MVP_. There is no curve to quote, so every coefficient here is authored. All of
them live in `EconomyConfig.usedMarket`, which means retuning the market is an `INSERT` and a
deliberate re-pin, not a code change, and no listing a world has already priced moves
underneath it. `packages/sim` holds none of the numbers.

---

## The market is berths, not a list

`slots` berths — 24 in the shipped balance — each holding at most one available listing. The
shape is chosen to make the issue's second acceptance criterion a property rather than a
hope:

|                   |                                                                           |
| ----------------- | ------------------------------------------------------------------------- |
| **not infinite**  | a berth holds one aircraft, and there are `slots` of them                 |
| **not exhausted** | generations keep arriving, and an empty berth is refilled at the next one |

A **generation** is `floor(game days since epoch / refreshIntervalDays)` — a game week by
default. It is derived from the world clock and never stored, the same reasoning `reviewDue`
gives for the NPC review: a stored column would have to be reset when a world resets
(ADR-0005), and forgetting that would leave a freshly reset world believing its market was
already full.

Each refresh withdraws expired listings first, then fills every berth that has no available
aircraft. Two consequences are deliberate:

- **A berth freed by an expiry is refilled in the same call**, so the market is never briefly
  short.
- **A berth freed by a _sale_ stays empty until the next generation.** The insert conflicts
  with the sold row and does nothing. Buying an aeroplane does not conjure its replacement,
  which is both more plausible and a real reason to watch the market.

### Idempotency is the database's, not the caller's

The engine ticks every second; a generation lasts a game week. The refresh is therefore
called tens of thousands of times per generation and must do nothing on almost all of them.

It is not made safe by a remembered timestamp or a lock. Every insert carries
`(world_id, slot_index, generation_index)`, which is **unique**, and lands with
`ON CONFLICT DO NOTHING`. Two workers racing during a rolling handover produce one row and
neither has to know about the other — the same disposition `airframe.source_order_id` already
uses for deliveries.

---

## What decides the price

```
asking = anchor × ageFactor × utilisationFactor × configurationFactor
```

Exactly that product, rounded once. Nothing is clamped on top, so the four numbers a player
is shown are the four numbers that were multiplied — which is invariant 4 applied to the most
obvious place for it to fail. The decomposition is **stored on the row**, not recomputed on
read: the economy config can be re-pinned, and a read path that recomputed would eventually
explain an old listing with today's coefficients and disagree with the price beside it.

**anchor** — what one of these cost new. The type's list price, or, for a type out of
production whose list price the catalogue prints as _"—"_, its lease rate capitalised at
`leaseCapitalisationMonths`. Three v1 types need that path: the 737-800, the A380-800 and the
747-8F. `125` recovers their authored notional prices exactly, because the catalogue's
`leaseFor` helper is 0.8% of list per month. It is a fallback and not a general law — the ATR
72-600's rate is App. B.4's authored $85k rather than a percentage, and inverting _that_ would
be wrong; it has a list price, so the fallback never runs for it.

**ageFactor** — `floor + (1 − floor) × retention ** age`. A salvage residual, **not a clamp**,
and the distinction was worth a bug. `max(floor, retention ** age)` goes flat past the age
where the curve crosses the floor, so everything beyond that age prices identically and hours
and configuration stop mattering — precisely at the cheap, old end of the market where a
bargain is supposed to be found. The acceptance criterion held at eight years and quietly
failed at twenty-four.

**utilisationFactor** — hours measured against what the age already predicted, not absolute
hours. Age and hours are strongly correlated, and an absolute term would charge twice for one
fact. The residual is the new information, and it cuts both ways: a low-time airframe is worth
a bounded premium, exactly as the real market treats one.

**configurationFactor** — `1 − Σ drag`, one drag per fitted option, by category, multiplied by
`nonRetrofittableMultiplier` when C.3 rule 5 means the buyer is stuck with it.

### Why options do not add to the price

The obvious model is `anchor = list + options`, then depreciate. It is wrong here, and
rejecting it is the central decision.

Under that model an unusual airframe can price **above** a plain one of the same age, because
its options cost real money new — which contradicts C.5's _"an unusual one is cheap to buy"_
and would make the acceptance criterion depend on luck in the coefficients. So the anchor is
the **type's** value and configuration only ever multiplies it. The previous owner's invoice
is sunk and the market never sees it. An unusual configuration is cheaper than a common one of
the same age _by construction_, for every type, at every age.

`aerodynamic` drag is **negative**. A wingtip device or an efficiency package makes the
aeroplane better for whoever ends up with it, so the market pays a little more. Without that,
the configurator would be a pure penalty box and C.5's _"a bargain if it fits your network"_
would mean nothing.

### Why the coefficient is on the category, not the option

`aircraft_option` rows are immutable by trigger, for the same reason `aircraft_type` rows are:
an airframe's build is folded into every `flight_result` it ever settled. A column added now
could never be filled in for the v1 options already seeded, and the only repair would be
re-authoring the catalogue as v2.

It belongs in the economy on the merits too. How much the market dislikes a high-density cabin
is a _market_ fact, and M4 owns market pricing (#518 says so explicitly). In the catalogue, a
resale retune would renumber the aerodynamics and a `flight_result` could no longer say which
of the two explained it.

---

## Which aircraft can appear

A type is drawn only if it can have a used example, which is four constraints and every one of
them is somebody else's rule:

- at or after **entry into service** (M4-02) — a type has no used examples before it had any;
- at or before **production end** — that is when the last one was built;
- old enough to have had a previous owner (`minAgeYears`);
- young enough to still be on the market (`maxAgeYears`).

The emergent behaviour is the point. In a 2026 world the A321XLR entered service in November
2024, so no example is two years old and **the type is simply absent** — not listed at zero,
not greyed out. A 1990s world's used market contains 1990s aeroplanes for free, because the
catalogue's own dates say so. A prototype has no used market and a retired type cannot legally
be flown, so neither is drawn.

Class supply weights keep the mix plausible: a uniform draw over C.2's eighteen types would put
as many A380s on the market as A320s.

### Determinism

A listing is identified by `(world seed, slot, generation)` and nothing else. `random.ts` warns
against keying a stream on _when it was asked for_, and this does not — a generation index is
part of a listing's identity, _the aircraft standing in berth 3 in game-week 42_, not the moment
somebody looked. Ask twice, get the same aeroplane; replay the world six months later, get the
same aeroplane; run two workers, get the same aeroplane.

---

## Where it runs, and the fact that is invisible

The refresh is the **Worker's**, called once per tickable world per tick, against that world's
**game** clock — as is the factory delivery sweep beside it since TIME-01
([ADR-0026](adr/0026-in-world-spans-are-game-time.md)). A world at 4× renews its market twice as
often in real time as one at 2×. A listing's `sold_at` is game time too, so it agrees with the
`available_at`, `built_at` and `expires_at` it sits next to.

> **Production has no Worker**, so a production world's used market would never generate,
> never refresh and never expire. The market is a dev-only mechanism until OPS-12 (#191)
> gives production a Worker — exactly as flight settlement and the NPC review already are.
> `GET /api/fleet/used-market` would answer `200` with an empty list, which reads like an
> empty market rather than like a missing process.

The engine's tick report and the Worker's loopback health snapshot both carry
`usedListingsCreated`, `usedListingsWithdrawn` and `usedMarketErrors`, for the same reason the
delivery counters exist: _"nothing has run"_ and _"everything is fine"_ must not look alike.

A refresh that throws is isolated like the NPC review. A market that could not renew this tick
renews the next one; a flight that never settles is money that never moves.

---

## Deliberate boundaries

- **HIST-11 (#518)** owns provenance disclosure — previous operators, maintenance history,
  reliability. It is blocked on this issue and states that _"M4 remains the only
  market/depreciation/price owner"_. The listing contract here stops at the facts the price is
  computed from.
- **HIST-01 (#508)** owns airframe identity and serials. `built_at` travels onto the airframe
  as an inherited build fact on M4-04's existing path; nothing here anticipates that contract.
- **HIST-02 (#509)** owns registration lifecycle. Generated listings carry a `TU-` provisional
  registration, deterministic in the berth and generation, in the same shape M4-04 already uses
  for a new delivery.
- **M4-06** owns maintenance. Cycles are generated here because they are a fact about a used
  airframe; what they _cost_ is not this milestone's.
- **M4-07** built the fleet list and aircraft detail ([`fleet-management.md`](fleet-management.md)).
  The used **market** still has no page: `GET /api/fleet/used-market` remains the contract for
  one, and the asking-price decomposition is what it should render.
- **Player-to-player trading** remains Post-MVP (§7.4, §16).
