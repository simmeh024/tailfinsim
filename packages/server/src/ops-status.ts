import { collectStatus, renderStatus } from './ops/status';

/**
 * `pnpm ops:status` — what is deployed where (OPS-02).
 *
 * Answers, without an SSH session:
 *
 *   - what production is running, and how far behind `main` it is
 *   - what dev is running, and whether it is on something unmerged
 *   - when each was deployed, as distinct from when it last restarted
 *
 * Reads nothing but public HTTP: two `/api/version` endpoints and the GitHub
 * API. It needs no credentials, no VPN and no database, which is what makes it
 * runnable from a laptop at the moment somebody is wondering whether a deploy
 * landed.
 *
 * `GITHUB_TOKEN` is optional and only raises the rate limit. Do not add one to
 * make this work — if it fails without a token, that is a bug in this file.
 *
 * **Always exits zero**, including when it reports problems. Drift is the normal
 * state this tool exists to show, not a failure of the tool, and a non-zero exit
 * makes `pnpm` print a recursive-run error block over the top of the answer —
 * which is worst exactly when the answer matters. A later automated consumer
 * (OPS-17, OPS-18) should add an explicit `--exit-code` flag rather than change
 * this default underneath the human use.
 */

const status = await collectStatus({
  fetch: globalThis.fetch,
  githubToken: process.env.GITHUB_TOKEN,
});

process.stdout.write(`${renderStatus(status, new Date())}\n`);
