# Roadmap dependencies and domain ownership

The one place that answers, for every planned Tailfin system:

- What does this depend on?
- What depends on this?
- Who owns the domain?
- Is that dependency **implemented**, **planned**, or **missing**?
- Does another milestone duplicate or contradict it?

**This is not a roadmap.** It carries no dates, no ordering commitments beyond hard dependency,
and no issue counts — CLAUDE.md forbids copying counts and completion summaries into the
repository, because all of them become false as soon as roadmap work lands. Relationships are
stable; progress is not. For what is next, use the live
[GitHub milestone list](https://github.com/simmeh024/tailfinsim/milestones).

Produced by the GAP milestone. Where a statement here disagrees with an issue, the issue wins and
this file is wrong — say so in a comment rather than guessing.

---

## The dependency graph

Read `A → B` as _B depends on A_. `[MISSING]` marked a domain with no parent milestone before the
GAP review; each now has one, and the marker is kept so the shape of the gap stays legible.

### Core sequence

```
M0 foundations
 ├─ M1 world, time, airports → M2 flight ops → M3 demand & commercial
 └─ AIR the airline          → M4 fleet      → M5 crew & ground

M2 + M3 + AIR + M4 + M5
 └─ M8 finance & statistics
     └─ PX passenger experience & reputation
         └─ LOYALTY frequent flyer economy

M2 + M3 + M4 + M5 + PX + M8
 └─ IROPS operations control & disruption recovery

M4 + M6 design tools
 ├─ VIS aircraft visual identity
 ├─ HIST living airframe history
 └─ M7 world map, hubs & gates
```

### The connective domains the GAP review opened

```
PAX passengers, bookings & itineraries          [was MISSING — now milestone 37]
 ├─ LOYALTY-01  member population grain
 ├─ PX-01       journey record
 ├─ IROPS-11    reaccommodation
 └─ ALLIANCE    interline itineraries, revenue proration

M7 + M12 + M3 + PAX + REG
 └─ ALLIANCE partnerships, codeshares & interline [was MISSING — now milestone 38]

M8 + AIR + M4 + M7
 └─ LEGACY airline failure, bankruptcy & restart  [was MISSING — now milestone 40]

M4 + M7 + M8 + M12-04
 └─ MARKET player contracts & aviation marketplace [was MISSING — now milestone 45]

M2-03 rotations + M3-02 seasonal demand + M3-04a timezones
 └─ SEASON seasonal scheduling & timetables        [was MISSING — now milestone 41]

AIR + HIST + LEGACY + M12  (blocked by the reset decision)
 └─ HISTORY airlines, records & world legacy       [was MISSING — now milestone 42]

M8 + M10 + M12 + M14 + AUTH + IROPS
 └─ COMMS notifications, messaging & preferences   [was MISSING — now milestone 39]

M1 + M2-01 + M4-02
 └─ REG regulatory, traffic rights & market access [was MISSING — now milestone 43]

M2-08 + M4-06 + M5 + M9
 └─ SAFETY incidents, airworthiness & investigation [was MISSING — now milestone 44]
     └─ RISK insurance & risk transfer              [deferred; no milestone, no dependents]

M3 + M8-15 + M7 facilities
 └─ CARGO freighter & logistics operations          [was MISSING — now milestone 46]

M3 + PAX + M6 + PX + LOYALTY-08
 └─ RM revenue management & inventory control       [was MISSING — now milestone 47]
```

### Front door and progression

```
LANDING → AUTH → AIR → M10 onboarding, objectives & retention
```

A first-time visitor understands the game (LANDING), signs in (AUTH), founds an airline (AIR),
and is guided through the first ninety minutes (M10). Each link is hard: M10-01's onboarding has
nothing to onboard into without AIR, and AIR has no owner without a session.

### Infrastructure and cross-cutting

```
OPS delivery & operations  ↔  SCALE runtime capacity  ↔  V&V verification
                                                            ↓
                                                       CI-SAFE  (promotes V&V
                                                                 techniques into
                                                                 automatic CI gates)

E2E + SEC + SEC-HARD + M13   cut across every player-facing system.
```

`↔` is deliberate. OPS provisions nodes and SCALE decides how many are needed; SCALE measures
capacity and V&V decides whether the measurement is trustworthy. Neither direction dominates.

---

## Domain ownership

One row per milestone. "Does not own" is the load-bearing column: it is where duplicated work
comes from.

| Milestone                                  | Owns                                                                                                                                                                      | Explicitly does **not** own                                                                                       |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| **M0** Foundations                         | Monorepo, CI, Postgres/Drizzle, shared zod schemas, server and client skeletons                                                                                           | —                                                                                                                 |
| **M1** World, Time & Airport Data          | World clock and derived game time, tick loop and event queue, airport dataset, distance matrix                                                                            | Seasonal timetables → SEASON                                                                                      |
| **M1A** Admin Console Core                 | **Admin foundation / MVP**, delivered: sign-in and roles, world creation, speed multiplier, world lifecycle, read-only player and airline browser, world health           | The advanced control plane → M11                                                                                  |
| **M2** Flight Operations                   | Routes and the seven reachability checks, schedules and rotations, turnaround, cost, settlement, disruption, weather                                                      | Traffic rights (check 6) → REG · Incidents → SAFETY · Season validity → SEASON                                    |
| **M3** Demand & Commercial                 | Demand pools, the logit share model, spill and recapture, class allocation, connecting itineraries, booking curve, fares, NPC carriers, versioned economy config          | Passengers as entities → PAX · Fare buckets → RM · Codeshare → ALLIANCE                                           |
| **M4** Fleet & Aircraft                    | Catalogue and era gating, `effective_spec`, acquisition, used market, maintenance and AOG, fleet UI                                                                       | Player-to-player sales → MARKET · Regulatory grounding → SAFETY                                                   |
| **M5** Crew & Ground                       | Crew model, duty/rest/fatigue, morale and pay, office hires, the automation ladder, ground vendors, station fuel                                                          | The shared crew labour market (unowned — see open gaps)                                                           |
| **M6** Design Tools                        | Livery document and builder, licensed 3D asset contract and deterministic runtime pipeline, server-side rendering, cabin builder, seat products                           | Object storage/CDN → VIS · Alliance branding → ALLIANCE (reuses this editor)                                      |
| **M7** World Map, Hubs & Gates             | Renderer, live aircraft and route layers, hubs, slots, gates and stands, airport map                                                                                      | Slot trading → MARKET · Slot seasonality → SEASON (coordinated, not duplicated)                                   |
| **M8** Commercial, Finance & Statistics    | Ledger and P&L, currency conventions, service catalogue, loans and the default ladder, cash runway, statistics API, dashboards, belly cargo                               | Taxation (unowned — GAP-17) · Terminal failure → LEGACY · Freighters → CARGO · Notification delivery → COMMS      |
| **M9** Training, XP & Research             | Academy, crew XP, skill trees, research tree, boosts and caps                                                                                                             | The incident rate its boosts modify → SAFETY                                                                      |
| **M10** Onboarding, Objectives & Retention | The first ninety minutes, objectives engine, reward economy, daily check-in, push consent UX                                                                              | Notification delivery → COMMS                                                                                     |
| **M11** Admin Control Plane                | **Advanced live-ops control plane**: capabilities, scoping, expiring privilege, break-glass, approvals, moderation, appeals, support cases, investigation, console design | The admin foundation → M1A, delivered · Provisioning → OPS · Capacity → SCALE · The authorization framework → SEC |
| **M12** Shared World & Multiplayer         | State sync, public profiles and leaderboards, player messaging, anti-cheat and multi-accounting, new-entrant protection, world events                                     | Alliances → ALLIANCE · Marketplaces → MARKET · Historical records → HISTORY                                       |
| **M13** Quality, Access & Launch           | **Launch-readiness acceptance**, plus the replay and economy-regression harnesses                                                                                         | Load and soak → V&V · Backups and restore → OPS, delivered                                                        |
| **M14** Transactional Email                | Provider, mail DNS, typed templates, queueing, bounces, the non-production sink                                                                                           | The canonical notification event → COMMS                                                                          |
| **M15** Account Recovery & Credentials     | Verified email, session visibility and revocation, security-change triggers                                                                                               | **Passwords — declined.** Identity linking → AUTH                                                                 |
| **AUTH** Multi-Method Authentication       | Discord, magic links, passkeys, the identity-linking policy, one session kind, auth auditing                                                                              | Notification delivery → COMMS                                                                                     |
| **AIR** The Airline                        | Founding, identity, codes, cash movements, the lifecycle states                                                                                                           | Bankruptcy → LEGACY · Historical records → HISTORY                                                                |
| **PX** Passenger Experience                | Journey satisfaction, brand dimensions, perception, reputation memory and decay, brand effects on demand and willingness to pay                                           | Passenger entities → PAX · Safety events → SAFETY                                                                 |
| **LOYALTY** Loyalty Programme              | Programme config, points ledger, tiers and benefits, redemption, expiry and breakage, liability                                                                           | Member population grain → PAX · Partner reciprocity → ALLIANCE · Award inventory mechanics → RM                   |
| **IROPS** Operations Control               | Disruption cases, dependency graph, impact, recovery actions and plans, transactional commit, the OCC                                                                     | Passengers and bookings → PAX · Partner recovery → ALLIANCE · Incidents → SAFETY                                  |
| **HIST** Living Airframe History           | One physical airframe: identity, registrations, ownership provenance, statistics, technical and livery history, retirement                                                | Airline history → HISTORY                                                                                         |
| **VIS** Aircraft Visual Identity           | Versioned aircraft render assets, scene composition, render queue, object storage and CDN                                                                                 | —                                                                                                                 |
| **POD** Tailfin Creations                  | Physical print products, provider abstraction, checkout, fulfilment                                                                                                       | —                                                                                                                 |
| **UX** Player Experience                   | Information architecture, the design system, metric and table components, states, journeys                                                                                | Accessibility scanning → V&V                                                                                      |
| **OPS** Delivery & Operations              | Deployment, node topology, provisioning, backups and restore, promotion policy                                                                                            | Capacity decisions → SCALE                                                                                        |
| **SCALE** Runtime Capacity                 | Capacity metrics, runtime history, pressure detection, worker lifecycle and multiplicity, operator runtime alerts                                                         | Player notifications → COMMS · Load-test trustworthiness → V&V                                                    |
| **V&V** Verification & Resilience          | **How Tailfin proves correctness** — the strategy, tiers, and the independence principle                                                                                  | Browsers → E2E · Authorization → SEC · Replay and economy regression → M13 · Deployment recovery → OPS            |
| **CI-SAFE** CI Safety Net                  | **Promoting verification techniques into automatic, low-noise CI gates**                                                                                                  | The techniques themselves → V&V, M13, SEC-HARD                                                                    |
| **E2E** Browser Testing                    | **Real browser and system journeys**, and the Playwright infrastructure others use                                                                                        | —                                                                                                                 |
| **SEC** Authorization & Ownership          | **Authorization and ownership correctness**, and the reusable permission-matrix framework                                                                                 | Broader security posture → SEC-HARD                                                                               |
| **SEC-HARD** Security Hardening            | **Security posture and abuse resistance**: headers, CORS, rate limits, supply chain, secrets, host hardening, incident response                                           | **Authorization and privilege escalation → SEC**                                                                  |
| **LANDING** Public Landing                 | The public front door and the sign-in funnel                                                                                                                              | Authentication methods → AUTH                                                                                     |
| **TIDY** Repository Coherence              | Repository-level traps, documentation truth passes                                                                                                                        | —                                                                                                                 |
| **PAX** Passengers & Bookings              | The passenger/booking/itinerary model and grain, allocation, the journey record, its scale strategy                                                                       | Loyalty → LOYALTY · Reputation → PX · Reaccommodation → IROPS · Demand → M3                                       |
| **ALLIANCE** Partnerships                  | Both partnership tiers, governance, branding, codeshare and interline, settlement, reciprocity, network effects, anti-monopoly guards                                     | Messaging → M12-03 · The vector editor → M6 · Anti-cheat → M12-04                                                 |
| **COMMS** Notifications                    | The canonical notification event, categories, preferences, in-app/email/push delivery, dedupe, retry, retention                                                           | Email transport → M14 · Push consent UX → M10-07 · Message content → M12-03 · **Operator alerts → SCALE-04**      |
| **LEGACY** Airline Failure                 | Insolvency and terminal failure, restructuring, liquidation, asset disposition, restart and carry-over, failure exploits                                                  | The recoverable default ladder → M8-07 · Lifecycle states → AIR-09                                                |
| **SEASON** Seasonal Scheduling             | Seasons, schedule validity windows, seasonal routes, future publication, rollover and cloning, season comparison                                                          | Seasonal demand → M3-02 · Slots → M7-05                                                                           |
| **HISTORY** Airlines & World Legacy        | Airline founding and closure records, historical statistics and hubs, records and achievements, former airlines, the world-era timeline                                   | Airframe provenance → HIST · Live statistics → M8 · Leaderboard surfaces → M12-02                                 |
| **REG** Regulatory & Traffic Rights        | The regulator, traffic rights by country pair and era, freedoms of the air, the AOC, route authority, antitrust remedies                                                  | Slots → M7-05 · Reachability's seven checks → M2-01                                                               |
| **SAFETY** Incidents & Airworthiness       | Incident definition and severity, investigation, regulatory grounding, airworthiness directives, hull losses, the safety rating                                           | Disruption → M2-08 · Maintenance and AOG → M4-06 · Insurance → RISK, deferred                                     |
| **MARKET** Player Marketplace              | Player-to-player asset sales and leases, wet lease and ACMI, slot and gate contracts, escrow and atomic settlement, defaults, anti-collusion                              | The NPC used market → M4-05 · Crew poaching → M5 · Anti-cheat → M12-04                                            |
| **CARGO** Freighter Operations             | Freighters, cargo demand and contracts, ULD and capacity, terminals and sorting, network design, conversions                                                              | Belly cargo → M8-15                                                                                               |
| **RM** Revenue Management                  | Fare buckets and booking classes, inventory control, overbooking, forecasting, pricing policies                                                                           | Fare setting → M3-09 · Bookings → PAX                                                                             |

---

## Contradictions and duplicates found, and their resolution

| #   | Finding                                                                                                                                                                                                                                        | Resolution                                                                                                                                                                             |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **AUTH says "No passwords"; M15 kept password architecture open.** M15-01 (#144) and AUTH-25 (#311) are the same ADR, and AUTH-25 says so. M15-01's ADR path `0007-additional-sign-in-methods.md` is stale — ADR-0007 is Unicode airline names | GAP-04 (#657). #146 and #147 **closed** on M15-01's own gating criterion. #144 and #148 held open until the ADR lands, because #144 holds the analysis the ADR must carry              |
| 2   | **M11-01 (#101) restates the delivered M1A-01 (#157)**, and asks for admin credentials separate from a player account — contradicted by ADR-0004 and AUTH                                                                                      | GAP-13 (#666): rewrite #101 to own **admin MFA** only, which is the one requirement in it that is real and unowned. Closing it would be a security regression achieved through tidying |
| 3   | **M13-01 (#115) and CI-SAFE-01 (#584) are one replay harness described twice.** Resolved in CI-SAFE-01's prose, not in the titles                                                                                                              | GAP-06 (#659): #115 builds the harness, #584 gates it in CI, both titles say which                                                                                                     |
| 4   | **M13-04 (#118) load and soak overlaps V-19..V-25**, and V-24 (#353) is near-identical in intent                                                                                                                                               | GAP-06 (#659): narrow #118 to what V&V does not cover, or merge and close                                                                                                              |
| 5   | **M13-11 (#125) is substantially delivered** by the closed OPS-03 (#171) and OPS-04 (#172)                                                                                                                                                     | GAP-06 (#659): reduce or close; name specifically anything still outstanding                                                                                                           |
| 6   | **Accessibility is in three places** — M13-05 (#119), V-08 (#337), UX-10 (#471) — with no stated relationship                                                                                                                                  | GAP-06 (#659): each states its relationship to the other two. No scope change                                                                                                          |
| 7   | **M11-27 (#546) delegates the notification channel to SCALE-04 (#453).** Right for operators, wrong for players — different audiences, different consent rules                                                                                 | Two channels by design. SCALE-04 keeps operator alerting; COMMS owns player notifications. Recorded in both                                                                            |
| 8   | **§24's reset philosophy is unresolved and self-contradictory.** §7.2b argues era-gating is the natural reset; §16 proposes seasonal resets with prestige carry-over; the document says they are incompatible                                  | GAP-07 (#660). It blocks HISTORY, and HIST has already spent twenty issues on the indefinite-world reading                                                                             |
| 9   | **ADR-0018 forbids restart.** Ownership membership survives cessation _"so a non-anonymized owner cannot silently found a second airline in the same world"_ — so a player who ceases cannot start again                                       | GAP-08 (#661) owns amending it deliberately, with a replacement for the anti-abuse control it provided                                                                                 |
| 10  | **§13.5 forbids the obvious bankruptcy design.** _"Recoverable, not run-ending"_ — so whatever ends an airline, it is not the default ladder                                                                                                   | GAP-08 (#661) treats it as an input, not something to override quietly                                                                                                                 |
| 11  | **M3-04a's DST reasoning inverts under seasons.** It skips daylight saving because _"Tailfin has no summer/winter timetable concept"_                                                                                                          | GAP-09 (#662): the DST decision is revisited with an answer either way. Seasonal timetables and DST are one change                                                                     |
| 12  | **§24 marks "Safety, incidents & insurance" MVP-blocking; the MVP definition omits it.** Both true; the contradiction predates the roadmap                                                                                                     | GAP-12 (#665) records it rather than resolving it silently. Safety is P1; insurance is P3                                                                                              |

---

## Open decisions with no owner yet

Named here so they are visible rather than implicit. Each is a real gap the GAP review could not
place in an existing or new milestone.

| Gap                                                          | Referenced by                                                                 | Status                                                                                                     |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| **The shared crew labour market**                            | §9.2 asserts one exists; §24 says it does not                                 | Unowned. Nearest owner is M5-01/M5-03                                                                      |
| **Lessor counterparties, lease terms and return conditions** | §24 needed-before-launch; M4-04 acquisition; every wet-lease idea             | Unowned. GAP-15 (#668) asks for it to be taken up or filed                                                 |
| **Distribution channels and booking costs**                  | §24 needed-before-launch; advance-purchase and corporate fares live here      | Unowned. GAP-16 (#669) asks for a decision                                                                 |
| **Corporate and ticket taxation**                            | §24 MVP-blocking; M8-01's "full P&L"                                          | GAP-17 (#670)                                                                                              |
| **Insurance and risk transfer**                              | §24 MVP-blocking, bundled with safety                                         | GAP-18 (#671). Deferred behind SAFETY; **no milestone, because no filed issue depends on it**              |
| **The sim fidelity ceiling**                                 | §24's second deliberate decision                                              | Partly settled: M2-08 and M2-09 set a deterministic weather and disruption baseline. The remainder is open |
| **An unassigned bug**                                        | #506 — `GET /api/routes/:routeId/waterfall` 404s for everyone, owner included | The only issue in the repository with no milestone. An M3-10 defect with no home, since M3 is closed       |

---

## Priority classification

- **P0 — Architectural dependency gap.** Downstream work is already blocked, or relies on a system
  that does not exist. P0 means _load-bearing now_, not _needed at launch_.
- **P1 — Required before 1.0.** Needed for Tailfin to feel complete and coherent.
- **P2 — Important expansion.** Architecturally anticipated; does not block launch.
- **P3 — Optional simulation depth.** Worth building only if it creates a real decision.

| Gap                             | Priority                     | Blocks launch?                | Reasoning                                                                                      |
| ------------------------------- | ---------------------------- | ----------------------------- | ---------------------------------------------------------------------------------------------- |
| PAX passenger truth (#655)      | **P0**                       | No                            | Three filed issues are hard-blocked; LOYALTY, PX, IROPS and ALLIANCE all consume it            |
| ALLIANCE parent (#656)          | **P0**                       | No                            | IROPS-26 and LOYALTY-14 are writing contracts against a domain that does not exist             |
| AUTH/M15 reconciliation (#657)  | **P0**                       | **In effect, yes**            | Two authentication architectures cannot both stay open                                         |
| COMMS canonical event (#658)    | **P0** for the contract      | Contract yes, stack no        | Must land before M14-03 defines a message shape for email alone                                |
| Quality-track ownership (#659)  | **P0**                       | No                            | Three live duplicates already exist because it is unwritten                                    |
| Reset / endgame decision (#660) | **P0**                       | No                            | §24: _"choosing late will cost architecture"_. HIST has already bet on one answer              |
| LEGACY terminal failure (#661)  | **P1**                       | No                            | M8-07 must not ship an administration state with no exit                                       |
| SEASON scheduling (#662)        | **P1**                       | No                            | Demand has seasons; the schedule cannot answer                                                 |
| HISTORY foundation (#663)       | **P1**                       | No                            | History not recorded at the time cannot be reconstructed. Blocked by #660                      |
| REG traffic rights (#664)       | **P1**                       | No                            | `open-route.ts:191` is a hard-coded `true`. Becomes P0 with ALLIANCE or a historical-era world |
| SAFETY incidents (#665)         | **P1**                       | §24 says yes; the MVP says no | M9 prices an incident rate with no incident. **Corrects the original P3 for insurance**        |
| M1A/M11 reconciliation (#666)   | **P1**                       | No                            | #101 is M11's lowest-numbered issue and the most likely to be picked up first                  |
| CARGO decision (#667)           | **P1** decide / **P2** build | No                            | M7 and M6 are shipping cargo facilities for an undecided domain                                |
| MARKET marketplace (#668)       | **P2**                       | No                            | Deferred post-MVP in four places. **Must not precede M12-04**                                  |
| RM foreclosure check (#669)     | **P2** arch / P3 feature     | No                            | Costs almost nothing now; prevents a rewrite later                                             |
| Currency, FX & tax (#670)       | **P2**                       | No                            | Ledger category must be agreed before M8-01 ships                                              |
| Insurance / RISK (#671)         | **P3**                       | No                            | Deferred behind SAFETY. No filed issue depends on it                                           |

### Where this disagrees with the original review

The GAP review's own opening recommendation was challenged against the roadmap, as instructed.
Three changes:

1. **Insurance moves down, and safety moves up.** The original list had insurance at P3 as the
   only entry in its area. Design doc §24 marks _"Safety, incidents & insurance"_ **blocking for
   MVP**, and M9-06 already caps a boost at _"incident/delay rate −30%"_ against an undefined
   denominator. The gap is **safety and incidents** at P1; insurance is its tail, and the tail is
   genuinely optional. #671 confirms P3 for insurance itself.
2. **Notification architecture splits.** P0 for the canonical event, P1 for the delivery stack.
   Nothing is blocked today — every consumer is unbuilt, including M14 — but the contract must
   precede M14-03 or four adapters get built over an email record.
3. **Three gaps were added that the original list did not name**, all from §24 or from the code:
   PAX passenger truth (**P0**, and arguably the largest single finding), REG traffic rights
   (**P1**, measurable at `open-route.ts:191`), and the reset/endgame decision (**P0**, §24's own
   words). Currency and taxation was added at P2.

Confirmed unchanged: ALLIANCE at P0, AUTH/M15 at P0, quality-track ownership at P0, bankruptcy and
seasonal scheduling at P1, marketplace and revenue management at P2.

### Recommended creation order

Dependency order, not a schedule. The three reconciliations first because they are cheap and
remove live contradictions; the two decisions next because other work is sizing against them.

```
1. #657  AUTH/M15        — closes a contradiction, no new domain
2. #659  quality tracks  — resolves three live duplicates
3. #666  M1A/M11         — one issue rewrite, before M11 starts
4. #660  reset/endgame   — blocks HISTORY; §24 says choosing late costs architecture
5. #655  PAX             — blocks LOYALTY, PX, IROPS and ALLIANCE
6. #658  COMMS contract  — before M14-03
7. #656  ALLIANCE gate   — after PAX and REG are at least decided
8. #664  REG             — the literal at open-route.ts:191
9. #661  LEGACY          — before M8-07 ships
10. #662 SEASON · #663 HISTORY (after #660) · #665 SAFETY
11. #667 CARGO decision  — before M7-04/M7-06/M7-07 ship
12. #670 currency & tax  — before M8-01 ships
13. #669 RM check · #668 MARKET (after M12-04) · #671 RISK (after SAFETY)
```

### Explicit blockers

| Blocked                            | By                        | Why                                                                         |
| ---------------------------------- | ------------------------- | --------------------------------------------------------------------------- |
| HISTORY (#663)                     | #660 reset decision       | What persists across a reset is its first storage parameter                 |
| ALLIANCE interline                 | #655 PAX                  | An interline itinerary spans two operators; there are no itineraries        |
| ALLIANCE codeshare                 | #664 REG                  | A codeshare is a traffic-rights question first                              |
| LOYALTY, PX, IROPS reaccommodation | #655 PAX                  | Each is hard-blocked and each says so                                       |
| MARKET (#668)                      | **M12-04 (#112)**         | A marketplace before anti-cheat is a value-laundering channel               |
| MARKET wet lease                   | Lessor and lease-term gap | Hard to specify while a lease is only an acquisition path                   |
| LEGACY (#661)                      | M8-07 (#79)               | The ladder is its input                                                     |
| LEGACY restart                     | ADR-0018 amendment        | The ADR currently forbids refounding in the same world                      |
| RISK (#671)                        | #665 SAFETY               | A premium against a rating that does not exist is a fee, not a decision     |
| RM (#669), anything real           | #655 PAX                  | A booking class is a property of a booking                                  |
| COMMS stack                        | M14                       | Email is the first transport                                                |
| Admin MFA (#666)                   | #657                      | Under a passwordless model it is a passkey, not a TOTP secret on a password |

---

## The trap this document exists to record

Four subsystems now read as broken on a production world rather than as missing a process, because
**production has no worker** ([OPS-12](https://github.com/simmeh024/tailfinsim/issues/191)): the
used aircraft market, maintenance, the fleet page and NPC review. CLAUDE.md records each.

Every domain opened here adds another: HISTORY would aggregate nothing, SAFETY would open no
incident and clear none, SEASON would roll over no timetable, COMMS would deliver no digest, and
MARKET would expire no offer. In each case the surface answers `200` with an empty result.

**So every new worker job needs a heartbeat counter**, for the same reason `usedListingsCreated`,
`checksCompleted` and `aircraftDeliveries` exist — so that _nothing has run_ is distinguishable
from _everything is fine_. `ticks: 0, errors: 0` is the canonical example of a reading that means
the opposite of what it looks like.

---

## Keeping this true

- A change that adds, renames or retires a milestone updates this file in the same pull request.
- A new dependency edge is recorded when it is discovered, not when it is resolved.
- Resolved contradictions stay in the table with their resolution, because the reasoning is the
  useful part.
- V-37 ([#367](https://github.com/simmeh024/tailfinsim/issues/367)) owns keeping the verification
  matrix true; the ownership table above is its neighbour and should move with it.
