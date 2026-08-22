# Third-party notices

Tailfin's own source code is licensed under the GNU Affero General Public
License v3.0 — see [`LICENSE`](LICENSE). Its documentation is reserved — see
[`docs/LICENSE`](docs/LICENSE).

Neither of those licences applies to third-party material. This file records
what Tailfin depends on, and on what terms, so that adopting a copyleft licence
does not accidentally read as a claim over somebody else's work.

Checked against the dependency graph on 22 August 2026, at the commit that
introduced this file.

## Dependencies

Tailfin declares no runtime dependency of its own beyond the workspace packages;
everything below arrives through the lockfile. `pnpm-lock.yaml` is the exact
record, and `pnpm licenses list` reproduces this table.

| Licence       | Packages | Compatible with AGPL-3.0                                                                                                                                                                  |
| ------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MIT           | 258      | Yes — permissive                                                                                                                                                                          |
| Apache-2.0    | 18       | Yes, one-way: Apache-2.0 code may be combined into an AGPL-3.0 work. Includes `typescript` and `drizzle-orm`                                                                              |
| ISC           | 15       | Yes — permissive                                                                                                                                                                          |
| BSD-3-Clause  | 10       | Yes — permissive                                                                                                                                                                          |
| BSD-2-Clause  | 8        | Yes — permissive                                                                                                                                                                          |
| BlueOak-1.0.0 | 5        | Yes — permissive                                                                                                                                                                          |
| MIT-0         | 2        | Yes — permissive                                                                                                                                                                          |
| MPL-2.0       | 2        | Yes. `lightningcss` and its Windows binary, both build-time only. MPL-2.0 §3.3 permits combination with a secondary licence, and neither is marked "Incompatible With Secondary Licenses" |
| CC0-1.0       | 1        | Yes. `mdn-data`, a public-domain dedication                                                                                                                                               |

**No dependency is copyleft, and none is licence-incompatible.** That is worth
stating plainly, because the usual objection to adopting the AGPL is that some
dependency will not permit it, and here none does.

Two notes on the compatibility column. Apache-2.0 is compatible with GPLv3 and
AGPLv3 but not with GPLv2 — Tailfin is on v3, so this does not arise. And the
direction of Apache-2.0 compatibility is one-way: Apache-2.0 code can be
included in an AGPL work, not the reverse.

Each package's own licence text ships inside its own directory under
`node_modules`, which is where the authoritative copy lives; this table is a
summary and does not replace it.

## Data

### OurAirports

Airport, runway and country data comes from the OurAirports dataset, which is
**public domain**.

It is deliberately **not committed to this repository**. `data/ourairports/fetch.ts`
downloads it at import time and records only the SHA-256 of exactly what was
imported, into `dataset_version`. The reasoning is in that file: ~17 MB of
third-party data that changes weekly would be both heavy and stale in git.

The practical consequence for licensing is a clean one: there is no third-party
dataset inside this repository for the AGPL to be mistaken as covering. What is
committed is Tailfin's own importer, classifier and derived-index code, which is
Tailfin's work and is AGPL-licensed like the rest.

Derived values — tier classification, catchment population, the packed
great-circle distance matrix — are computed by Tailfin's code from public-domain
inputs and are Tailfin's own output.

## Aircraft designations and manufacturer names

Aircraft type designations and manufacturer names appear in the catalogue as
statements of fact. App. C.1 of the design document states the position and the
repository follows it literally:

> _Ship type names and specs; don't ship Boeing's or Airbus's marks._

There is no manufacturer logo, trade dress or house livery anywhere in this
repository. Type designations are factual and are used descriptively; no
affiliation with or endorsement by any manufacturer is claimed or implied.

## Fonts and external assets

None. The client uses system font stacks by deliberate choice, and the
Content-Security-Policy is `default-src 'self'` — no font host, no CDN, no
third-party script or stylesheet. There is no bundled font, icon set or image
library whose terms would need recording here.

## Keeping this true

This file is a claim about the dependency graph, and a claim can go stale. It
should be re-checked when a dependency is added, and `pnpm licenses list` is the
command that does it. A dependency under a licence not in the table above needs
a decision before it lands, not after.

Dependency Review already blocks a pull request that adds a known-vulnerable
package; it does **not** check licences, and nothing currently does. If that
becomes worth automating, the SBOM work in
[SEC-HARD-25](https://github.com/simmeh024/tailfinsim/issues/273) is the natural
vehicle rather than a separate check.
