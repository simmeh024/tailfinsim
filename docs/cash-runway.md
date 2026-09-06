# Cash runway

How many in-game days the airline can fund, and why that is not cash divided by
burn. Design doc **§13.6**; built by **M8-08**.

---

## The lesson it exists to teach

> The distinction is deliberately taught. A profitable airline can still run out
> of cash — lease deposits, aircraft down payments, gate leases and academy
> construction all hit cash long before they show up in profit. The dashboard
> shows a **cash runway in in-game days** at all times, and it is the single most
> prominent number when it drops below 30.

Two sentences, and both are requirements.

---

## Why it is a walk and not a division

`cash / burn` is the obvious implementation and it is precisely the number §13.6
calls misleading. An airline with $3M, a gentle burn and a $2.8M bill due in nine
days has about nine days of runway; the division says months.

So the projection **walks game days** from today's cash, adding the operating
flow and subtracting each commitment on the day it falls due. The first day the
balance would go negative ends the runway. A day is funded when the balance is
still non-negative at the end of it, so an airline that reaches exactly zero on
day twelve has twelve days: it paid everything it owed.

The walk costs one iteration per day of horizon — 365 additions — and it is the
only shape that can also say **which bill** ended it, which §14.1 requires of any
figure a player might argue with.

`days` is **null**, never the horizon, when the airline survives the year.
_"365 days"_ and _"at least 365 days"_ are different claims.

---

## What goes into it

### The operating rate

Net cash from **trading**, over the trailing 30 game days, divided by 30. Every
`cash_movement` cause is classified into exactly one of three buckets by an
exhaustive `switch` with no `default` — so a new cause stops the build until
somebody decides which it is.

| Bucket        | Causes                                                                                                           | Why                                                                   |
| ------------- | ---------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| **rate**      | `flight_settlement`, `maintenance_check`, `disruption_cost`, `crew_positioning`, ground penalties and shortfalls | Recurring trading. What the airline does for a living.                |
| **projected** | `crew_payroll`, `crew_base_overhead`, `office_salary`, `ground_self_handling_payroll`, `loan_interest`           | A commitment below reproduces each exactly. In both, they bill twice. |
| **one_off**   | purchases, deposits, founding, expansions, hires, `admin_adjustment`, `loan_draw`                                | Real movements, and emphatically not rates.                           |

That last row is the one that would break the number quietly. A $390M aeroplane
inside a thirty-day window implies a burn of $13M a game day, and would report an
airline that just bought a fleet as having days to live. A drawn loan does the
reverse and reports one that just borrowed as immortal.

Divided by the window rather than by the airline's age, so a three-day-old
airline is not told it burns a third of its founding grant every day.

### The commitments

Each is projected from **today's state**, not from last month's bill — which is
the whole of the first acceptance criterion. Crew hired an hour ago are a
committed outflow that no burn rate has seen yet.

| Commitment                         | Due                      | From                                   |
| ---------------------------------- | ------------------------ | -------------------------------------- |
| Crew salaries and base overhead    | first of each game month | `foldCrewBills`, shared with the sweep |
| Head-office and executive salaries | first of each game month | `office_hire` + `executive_hire`       |
| Self-handling payroll              | first of each game month | active `ground_self_handling`          |
| Loan interest                      | **every game day**       | §13.4's own per-day charge             |
| Arrears                            | now                      | §13.5's missed payments                |

Interest is one commitment a **day** rather than a monthly total, because that is
literally how M8-07 charges it, and folding a month onto the first would move the
day the airline runs out.

`monthBoundariesAhead` is shared by all three monthly bills, so they cannot
disagree about which day "the first of next month" is.

### The projection must equal the charge

A runway is a promise about a future bill, so the projection and the sweep that
will make that bill have to compute it identically. Two mechanisms hold that:

1. **Crew shares the arithmetic.** `foldCrewBills` is called by `runCrewPayroll`
   and by the projection. There is one implementation, so there is one answer.
2. **A database test proves it.** `runway-db.test.ts` projects the office bill,
   then runs `runOfficePayroll` for real and asserts the cash it took equals what
   was projected. A copy that drifted would fail there rather than in front of a
   player.

---

## Below thirty days

> …and it is the single most prominent number when it drops below 30.

Prominence in a row of six identical small figures is **position and size**, not
colour. So the item leads the strip instead of sitting third, takes a
display-sized figure on an alert ground, and announces itself politely. The
colour and the `.status--*` glyph are the third and fourth signals, never the
only ones (H.4, H.7).

**The server decides `critical`**, and the client never recomputes it. A page
that decided for itself when an airline was in trouble would eventually disagree
with the alert that told it.

---

## Where each thing lives

|                                            | Where                                          |
| ------------------------------------------ | ---------------------------------------------- |
| The walk, and the month boundaries         | `packages/sim/src/finance/runway.ts`           |
| Cause classification, commitments, horizon | `packages/server/src/finance/runway.ts`        |
| `GET /api/finance/runway`                  | `packages/server/src/finance/routes.ts`        |
| The strip item and its critical treatment  | `packages/web/src/finance/RunwayIndicator.tsx` |

---

## Operational notes

**This is not a worker story, but it reads one.** The projection is computed on
demand and behaves identically on every node. What it _measures_ is mostly
`flight_settlement`, and **production has no worker**, so there nothing ever
settles: the operating rate is zero, no commitment is ever paid, and every
airline reads _"365+ days"_ for ever. That is the same trap as an empty used
market or a fleet at `0.0 h/day` — it reads as a healthy airline rather than as a
missing process.

**The window and the horizon are not balance numbers.** Nothing prices off the
thirty-day rate window or the 365-day horizon, and no `flight_result` is billed
against either; they are decision-support constants of the kind
`network/performance.ts` already owns. §13.6's _thirty days_ threshold is in the
same file for the same reason.

**Every instant is game time** (ADR-0026), including the month boundaries the
payrolls fall on. A world at 4× reaches its next payday in a quarter of the real
time, and the runway shortens four times as fast.

---

## What M8-08 did not build

- **Lease rentals.** `aircraft_order.monthly_lease_rate_minor` is recorded at
  acquisition and **nothing ever charges it** — there is no lease payment sweep
  anywhere in the game. Projecting it would make the runway predict outflows the
  game never makes, which is worse than omitting it: the number would be
  pessimistic in a way no player could reconcile against their own ledger. When a
  rental sweep exists, its commitment belongs here.
- **Ground contract volume shortfalls.** Charged at `term_end` by
  `expireGroundContracts`, and genuinely committed — but the amount depends on
  how much the airline flies between now and then, which is a forecast rather
  than a commitment. Past shortfalls are in the operating rate.
- **Scheduled principal repayment**, which does not exist yet (see
  [`loans-and-credit.md`](loans-and-credit.md)).
- **A drill-down page.** The response carries the burn, the total committed, the
  next eight bills and the one that ends the runway; the strip shows the number
  and a tooltip. Somewhere to interrogate it properly is §14's.
