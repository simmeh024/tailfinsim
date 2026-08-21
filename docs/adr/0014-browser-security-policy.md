# ADR-0014: Caddy-owned browser security policy

- **Status:** Accepted
- **Date:** 2026-08-20
- **Deciders:** Tailfin maintainers

## Context

Tailfin serves a React application, static assets and the Fastify API through one Caddy
origin. Google sign-in leaves Tailfin through a top-level redirect and returns to the same
origin; signed-in players may display profile images hosted at
`https://lh3.googleusercontent.com`. M6 will add player-authored liveries and cabins that
other players can see, increasing the consequence of a stored cross-site-scripting bug.

The edge already supplied one-year HSTS with `includeSubDomains`, `nosniff`, a strict-origin
referrer policy and removal of the `Server` header. It did not constrain scripts, framing
or browser capabilities. [SEC-HARD-05](https://github.com/simmeh024/tailfinsim/issues/253)
requires those gaps to be closed without breaking sign-in or avatars.

## Decision

Caddy owns one browser-security header set for production and dev, including static files,
API responses and errors. The enforced Content Security Policy is:

```text
default-src 'self';
script-src 'self';
style-src 'self' 'sha256-ftYZ6VWMqcx4KWcJ2/G2tKyA+X9oEaozaSrupOVb8KM=';
img-src 'self' data: https://lh3.googleusercontent.com;
connect-src 'self';
frame-ancestors 'none';
form-action 'self';
base-uri 'none';
object-src 'none'
```

`X-Frame-Options: DENY` also protects the report-only phase and older clients.
`Permissions-Policy` denies camera, microphone, geolocation, payment, USB and the other
unused powerful browser features listed in `deploy/Caddyfile`.
The sole style hash permits the holding page's exact inline stylesheet without allowing any
other inline style. The running-server verifier recomputes it, so editing that stylesheet
requires an intentional policy update rather than producing a silently broken front door.

The first live installation must set Caddy's `TAILFIN_CSP_HEADER` environment variable to
`Content-Security-Policy-Report-Only`. The operator checks real dev sign-in, the signed-in
shell and Google avatar, and inspects the browser for legitimate violations before removing
that override. With no override, the committed default is `Content-Security-Policy`.
The runbook makes both phases and their running-server assertions explicit.

HSTS remains `max-age=31536000; includeSubDomains` **without `preload`**. Tailfin already
commits its current subdomains to HTTPS, but browser preload lists persist beyond an
ordinary configuration rollback and would constrain every future subdomain before the
planned multi-node topology and recovery procedure are settled. Preload adds little to an
already-HSTS pre-launch service and creates a recovery cost the project cannot yet justify.

## Consequences

### What this makes easier

- An injected script cannot load arbitrary code or connect to another origin under the
  enforced policy.
- A hostile site cannot frame Tailfin, including while CSP is still report-only.
- One Caddy snippet and one integration check keep both hosts and all response types aligned.
- Google avatars have one narrow external image exception; OAuth itself needs none because it
  is a navigation rather than a framed or scripted integration.

### What this makes harder

- Any future external image, API, font, worker or embedded content needs a reviewed policy
  change before it works.
- A Caddyfile change is not delivered by the application deploy scripts; the operator must
  install and reload edge configuration separately.
- The real OAuth/avatar proof depends on the browser harness tracked by E2E-03/E2E-04, or a
  manual signed-in dev session during the first rollout.

### What we accept

The policy is a mitigation, not an input-sanitisation boundary. Tailfin must still treat
player-authored content as untrusted. Report-only violations are observed in the browser
during this pre-launch rollout rather than sent to a public collection endpoint; adding an
unauthenticated report receiver would itself add an abuse and retention surface.

## Alternatives considered

| Option                          | Why not                                                                                                           |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Fastify/Helmet owns the headers | Static and edge-generated error responses could differ, while Caddy already owns the existing header set.         |
| Allow inline scripts or styles  | The production Vite bundle has no need for them; weakening the policy pre-emptively would discard most CSP value. |
| Allow all Google origins        | Sign-in is a top-level redirect. Only the exact avatar image host needs a resource exception.                     |
| Add HSTS `preload` now          | Preload is slow to reverse and constrains future subdomains without a meaningful current gain.                    |

## Revisit when

- Tailfin intentionally adds an external resource, worker, framed surface or browser feature.
- CSP violations need fleet-wide collection rather than a controlled rollout check.
- The multi-node topology and HTTPS recovery procedure are settled and the operator is ready
  to submit every Tailfin subdomain to browser preload lists.
