# Loans and credit

What an airline may borrow, at what price, why an airline in trouble may not, and
what happens when it stops paying. Design doc **§13**; built by **M8-06** and
**M8-07**.

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

## Interest is a live drain

> Interest accrues **per in-game day** and appears in the daily P&L as its own
> line. It is never hidden in a summary.

One cash movement **per loan per game day**, cause `loan_interest`, category
`interest`. The cheaper design — one movement covering however many days the
sweep has fallen behind — is the one thing §13.4 forbids: a P&L asked for
Tuesday would answer with Sunday, Monday and Tuesday's interest on Tuesday's
line. So the sweep walks whole game days and dates each charge on the day it is
for, and catching up costs a line per day missed.

`loan.interest_accrued_through_at` is the watermark, and **null means never
accrued** — read as `drawn_at`. Reading it as the epoch would bill a new
borrower for decades on the first tick. The watermark also makes the sweep
idempotent: running it twice in one game day charges nothing the second time.

Interest is charged on the **outstanding** balance, so a loan being repaid costs
less as it shrinks. Nothing amortises yet — see the list at the bottom.

### A shortfall is arrears, not an overdraft

Cash may go negative in Tailfin, so _"the airline cannot pay"_ has to be decided
rather than discovered. The airline pays what it has; the rest becomes
`loan.arrears_minor`, which is §13.5's _"missed payment"_ and the only thing the
ladder watches.

**Arrears are never rolled into the principal.** Compounding a missed payment
into the debt would make the ladder accelerate away from an airline trying to
climb out of it, and §13.5's whole point is that it must be climbable. Arrears
are paid **before** the day's interest whenever cash allows, so an airline that
returns to profit clears its own way off the ladder with no page to visit and no
button to find.

---

## The default ladder

```
missed payment -> warning -> restriction -> forced disposal
               -> repossession -> administration
```

| Rung                | What changes                                                    |
| ------------------- | --------------------------------------------------------------- |
| **Warning**         | Nothing but the clock — 7 in-game days to cure                  |
| **Restriction**     | No new routes, no new aircraft                                  |
| **Forced disposal** | Still only the restriction: the airline is being _told_ to sell |
| **Repossession**    | Secured airframes seized, their value credited against the loan |
| **Administration**  | Loss-making routes closed, rating dropped to its floor          |

One rung per review, never several, and every rung gets the same cure window. A
ladder that jumped from warning to repossession in one sweep would give the
airline no chance to act.

**Forced disposal deliberately does nothing on its own.** §13.5 says _"sell
aircraft or gates to service the debt"_ — that is an instruction to the player,
and automating it would take the decision the rung exists to hand them. The
lender takes the aeroplane at the _next_ rung, which is what gives the
instruction teeth.

> **Recoverable, not run-ending.** Losing your airline outright to a bad loan
> would push players away from the entire system.

Three things follow, and they are why this is a state machine rather than a
series of checks:

1. **Clearing the arrears clears the stage, from anywhere.** A zero balance is
   checked before anything else, so an airline that pays what it owes while in
   administration is out of administration on the next sweep.
2. **Nothing on the ladder deletes, cancels or ceases an airline.** The harshest
   rung strips the network back to the routes that make money. The player keeps
   playing, with a smaller airline and the worst credit in the world.
3. **`administration` is terminal as a _stage_, never as an airline.** There is
   nothing below it and it does not escalate.

### Repossession keeps the livery

§13.5: _"secured aircraft seized; you keep the livery, not the airframe."_

`airframe.repossessed_at` is a **marker, not a delete**, for two reasons. Every
`flight`, `schedule` and maintenance row points at an airframe by id with no
foreign key, so a deleted row would leave a settled flight unable to say what
flew it. And `livery_id` lives on the airframe: the document the player keeps is
the one a delete would take with it.

A seized airframe is out of the fleet — excluded from the fleet list and its
detail (concealed as a 404 like any resource the airline does not hold), from
what may be dispatched, from maintenance, from crew requirements, and from the
tangible assets a lender will advance against. It is also `grounded`, so the
dispatch gate refuses it even if a query somewhere forgets the filter.

The airframe's acquisition cost is credited against the loan it secured, arrears
first. **Crediting rather than closing the loan is deliberate**: §13.1's asset
advance is `0.60 ×` the airline's _whole_ tangible fleet, so a loan may be
several times the value of the one airframe named as security. A seizure that
wrote the whole balance off would make _"pledge your cheapest aeroplane, then
stop paying"_ the best price of credit in the game.

### A wrecked rating falls to `D`, and never into `startup`

An airline that had earned a rating drops to `D` on entering administration. One
that never left `startup` **stays there**, because `startup` is already the
bottom of the ladder and the dearest credit in the game — moving it to `D` would
_raise_ its cap from $250K to $1M as a consequence of defaulting.

The other direction is the one that was nearly wrong: falling _into_ `startup`
would hand a defaulter the profit-exempt founder facility, which is the same
mistake M8-06's rating review made and the same kind of test caught.

---

## Where each thing lives

|                                                     | Where                                        |
| --------------------------------------------------- | -------------------------------------------- |
| Tiers, instruments, stages, what each is secured on | `packages/shared/src/credit.ts`              |
| Every cap, rate, term, the 3.0, 0.60, 1.25, 7 days  | `EconomyConfig.credit`                       |
| The arithmetic and the hysteresis                   | `packages/sim/src/finance/credit.ts`         |
| Interest per day, and the ladder state machine      | `packages/sim/src/finance/default-ladder.ts` |
| Reading trading, writing the loan                   | `packages/server/src/finance/credit.ts`      |
| The accrual sweep                                   | `packages/server/src/finance/interest.ts`    |
| Reviewing the ladder, and enforcing each rung       | `packages/server/src/finance/default.ts`     |

---

## Operational notes

**Lending is not a worker story; the drain and the ladder are.** M8-07's two
sweeps run on the world's game clock in `engine/simulation.ts` — interest first,
then the ladder, and the order is load-bearing rather than tidy: the ladder reads
`loan.arrears_minor` and the accrual is the only thing that writes it, so
reviewing first would judge an airline on yesterday's arrears and give a
defaulter one free rung of slack per tick.

**Production has no worker**, so there a loan is drawn and then costs nothing at
all. Not a degraded mechanic: free money, and §13's _"loans support, they never
carry"_ inverted. `interestDaysCharged`, `interestPaidMinor`, `arrearsMinor`,
`defaultEscalations`, `defaultCures`, `airframesRepossessed` and `financeErrors`
are the counters. `defaultCures` matters on its own — a world escalating with no
cures is one where nobody is recovering, which is a real and different state from
one where the ladder is not running.

The **rating** review, by contrast, stays read-driven. §13.2's hysteresis needs
history, so
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
follows, under the `interest` category — its own line, never folded into a
summary.

**`loan.drawn_at` is game time**, like every in-world instant since ADR-0026: a
twelve-month term is twelve months of the world, and a world at 4× reaches
maturity in a quarter of the real time.

**`loan.secured_airframe_id` carries no foreign key**, on purpose. An airframe
can leave the fleet, and a loan is a financial record that must outlive the asset
it was written against.

---

## What is still not built

- **Amortisation.** M8-07 charges interest; nothing repays principal, so
  `outstanding_minor` falls only when a seizure credits against it. A term
  therefore matures without the loan being paid off, and nothing yet happens at
  maturity. Repayment — voluntary and scheduled — is the natural next issue.
- **Sale-leaseback**, as above.
- **Bond issues** — the issue puts them out of scope; post-MVP, AA only.
- **A web surface.** The API is complete; no page consumes it yet.
