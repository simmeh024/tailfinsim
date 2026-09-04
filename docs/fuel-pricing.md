# Per-station fuel pricing and the world curve (M5-07)

§9.3 in one sentence: _"Fuel is bought per station — into-plane fees vary by airport, prices
vary by region."_ §11 adds the other half: _"Fuel price fluctuates on a world curve."_

Both were **modelled** before M5-07 and neither was **applied**. `computeFuelCost` had always
taken a `FuelStation` with a region factor and an into-plane fee, and a `FuelMarket` with a
world price — but the server handed it `EconomyConfig`'s `fuel.defaultStation` for every
airport on earth, and the world price was the payload's opening level for the life of the
world. So every station quoted the same figure and the curve never moved.

This document covers what a station charges now, how the curve is evaluated, and the two
things that are deliberately not built.

---

## Where the numbers live

Every one of them is in `EconomyConfig.fuel`, versioned in `economy_config` and pinned per
world by `world.economy_config_version`. Retuning fuel is an `INSERT` of a new version plus an
audited re-pin — the admin path that already exists — and no `flight_result` already billed
moves underneath it. `packages/sim` holds no fuel literal; its `DEFAULT_FUEL_*` exports are
slices of the shipped payload, and `balance-source.test.ts`'s argument applies to them.

| field               | what it decides                                               |
| ------------------- | ------------------------------------------------------------- |
| `basePricePerTonne` | the world reference the curve moves around                    |
| `regions`           | six regions' commodity factor and into-plane fee              |
| `tierFeeFactor`     | what the into-plane fee is multiplied by at each airport tier |
| `stationSpread`     | how far one station may sit from its region                   |
| `curve`             | the cycles, and the clamp §20's oil shock will need           |
| `defaultStation`    | the answer for an airport with no recorded geography          |

The three new sections arrive **defaulted**, for the reason CLAUDE.md gives: rows in
`economy_config` are immutable and parsed on the way out against today's schema, so a required
new section would make every payload written before it unparseable — and a world pinned to that
version could then not price a flight, found an airline or draw a fare floor. A `v1` seeded
before this change reads back the shipped regions, tier factors and curve.

That is also why dev and production will report `shippedMatchesStored: false` after this
deploy: their stored `v1` predates the new fields, the build's `v1` carries them, and the web
node seeds insert-if-absent and **never updates**. The stored row stays in force and the
defaults supply the rest, which is the designed behaviour rather than a fault to repair.

---

## A station's price is derived, not stored

There are ~4,400 scheduled-service airports and a region is a pure function of where one is.
So there is no `fuel_station` table, for the same three reasons `ground/station.ts` gives about
vendors: 4,400 rows of duplicated geography to migrate whenever the classification changed, a
world reset (ADR-0005) that would have to remember to leave them alone, and no gain — the
derivation is a hash and two multiplications.

`stationFuelPricing(worldSeed, airport, config)` composes three effects, and they answer three
different questions a player asks about a fuel bill:

1. **the region** — the commodity factor, and the number a shock moves. Read from the
   airport's `iso_country` first and its `continent` second.
2. **the tier** — the into-plane fee. The fee buys a bowser, a driver and a hose, so it scales
   with how hard the station is to fuel: a flagship fuels from a hydrant under the stand at
   0.85×, a regional strip has the product trucked in at 1.6×.
3. **the station spread** — local supply luck, ±4%, drawn from `('fuel', icao)` against the
   world seed. Keyed on nothing else: not on time, not on how many stations were priced
   first. So the same airport is dear in one world and cheap in another and **stays that way
   for the life of the world**, which makes it a fact a player can learn rather than noise on
   a quote.

### Why the country is consulted before the continent

Because the continent is materially wrong twice. OurAirports puts the Gulf in `AS`, where
Dubai would price like Singapore rather than like the well it sits on; and it puts Mexico and
the whole Caribbean in `NA`, where they would price like Houston rather than like the importers
they are. Those two groups are the entire override list, written out in `fuel-price.ts` because
it is a judgement rather than a dataset. US Caribbean territories are deliberately **absent**
from it — Puerto Rico is fed from the US Gulf Coast on US terms, so the continent is right
about them.

An airport whose geography the source data does not record classifies as **no region at all**,
and the caller falls back to `fuel.defaultStation`. That is what the field is for; before
M5-07 it was every airport in the world.

---

## The curve is a closed form, not a walk

`worldFuelPrice` sums sinusoids over days since the world's `epoch`:

```
level(t) = base × clamp( 1 + Σᵢ amplitudeᵢ · sin(2π · (t / periodᵢ + phaseᵢ)) )
```

The phases come from the world seed, so two worlds founded on the same day do not move in
lockstep — and because a phase is a property of the _world_ rather than of the moment, the same
world always reproduces the same curve.

**A random walk was the obvious alternative and is the wrong one.** A walk makes the price at a
given in-game instant depend on how many times anything had asked for it. A `flight_result`
from October could then never be re-derived, and two workers pricing the same arrival could
disagree about what the fuel cost. A closed form is a pure function of the instant, which is
what CONTRIBUTING invariant 2 and M13-01's replay harness need.

Two cycles ship: a five-year commodity cycle at ±18% and a one-year seasonal one at ±6%. They
sum to ±24%, which puts the level between roughly $760/t and $1,240/t around the $1,000/t
reference — historically unremarkable for Jet A-1. The clamp is wider on purpose, at 0.65–1.45:
§20 puts an oil shock on the events table, and when it lands it needs somewhere above the cycle
envelope to push the level to. Nothing writes to the clamp yet.

### This one needs no worker

Almost every mechanic in M4 and M5 is a worker sweep, and CLAUDE.md records the trap that
follows: production has no worker, so the mechanic silently does nothing there and the page
reads as broken. **Fuel pricing is not one of them.** The curve is a pure function of a game
instant, evaluated on read — so it moves on a production world exactly as it does on dev, with
no tick, no queue and no counter. There is nothing here to be missing.

The clock it runs on is the world's **game** clock, like a contract term or a maintenance
interval, so a world at 4× walks the curve four times as fast in real time as one at 1×. The
price is a fact about the world's history, not about how long the server has been up. (M8-02's
FX rates are the deliberate opposite — a real-world quantity on the real clock — and that is
the one place in the economy where the distinction goes the other way.)

---

## What reads a station price

| caller                 | instant                    | why                                              |
| ---------------------- | -------------------------- | ------------------------------------------------ |
| `flight/settle.ts`     | the flight's **departure** | the fuel was bought at the origin before it left |
| `network/economics.ts` | now, in world time         | §14 decision support; a floor is meant to move   |
| `npc/market.ts`        | now, in world time         | the same costing a player gets — see below       |

Settlement reads `actual_departure ?? scheduled_departure`, both stored game-time columns, so a
replay bills the same fuel. It does **not** read the arrival it is settling: the aeroplane paid
for its fuel before it left, and on a long sector the two instants are different points on the
curve.

### The NPC costing moved with it

M3-12's fourth acceptance criterion is _"NPCs never receive resources or modifiers unavailable
to players"_, and it is structural rather than asserted: there is no NPC cost table, because
`npc/market.ts` calls the same `routeVariableCostPerSeatMinor` and `fareFloor` the route editor
does.

Per-station pricing is where that earned its keep. Making a player's fare floor depend on the
origin while leaving the NPC screening model on one reference station would have had NPCs
choosing markets against a fuel price no player pays. So `createCostModel` takes a station
resolver and keys its cache on `(distance, origin)` rather than on distance alone — keying on
distance alone after this change would have quietly given every NPC in the world the same
station, cheap or dear.

---

## What is not built

**Tankering.** §9.3 files it as _"a great advanced mechanic"_ rather than MVP, and the issue
puts it out of scope explicitly. Uplifting cheap fuel to avoid dear fuel trades price against
the burn cost of the extra weight, so it needs the payload/range model as well as this one. The
hook it will use is `stationPricePerTonne` evaluated at both ends of a sector, which is now a
question with two different answers.

**The oil shock.** §20's event has the clamp headroom waiting for it and nothing writes to it.
When it lands it moves `basePricePerTonne` — one number, reaching the whole map at once, which
is the reason stations scale a world price instead of holding their own. The regional ordering
survives the move, which is what keeps tankering a live decision during a shock rather than a
solved one.

**Hedging.** Post-MVP by §11's own note, and a finance-layer concern (§13): it changes the
price the airline _pays_, not the price the station _charges_.

**A supplier contract.** §9.3's `fuelling` service line already exists as a ground handling
contract, and a volume discount negotiated against it would arrive as a deduction from what the
station charges. Deliberately not folded into the station's rates: a player has to be able to
see what the airport charges before seeing what they managed to knock off it.
