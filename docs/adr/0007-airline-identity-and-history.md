# ADR-0007: Unicode airline names, operational callsigns, and identity history

- **Status:** Accepted
- **Date:** 2026-08-20
- **Deciders:** @simmeh024
- **Constrains:** AIR-02, AIR-08, M11-06, M12-02

## Context

An airline name, callsign and codes are public player-authored text (§16). Section 22.6
requires conflict resolution and a force-rename sanction, while §15 says a player rebrand
is an event with a cost. AIR-02 must therefore establish rules and a moderation remedy
without inventing the later UGC policy or silently making player rebrands free.

The repository also needs an explicit answer to two identity questions:

1. whether a player may use a non-Latin name; and
2. whether historical flights retain the spelling used when they flew or follow the
   airline's current identity.

## Decision

All deterministic identity rules live in `packages/shared/src/airline.ts`:

- **Airline names are Unicode.** They contain 1–120 Unicode code points, are NFC-normalised,
  contain at least one Unicode letter, use ordinary spaces without leading, trailing or
  doubled spaces, and allow letters, combining marks, numbers and a small visible
  punctuation set. Emoji, controls and invisible separators are rejected. This supports
  names such as `Air Côte d’Ivoire`, `航空会社` and `خطوط الأفق` without making every Unicode
  symbol valid leaderboard text.
- **Callsigns are operational ASCII.** They contain 2–32 uppercase Latin letters, numbers
  and single internal spaces, including at least one letter. This is intentionally narrower
  than the display name so later ATC, voice and search surfaces can reproduce it exactly.
- **IATA and ICAO codes remain ASCII** under their existing two-character uppercase
  alphanumeric and three-letter uppercase rules. ADR-0009 owns per-world allocation and
  AIR-09 owns release; the moderation rename path does not change codes.

Validation and moderation stay separate. The server calls an `AirlineIdentityModerator`
after shared validation. Its default accepts everything structurally valid; M13-10 supplies
policy later. A rejection identifies the field and reason.

A moderation rename updates the existing airline row, never replaces it. Schedules,
flights, results and future statistics reference the stable airline UUID, so historical
operations resolve to the **current** public name and callsign. The append-only admin audit
log preserves the old identity, new identity, actor and mandatory reason. We deliberately
do not copy an airline name into every operational row.

The force-rename service and admin API are a moderation remedy. Ordinary player editing is
the paid rebrand in ADR-0017, not a reuse of the admin route. It changes only the name,
callsign and base country; IATA and ICAO codes stay allocated until AIR-09 defines their
lifecycle.

## Consequences

### What this makes easier

- Client and server use one Zod contract and produce the same field-level failures.
- Players can use their own writing system without admitting invisible or pictographic
  leaderboard names.
- Moderation policy can change without changing deterministic validation or stored rows.
- A rename cannot orphan an airline's network, flights, money or reputation.
- The audit log answers what a moderated airline used to be called and why it changed.

### What this makes harder

- A historical flight does not automatically show the airline name used on that date. A
  future feature wanting period-accurate branding must read identity-change audit history
  or add a purpose-built identity timeline.
- Callsigns exclude otherwise valid non-Latin display text.
- JavaScript and PostgreSQL do not share identical Unicode character-class syntax. The
  shared schema is authoritative; database checks provide length, spacing, control-character
  and exact callsign defence for writes that bypass the API.

### What we accept

The permissive moderation default is not a policy and does not stop offensive but
structurally valid text. That gap is explicit and remains owned by M13-10 rather than being
hidden in an undocumented word list.

## Alternatives considered

| Option                                        | Why not                                                                                                   |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| ASCII-only names                              | Excludes legitimate player languages to simplify a display label.                                         |
| Allow every non-control Unicode character     | Admits emoji, invisible separators and confusing formatting into public names.                            |
| Snapshot the name on every flight and result  | Duplicates mutable display metadata across operational history before any period-accurate UI requires it. |
| Make force-rename the player rebrand endpoint | Bypasses §15's explicit event and cost and overlaps AIR-08.                                               |
| Add a built-in prohibited-word list           | That is moderation policy, explicitly out of AIR-02 and owned by M13-10.                                  |

## Revisit when

- M13-10 selects a moderation provider or policy whose inputs require more context;
- ADR-0017's player rebrand boundary needs another identity field;
- a public history surface requires period-accurate names or liveries rather than current
  identity; or
- AIR-09 decides that codes can change during an airline's lifetime.
