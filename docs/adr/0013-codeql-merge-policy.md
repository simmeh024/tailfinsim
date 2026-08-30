# ADR-0013: CodeQL blocks new high-risk findings after measured tuning

- **Status:** Accepted
- **Date:** 2026-08-20
- **Deciders:** @simmeh024
- **Constrains:** SEC-HARD-02, SEC-HARD-33, SEC-HARD-34 and pull-request protection

## Context

Tailfin's source is public and the database is the persistent game world. Review, strict
TypeScript and ESLint catch correctness and style; they do not systematically look for
injection, unsafe deserialisation, path traversal, prototype pollution or dangerous workflow
patterns.

SEC-HARD-02 first added advanced CodeQL scanning in a separate workflow. It analyses
JavaScript/TypeScript and GitHub Actions with the `security-extended` query suite on pull
requests, pushes to `main` and a weekly schedule. The initial period deliberately reported
without blocking so the analyser could be proved, its cost measured and its baseline read
before it became a gate.

ADR-0012 ranks the shared-world database, accounts and build/deployment control paths among
Tailfin's highest-value assets. CodeQL protects those assets from an internet attacker or
malicious player exploiting a dangerous code pattern that ordinary review missed.

## Evidence from the tuning period

The workflow ran from 2026-08-19 12:55 UTC through this decision on 2026-08-20. Repository
activity compressed substantially more observations than the original “couple of weeks”
estimate expected:

| Evidence                        | Observed result                                       |
| ------------------------------- | ----------------------------------------------------- |
| All workflow runs               | 84, all successful                                    |
| Pull-request runs               | 47 successful                                         |
| PR wall-clock                   | 1.05 min minimum · 1.25 min median · 1.77 min maximum |
| Languages                       | `javascript-typescript` and `actions`                 |
| Extracted query count on `main` | 103 JavaScript/TypeScript · 23 Actions                |
| Open baseline after triage      | 0                                                     |

The maximum observed PR run is well under SEC-HARD-02's six-minute budget and runs in
parallel with normal CI, so CodeQL does not extend the merge path when normal CI is slower.
The decision is based on the number and diversity of real changes read, not on leaving the
same scanner idle until a calendar date passes.

### The scanner was proved to bite

Throwaway [PR #286](https://github.com/simmeh024/tailfinsim/pull/286) planted deliberate
vulnerabilities and was closed without merging. CodeQL extracted the planted source and
raised critical `js/code-injection` alert #2 when a value from a `node:http` request reached
`eval()`. The branch was then deleted.

The canary also established a limitation: CodeQL did not model Fastify's `request.query` as
a remote-flow source, with or without installed dependencies. A clean CodeQL result is
therefore not evidence that Fastify inputs are validated. SEC-HARD-11's boundary validation
and SEC-HARD-33's security regression suite remain required, and this limitation is reviewed
when the CodeQL/Fastify model changes.

## Decision

### Keep the advanced workflow narrow and parallel

`.github/workflows/codeql.yml` remains separate from database-backed CI. It:

- analyses `javascript-typescript` and `actions` with `build-mode: none`;
- uses `security-extended`, not the noisy `security-and-quality` suite;
- does not install dependencies because the canary showed no additional Fastify modelling;
- runs on every PR to `main`, every push to `main`, and weekly at an off-hour time;
- grants `security-events: write` only to the analysis job; and
- has no path filter, because a required result that silently skips would leave a PR unable
  to merge.

### Protect `main` with severity thresholds

The active repository ruleset
[`CodeQL merge protection`](https://github.com/simmeh024/tailfinsim/rules/21107709)
targets the default branch and requires results from the `CodeQL` tool. It has no bypass
actors.

| CodeQL result                     | Merge policy             |
| --------------------------------- | ------------------------ |
| Standard alert: `error`           | **Blocks**               |
| Standard alert: `warning`         | Reported, does not block |
| Standard alert: `note`            | Recorded, does not block |
| Security alert: `critical`        | **Blocks**               |
| Security alert: `high`            | **Blocks**               |
| Security alert: `medium` or `low` | Reported, does not block |

This uses the ruleset's `alerts_threshold: errors` and
`security_alerts_threshold: high_or_higher`. Requiring the workflow jobs merely as status
checks would not enforce this policy: the canary analysis job itself completed successfully
while reporting a critical alert. The code-scanning ruleset evaluates the uploaded results.

A false positive may be dismissed only with evidence in the Security tab. A real finding
deferred to later work uses `won't fix` plus the tracking issue and a statement that the
dismissal does not declare the behavior safe. Do not weaken or disable the ruleset merely to
merge a PR.

### Baseline findings were read, not bulk-cleared

Four alerts existed on `main`. Each received an individual reason in GitHub's Security tab:

| Alert                         | Finding                                     | Decision                                                                                                                                                                                                                                                                                                 |
| ----------------------------- | ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #3 `actions/unpinned-tag`     | `pnpm/action-setup@v6` is mutable           | Real finding, deferred to the coordinated Actions pinning in SEC-HARD-24 (#272).                                                                                                                                                                                                                         |
| #4 `js/missing-rate-limiting` | Google OAuth callback has no rate limit     | **Addressed (M2-03 PR).** A global per-client-IP limit (`@fastify/rate-limit`, keyed on the `trustProxy`-resolved caller) now covers every route, the OAuth callback included; loopback is exempt. This is SEC-HARD-09's (#257) first tranche — the deeper proxy-trust hardening it names is still open. |
| #5 `js/http-to-file-access`   | GeoNames/World Bank response cached to disk | False positive for file-write control: an operator-only CLI uses fixed HTTPS sources and fixed filenames; network data cannot choose the path or become served/executed content. Body-size bounds remain SEC-HARD-30 (#278).                                                                             |
| #6 `js/http-to-file-access`   | OurAirports response cached to disk         | False positive for the same reason: fixed origin, allowlisted filenames and an operator-selected directory; cached CSV is parsed, not served or executed. Body-size bounds remain SEC-HARD-30 (#278).                                                                                                    |

The findings deferred rather than fixed remain work even though they are dismissed from the
CodeQL baseline — #3's Actions pinning still, and #4's deeper proxy-trust hardening now that
its rate-limit half has shipped. Dismissal prevents old findings from deadlocking every PR; it
does not erase their tracking issues.

## Consequences

- A pull request introducing a new high/critical security alert or standard-severity error
  cannot update `main`, including for repository admins.
- Every PR must produce CodeQL results, so a CodeQL/GitHub outage can pause merging. That is
  preferable to silently merging without the gate the repository claims to have.
- Medium, low, warning and note findings remain review signals without making routine noise a
  universal block.
- The GitHub ruleset is external state. This ADR and the workflow comments are its durable,
  reviewable description; any settings change must update them.
- CodeQL remains one layer. It does not replace validation, authorisation tests, dependency
  review or the security regression suite.

## Revisit when

- CodeQL adds or changes Fastify remote-flow modelling;
- SEC-HARD-09 or SEC-HARD-24 resolves a deferred baseline finding;
- a blocking false positive shows the chosen threshold is noisy;
- PR CodeQL wall-clock approaches six minutes; or
- SEC-HARD-34 changes the scheduled scanning strategy.
