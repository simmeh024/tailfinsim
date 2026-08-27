/**
 * The C-Suite roster (§9.1 follow-up, Phase 2).
 *
 * The executive floor's people. The identity, tier and **salary** come from the
 * shared {@link EXECUTIVE_CANDIDATES} catalogue — the same the server bills from —
 * so the number on the card is the number on the ledger. The client's own part is
 * the **portrait**, keyed by candidate id so the real faces can drop in one at a
 * time as they arrive; every id without a real portrait yet shows a placeholder
 * silhouette.
 *
 * Unlike the ground-floor roster, there is no role grouping: an executive office
 * is generic, any candidate fits any office, so this is a single flat market. The
 * roles and their gameplay effects land later, keyed by the same ids.
 */

import { EXECUTIVE_CANDIDATES, type ExecutiveCandidate } from '@tailfin/shared';

import placeholder from './assets/portraits/csuite-placeholder.svg';

export interface CSuiteCandidate extends ExecutiveCandidate {
  /** Portrait, imported so a missing file is a build error. Placeholder for now. */
  portrait: string;
}

/**
 * Real portraits by candidate id. Empty until the art arrives; add an id → import
 * here and that one face replaces its placeholder, nothing else changes.
 */
const PORTRAITS: Readonly<Record<string, string>> = {};

/** The market, in catalogue order, each with its portrait (placeholder until set). */
export const CSUITE_CANDIDATES: readonly CSuiteCandidate[] = EXECUTIVE_CANDIDATES.map(
  (candidate) => ({ ...candidate, portrait: PORTRAITS[candidate.id] ?? placeholder }),
);
