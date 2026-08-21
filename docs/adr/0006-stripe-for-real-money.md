# ADR-0006: Stripe for real-money payments

- **Status:** Accepted
- **Date:** 2026-08-19
- **Deciders:** @simmeh024
- **Constrains:** POD-09 (checkout and payment), POD-16 (pricing), POD-15 (privacy), POD-19 (testing)

## Context

Tailfin has never taken real money. §20 records monetisation as _"direction, not committed"_,
and §24 lists **payment compliance** among the legal questions with no answer yet. No
milestone in the roadmap owned the choice of a payment provider — M8 models the _in-game_
ledger, M14 is transactional email, M15 is credentials.

The first real-money product is the poster shop (milestone **POD · Tailfin Creations**),
which needs card payments, refunds, and a webhook stream Tailfin can trust. Deciding the
provider before that milestone opens means the commerce domain is designed against a real
API rather than a placeholder.

Two things about Tailfin's position shape the choice more than feature comparisons do:

- **One developer, a two-core box, and no PCI appetite.** Any option that puts card data
  through Tailfin's servers is out on its own.
- **Physical goods to consumers, across borders.** That brings tax, invoicing and consumer
  rights, which are far more work than the charge itself.

## Decision

**Stripe**, using a hosted checkout so card details never reach Tailfin's servers.

Specifically:

- **Stripe Checkout or Payment Element**, provider-hosted. Tailfin stores no card data and
  stays out of PCI scope beyond the minimum SAQ-A questionnaire.
- **Webhooks are the source of truth** for payment state, signature-verified, and handled
  idempotently — they arrive more than once and out of order.
- **Stripe is a payment provider, not the order system.** Tailfin's own order and
  fulfilment states (POD-10) are authoritative; Stripe's status is mapped into them, never
  stored raw as the order's state.
- **Prices are computed server-side** and sent to Stripe. A client-supplied total is
  ignored, not validated.
- **Real money and in-game currency stay structurally separate** — different tables,
  different types, no shared helper. `airline.cash_minor` is a game score; a Stripe charge
  is money. AIR-06's `cash_movement` and `moveAirlineCash` remain entirely on the game side
  of this boundary and must not be reused by commerce (ADR-0011).

### Why Stripe rather than the alternatives

| Option                                          | Why not                                                                                                                                                                                                                                                                                                                                  |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **PayPal / Braintree**                          | Workable, but the developer experience and test tooling are weaker, and the webhook model is harder to make idempotent cleanly.                                                                                                                                                                                                          |
| **Paddle / Lemon Squeezy (merchant of record)** | Genuinely attractive: they take on VAT/GST registration and remittance, which is the largest hidden cost here. Rejected for now because they are oriented to digital goods and SaaS — physical fulfilment is a poor fit — and they take a larger cut. **Worth revisiting if EU VAT on physical goods proves as burdensome as expected.** |
| **The POD provider's own checkout**             | Simplest to build and wrong: it makes the provider unswitchable, which is the exact coupling POD-08 exists to prevent, and hands the customer relationship away.                                                                                                                                                                         |
| **Direct acquirer integration**                 | PCI scope, underwriting, and months of work for a project with no revenue.                                                                                                                                                                                                                                                               |

Stripe wins on test tooling more than on price. A sandbox with deterministic test cards, a
CLI that replays webhooks locally, and documented failure modes is what makes POD-19's
testing strategy achievable at all — and the failure paths are most of the risk in a
commerce system.

## Consequences

### What this makes easier

- Card data never touches Tailfin. PCI scope stays minimal.
- Webhook replay and test cards make the failure paths testable without a real charge.
- Refunds, partial refunds and disputes are provider features rather than Tailfin code.
- Stripe Tax exists if the VAT problem becomes real, at additional cost.

### What this makes harder

- **Tailfin is the merchant of record.** VAT/GST registration, invoicing and consumer-law
  compliance are Tailfin's obligations, not Stripe's. This is the largest unresolved cost
  of the decision and needs the legal review already required by POD-13 and POD-15.
- **Another external dependency with an outage surface**, on the path where money moves.
- **Stripe availability by country** constrains where Tailfin can incorporate and sell.

### What we accept

That the provider choice is made before the shop is designed, and that some of POD-09 will
be shaped by Stripe's model — the idempotency key, the webhook-driven state, the hosted
redirect. That is the point of choosing early; the alternative is designing against an
abstraction of a payment provider and discovering it fits none of them.

**The abstraction line is drawn at fulfilment, not payment.** POD-08 keeps the _print_
provider replaceable because printers are commodities and quality varies. Payment is not
being abstracted to the same degree — one hosted checkout, integrated directly — because a
second payment provider is a remote need and a premature abstraction here would cost more
than it saves.

## Revisit when

- EU VAT on physical goods proves more expensive to administer than a merchant-of-record's
  cut, at which point Paddle or an equivalent becomes the better trade.
- Tailfin sells in a market Stripe does not serve.
- Payment volume makes the per-transaction rate worth negotiating or re-tendering.
