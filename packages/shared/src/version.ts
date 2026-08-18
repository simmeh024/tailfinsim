import { z } from 'zod';

/**
 * Build identity (M0-12).
 *
 * Every environment answers "which build am I?" so that dev being ahead of
 * production is visible rather than inferred. The client renders this in the
 * corner; a bug report that quotes a build number is worth far more than one
 * that says "the live site".
 */

/**
 * Which deployment this is, in human terms.
 *
 * Distinct from `NODE_ENV`, which is `production` on **both** boxes — dev runs a
 * production build of the same code, and that is the point. `NODE_ENV` says how
 * the code was compiled; this says which door you came in.
 */
export const EnvironmentLabel = z.enum(['local', 'dev', 'production']);
export type EnvironmentLabel = z.infer<typeof EnvironmentLabel>;

export const VersionResponse = z.object({
  /**
   * `git rev-list --count HEAD` at build time — a plain increasing integer.
   *
   * Chosen over a semantic version because nothing here is released to anyone:
   * there is no API to promise compatibility with, and a hand-maintained version
   * would drift the first time someone forgot to bump it. `0` means the build
   * ran without git metadata (a working tree, usually).
   */
  build: z.number().int().nonnegative(),
  /** Short commit SHA, so a build number can be traced to a diff. */
  commit: z.string(),
  environment: EnvironmentLabel,
  /** When this process started, for spotting a box that quietly restarted. */
  startedAt: z.iso.datetime(),

  /**
   * The server's clock at the moment of the request.
   *
   * The *server's*, deliberately — a badge showing the browser's clock would be
   * showing the viewer's own machine, which is the one thing they can already
   * see. The point is to know what the box thinks the time is, which is what
   * every log line and every scheduled event is stamped against.
   */
  serverTime: z.iso.datetime(),
});
export type VersionResponse = z.infer<typeof VersionResponse>;
