# Aircraft marketplace (FLEET-MARKET)

The Fleet page turns M4's aircraft catalogue and acquisition systems into one browsing and
buying journey. It does not own an aircraft fact or a commercial rule: cards, comparisons,
configuration quotes, used listings and orders are projections over existing server-owned
contracts.

## Player journey

The catalogue is a responsive card grid. Type detail and the complete acquisition flow render
in the shell's shared Context rail, so selection never creates a second panel inside the Fleet
page; on narrow viewports the shell turns that same rail into its standard bottom sheet. A
player can search manufacturer/type, filter by canonical class, role, availability and
server-authored acquisition method, sort by real price/range/seats/runway, and compare at most
three types.

Selecting a type exposes overview and specification views. The actions are not reconstructed
from labels in React: `CatalogueEntry.acquisitionMethods` is produced by
`aircraftAcquisitionMethods()` in the simulation package, and the final transaction enforces
that same function. A used action additionally requires a live physical listing returned by
M4-05.

- **Buy new** asks the quote endpoint to fold selected M4-03 option ids into the canonical
  effective specification, price and real-time lead. The confirmation names the aircraft,
  configuration, charge, delivery and resulting cash snapshot.
- **Lease** shows the current M4-04 deposit and monthly obligation. It does not invent the
  recurring settlement calendar reserved for M8.
- **Buy used** opens type-filtered physical airframes with registration, age, hours, cycles,
  configuration, location and M4-05's explainable valuation.

The browser submits ids and a UUID request id, never a price or effective specification.
`POST /api/fleet/acquisitions` locks and revalidates the authoritative facts and funds. A
replayed UUID returns the first result without another charge or aircraft.

Accepted new orders remain visible under **Open orders** through the existing
`GET /api/fleet/orders` contract until M4-04's Worker delivers the airframe. Immediate lease
and used acquisitions refresh the existing M4-07 owned-fleet list.

## Dependency map

| Existing system                          | Marketplace responsibility                                                                    |
| ---------------------------------------- | --------------------------------------------------------------------------------------------- |
| M4-01 aircraft catalogue                 | Canonical type identity, manufacturer, class, specification and authored commercial terms     |
| M4-02 era gating                         | Server-authored visibility, status and permitted acquisition methods                          |
| M4-03 factory options / `effective_spec` | New-aircraft configurator and authoritative quote fold                                        |
| M4-04 acquisition                        | Factory orders, leases, idempotency, transactional cash movement and delivery                 |
| M4-05 used market                        | Real physical listings, depreciation and type-filtered used browsing                          |
| M4-06 maintenance                        | Existing airframe hours/cycles; future richer listing condition                               |
| M4-07 fleet UI                           | Immediate acquisitions and delivered factory orders appear as owned airframes                 |
| AIR ledger                               | Every accepted acquisition's durable cash movement                                            |
| M6 livery                                | Later replaces the neutral type visual for an airline/airframe identity                       |
| VIS                                      | Later supplies a generated aircraft scene through the same visual component contract          |
| HIST                                     | Later supplies physical-airframe history and provenance, not type identity                    |
| M8 finance                               | Later expands lease economics without replacing M4's current truthful terms                   |
| SEC                                      | Session-derived ownership, active-airline mutation guard and server-side financial validation |
| UX                                       | Shared Context rail, keyboard controls, visible focus, semantic status and image fallback     |

## Type visuals, not airframe visuals

`packages/web/src/fleet/aircraft-visuals.ts` is the single versioned registry from canonical
type designation to asset id, dimensions, responsive sources and fallback. The current `v1`
set contains a distinct neutral no-livery render for every one of the 18 shipped types at
720×480 and 1440×960. The registry test derives its coverage from the canonical catalogue,
requires unique ids, and holds the complete WebP set below 1 MB and each file below 50 KB.

`AircraftImage` reserves dimensions, lazy-loads card images, uses the larger source for the
selected detail view, and replaces a failed or unknown asset locally. Data and acquisition
controls do not depend on image delivery.

This baseline belongs to **aircraft type identity**. A future source can satisfy the same
component contract without changing catalogue cards:

```text
neutral type asset
        |
        +-- owned airframe -> M6 airline livery
        +-- physical airframe -> HIST identity/provenance
        +-- generated context -> VIS scene
```

## API boundaries

| Endpoint                             | Role                                                                    |
| ------------------------------------ | ----------------------------------------------------------------------- |
| `GET /api/fleet/catalogue`           | Era-filtered types, options, display facts and acquisition methods      |
| `GET /api/fleet/used-market`         | Available physical listings and explainable server valuation            |
| `POST /api/fleet/acquisition-quotes` | Non-mutating new/lease preview through the final transaction's resolver |
| `POST /api/fleet/acquisitions`       | The only lease/new/used spending mutation                               |
| `GET /api/fleet/orders`              | Accepted commitments, including pending factory deliveries              |
| `GET /api/fleet/airframes`           | M4-07's owned physical fleet after immediate or Worker delivery         |

The quote's cash and estimated delivery are informational snapshots. The mutation reloads
and locks the airline, catalogue, world clock, airport/listing and cash before it writes.

## Intentional boundaries

- No livery editor, VIS renderer, HIST event store, finance engine or performance formula is
  introduced here.
- Catalogue values have no guessed currency symbol; Tailfin currently exposes minor units
  but no world currency code.
- A used listing is never represented as a discounted type card.
- Advanced recurring lease settlement waits for M8's accounting/calendar decision.
- Visual-regression snapshots wait for repository E2E infrastructure; current protection is
  contract, interaction, token, responsive-layout and asset-budget coverage.
