TAILFIN — MVP BACKLOG (125 issues, 14 milestones)
=================================================

You need a GitHub token first:
  https://github.com/settings/tokens
  Either a CLASSIC token with the "repo" scope,
  or a FINE-GRAINED token on simmeh024/tailfinsim with:
      Issues:   Read and write
      Metadata: Read

Then pick whichever of these works on your machine.
All three are idempotent — safe to re-run if one stops partway.

--------------------------------------------------
OPTION 1 — PowerShell (no extra software needed)
--------------------------------------------------
Open PowerShell in this folder:

    powershell -ExecutionPolicy Bypass -File .\create-issues.ps1

It will prompt for the token.

--------------------------------------------------
OPTION 2 — Python 3.7+ (works on any OS)
--------------------------------------------------
    python create_issues.py

Uses only the standard library. Prompts for the token.

--------------------------------------------------
OPTION 3 — gh CLI + jq (what you tried first)
--------------------------------------------------
Install them, then:

    winget install GitHub.cli
    winget install jqlang.jq
    # restart the terminal, then:
    gh auth login
    bash create-issues.txt simmeh024/tailfinsim

--------------------------------------------------
FILES
--------------------------------------------------
  issues.json        the 125 issues (title, body, labels, milestone)
  create-issues.ps1  PowerShell runner
  create_issues.py   Python runner
  create-issues.txt  bash + gh + jq runner
  BACKLOG.md         human-readable index and suggested build order

BEFORE YOU RUN: commit the design doc to docs/tailfin-design-doc.md
in the repo — every issue references that path.
