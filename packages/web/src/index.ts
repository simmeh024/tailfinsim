/**
 * `@tailfin/web` — the browser client.
 *
 * Vite + React, the app shell from App. H.4 and the theme tokens land in
 * M0-09. The deck.gl world renderer with the flat-map/globe toggle is M7-01.
 *
 * Note the dependency list: the client talks to the server over the API and
 * never imports `@tailfin/sim`. Simulation maths stays server-authoritative.
 */

import { SHARED_SCHEMA_VERSION } from '@tailfin/shared';

/** Placeholder until M0-09 stands up the Vite app. */
export const CLIENT_SCHEMA_VERSION = SHARED_SCHEMA_VERSION;
