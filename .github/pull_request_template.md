Closes #

<!-- One `Closes #<n>` per line. GitHub honours one issue per keyword, so
     "Closes #17 and #18" closes #17 and silently leaves #18 open. -->

<!-- The description goes here, and it is the point. Prose, with your own
     headings if it wants them — say why, not only what. PR #447 and #448 are
     the standard; neither would have been improved by being cut into a form. -->

---

<!-- Below the rule is a prompt, not a form. It asks only about the things that
     are invisible in the diff and that this repository has actually got wrong.

     One line each. Write "none" where there is nothing — that is a real answer,
     not a skipped question, and an untrue tick is worse than a blank.

     Keep it this short. Every incident will suggest a new section; adding one is
     a decision, not a reflex. -->

**Schema** —
<!-- none · or the migration's `expand` / `contract-safe-after #<issue>` header,
     and that the previous release still works against the result (ADR-0016). -->

**Runtime and deploy** —
<!-- none · or: web, worker or both; a new variable, unit or port; which node
     needs deploying and in which order. Only the web node migrates. -->

**Verified** —
<!-- What you ran, not what the repository has. `pnpm verify` prints a summary
     table — paste it, or name what failed and what skipped.
     If a PostgreSQL-backed suite ran, say **which database**: those suites are
     destructive by design, so the name is the safety claim, not a detail.
     If the change moves money or defends an invariant, this is where adversarial
     or mutation evidence goes. -->

**Changed only on the server** —
<!-- none · or: a grant, a world, a config, a row deleted by hand. Invisible in
     the diff, and lost to the next session if it is not written down here. -->

**Docs** —
<!-- none needed · or what changed alongside the behaviour. -->

**E2E coverage** —
<!-- player-facing: the critical happy-path journey and whether it joins nightly or the PR
     suite; non-player-facing: none. Keep calculations, permutations and implementation
     details in focused tests. See CONTRIBUTING.md. -->

Merging this stages a release. Production moves only when a human runs
`./deploy/deploy.sh` on the box.
