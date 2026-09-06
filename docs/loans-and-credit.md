# Loans and credit

What an airline may borrow, at what price, and why an airline in trouble may not.
Design doc **§13**; built by **M8-06**.

---

## The rule

> **Loans support, they never carry.**

A loan should let a profitable airline move faster. It must never let an
unprofitable airline keep existing. §13.1 makes that mechanical:

```
MaxTotalDebt = min( tierCap,
                    3.0 × trailing 12-month operating profit,
                    0.60 × tangible asset value )

DSCR = trailing EBITDA / annual debt service     must be >= 1.25 to borrow more
```

> If you're losing money, `3.0 × operating profit` is zero or negative. **You
> cannot borrow at all.** No special-case rule needed — the formula does it.

**There is no "is this airline in trouble?" check anywhere in this subsystem, and
there must not be one.** A second place the rule lived would eventually disagree
with the first about an airline sitting exactly on the line.

---

## The tiers

| Tier        | Cap   | Rate | Term   | Asks for                              |
| ----------- | ----- | ---- | ------ | ------------------------------------- |
| **Startup** | $250K | 14%  | 12 mo  | nothing — the founder facility        |
| **D**       | $1M   | 12%  | 24 mo  | 3 profitable months                   |
| **C**       | $5M   | 10%  | 36 mo  | 6 profitable months, 4+ routes        |
| **B**       | $25M  | 8%   | 60 mo  | 12 months, 2+ hubs, stable margin     |
| **A**       | $100M | 6%   | 84 mo  | sustained margin, diverse network     |
| **AA**      | $500M | 4.5% | 120 mo | major carrier, fortress balance sheet |

The first four rows' requirements come from §13.2's prose. **A and AA's do not** —
the doc gives no numbers there, so the margins and network sizes are invented to
continue the curve, and are the first thing a balance pass should revisit. They
gate two tiers no early airline can reach anyway.

Every tier asks for **all** of its requirements, because §13.2 states them as a
conjunction ("6 profitable months, **4+ routes**").

### The founder facility is a start, not a refuge

`startup` is where every airline begins, exempt from the profit test, capped
small and priced highest in the table. Two rules keep the exemption honest:

1. **The cap still binds.** A brand-new airline may draw $250K and nothing more.
2. **A rating that has left `startup` can never return to it.** Its floor is `D`,
   whose capacity is subject to the profit test like every earned tier.

The second was **caught by a database test**. On a naive fall-to-earned rule, an
airline that traded up to C and then began losing money landed back on `startup`
and found $250K of profit-exempt credit waiting for it — exactly the airline
§13.1 exists to stop borrowing. A loss-making airline now holds a rating and no
capacity at all.

### Ratings fall faster than they rise

> One bad quarter costs a tier; recovering it takes two good ones.

A fall is **immediate and all the way** to the earned tier (floored at `D`); a
rise waits for two consecutive reviews that earn it and then climbs **one rung**.
The streak resets on a fall, so an airline that oscillates never accumulates the
credit for a rise — which is the "revenue stability" §13.2 lists among the
rating's inputs, arriving as a consequence rather than as another term.

---

## The instruments

| Instrument           | Secured on         | Rate         |
| -------------------- | ------------------ | ------------ |
| Working capital line | nothing            | tier **+3%** |
| Aircraft finance     | the airframe       | tier **−2%** |
| Facility loan        | hub, gates, hangar | tier rate    |

Five points between the dearest and the cheapest, which is the whole reason to
secure. Aircraft finance must name the airframe it is written against, and one
that is not the airline's is **concealed as a 404** like every other private id.

### Sale-leaseback is in §13.3's table and is not built

It is not a loan: an owned aeroplane is sold and leased back, raising cash
without creating debt — which is why §13.3 calls it _"the classic desperation
move"_ and why it would still be open to an airline whose capacity is zero.

Building it needs the fleet to carry a **lease obligation on an airframe**, and
today it cannot: a lease rate lives on the `aircraft_order` a leased airframe was
delivered from, so converting an owned one means either a synthetic order row or
a new column on `airframe`. That is a decision about how the fleet holds leases,
and taking it inside a credit issue would be deciding it in the wrong place.

---

## Where each thing lives

|                                                    | Where                                   |
| -------------------------------------------------- | --------------------------------------- |
| Tiers, instruments, what each is secured on        | `packages/shared/src/credit.ts`         |
| Every cap, rate, term, the 3.0, the 0.60, the 1.25 | `EconomyConfig.credit`                  |
| The arithmetic and the hysteresis                  | `packages/sim/src/finance/credit.ts`    |
| Reading trading, writing the loan                  | `packages/server/src/finance/credit.ts` |

---

## Operational notes

**This is not a worker story.** §13.2's hysteresis needs history, so
`credit_standing` persists the tier and the streak — but what moves it is a
**review**, and a review happens at most once per game month, driven by whoever
reads the standing. Deliberately not a sweep: production has no worker, and a
credit rating that froze there would make the whole lending system behave
differently between nodes. Read-driven, it behaves identically everywhere.

The cost is that a rating only moves when somebody looks, which is acceptable
because nothing but a human _asking to borrow_ depends on it — and that act is
itself a look. It also means a player cannot rush a rise by reloading: a second
read inside the same game month performs no review.

**A drawn loan is neither revenue nor cost.** `debt_draw` is the one ledger
category `readProfitAndLoss` counts in **neither** total. Classifying a draw as a
cost would show a profitable airline a month of enormous losses for having
borrowed; as revenue, the opposite. What borrowing _costs_ is the interest that
follows — `interest`, and M8-07's.

**`loan.drawn_at` is game time**, like every in-world instant since ADR-0026: a
twelve-month term is twelve months of the world, and a world at 4× reaches
maturity in a quarter of the real time.

**`loan.secured_airframe_id` carries no foreign key**, on purpose. An airframe
can leave the fleet, and a loan is a financial record that must outlive the asset
it was written against.

---

## What M8-06 did not build

- **Interest accrual and the default ladder** — §13.4's per-day drain and
  §13.5's warning → restriction → disposal → repossession → administration
  sequence are **M8-07**. Today a loan is drawn and then sits: nothing accrues,
  nothing amortises, and `outstanding_minor` equals the principal for ever.
- **Sale-leaseback**, as above.
- **Bond issues** — the issue puts them out of scope; post-MVP, AA only.
- **A web surface.** The API is complete; no page consumes it yet.
