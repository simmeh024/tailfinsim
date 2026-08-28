/**
 * The C-Suite roster (§9.1 follow-up, Phase 2/3).
 *
 * The executive floor's people. The identity, tier, **role**, **salary** and the
 * standing **boost** come from the shared {@link EXECUTIVE_CANDIDATES} catalogue —
 * the same the server bills from and the worker will apply the boosts from — so
 * the number on the card is the number on the ledger. The client's own part is
 * the **portrait**, keyed by candidate id, imported so a missing file is a build
 * error rather than a broken image at runtime.
 *
 * Unlike the ground-floor roster, there is no role grouping: an executive office
 * is generic, any candidate fits any office, so this is a single flat market. The
 * page shows a rotating ten of them at a time — see {@link rotatingExecutiveRoster}.
 */

import { EXECUTIVE_CANDIDATES, type ExecutiveCandidate } from '@tailfin/shared';

import csuite01 from './assets/portraits/csuite-01.webp';
import csuite02 from './assets/portraits/csuite-02.webp';
import csuite03 from './assets/portraits/csuite-03.webp';
import csuite04 from './assets/portraits/csuite-04.webp';
import csuite05 from './assets/portraits/csuite-05.webp';
import csuite06 from './assets/portraits/csuite-06.webp';
import csuite07 from './assets/portraits/csuite-07.webp';
import csuite08 from './assets/portraits/csuite-08.webp';
import csuite09 from './assets/portraits/csuite-09.webp';
import csuite10 from './assets/portraits/csuite-10.webp';
import csuite11 from './assets/portraits/csuite-11.webp';
import csuite12 from './assets/portraits/csuite-12.webp';
import csuite13 from './assets/portraits/csuite-13.webp';
import csuite14 from './assets/portraits/csuite-14.webp';
import csuite15 from './assets/portraits/csuite-15.webp';
import csuite16 from './assets/portraits/csuite-16.webp';
import csuite17 from './assets/portraits/csuite-17.webp';
import csuite18 from './assets/portraits/csuite-18.webp';
import csuite19 from './assets/portraits/csuite-19.webp';
import csuite20 from './assets/portraits/csuite-20.webp';
import csuite21 from './assets/portraits/csuite-21.webp';
import csuite22 from './assets/portraits/csuite-22.webp';
import csuite23 from './assets/portraits/csuite-23.webp';
import csuite24 from './assets/portraits/csuite-24.webp';
import placeholder from './assets/portraits/csuite-placeholder.svg';

export interface CSuiteCandidate extends ExecutiveCandidate {
  /** Portrait, imported so a missing file is a build error. */
  portrait: string;
}

/** Real portraits by candidate id; a placeholder silhouette covers any gap. */
const PORTRAITS: Readonly<Record<string, string>> = {
  'csuite-01': csuite01,
  'csuite-02': csuite02,
  'csuite-03': csuite03,
  'csuite-04': csuite04,
  'csuite-05': csuite05,
  'csuite-06': csuite06,
  'csuite-07': csuite07,
  'csuite-08': csuite08,
  'csuite-09': csuite09,
  'csuite-10': csuite10,
  'csuite-11': csuite11,
  'csuite-12': csuite12,
  'csuite-13': csuite13,
  'csuite-14': csuite14,
  'csuite-15': csuite15,
  'csuite-16': csuite16,
  'csuite-17': csuite17,
  'csuite-18': csuite18,
  'csuite-19': csuite19,
  'csuite-20': csuite20,
  'csuite-21': csuite21,
  'csuite-22': csuite22,
  'csuite-23': csuite23,
  'csuite-24': csuite24,
};

/** The whole roster, in catalogue order, each with its portrait. */
export const CSUITE_CANDIDATES: readonly CSuiteCandidate[] = EXECUTIVE_CANDIDATES.map(
  (candidate) => ({ ...candidate, portrait: PORTRAITS[candidate.id] ?? placeholder }),
);

/** The candidate with this id, or undefined — used to render a hire not in today's ten. */
export function csuiteCandidate(id: string): CSuiteCandidate | undefined {
  return CSUITE_CANDIDATES.find((candidate) => candidate.id === id);
}
