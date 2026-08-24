import type { CrewRank, CrewResponse } from '@tailfin/shared';

import { coverageSummary, familyCoverage, headcountSummary } from './crew-presentation';
import { CrewReadiness } from './CrewReadiness';
import { CREW_RANK_LABEL } from './CrewRoleBanner';

import type { ReactNode } from 'react';

/**
 * Coverage and readiness, as one thing (M5-01, M5-02).
 *
 * They were two panels saying the same thing at different resolutions: a ring
 * that read *"100% covered"* and, beside it, a table showing which ranks were
 * short. Both were right and the pair was confusing, because the ring is the
 * table's own summary and putting them side by side invited the reader to
 * compare two views of one number instead of reading one.
 *
 * ## What "covered" means, and the sentence that has to stay
 *
 * Required is **one departure per aeroplane owned** — a floor, not a roster. A
 * single aircraft flying a day of rotations needs several crews, and working out
 * how many is duty-aware rostering, which does not exist. Duty and rest are
 * modelled as of M5-02, but *rosters* are not, so the floor is still a floor.
 *
 * The heading therefore says **minimum requirement**, never "all flights
 * covered today". The longer explanation sits in the caption rather than in a
 * tooltip, because it is the difference between a number a player can act on and
 * one that quietly overstates itself.
 */

export interface CrewCoverageProps {
  crew: CrewResponse;
  /** `family/rank`, or null. Kept by the page so the panel and table agree. */
  selectedKey: string | null;
  onSelect: (selection: { family: string; rank: CrewRank }) => void;
}

export function coverageKey(family: string, rank: CrewRank): string {
  return `${family}/${rank}`;
}

export function CrewCoverage({ crew, selectedKey, onSelect }: CrewCoverageProps): ReactNode {
  const coverage = coverageSummary(crew);
  const heads = headcountSummary(crew);
  const families = familyCoverage(crew);

  return (
    <section className="crew-panel" aria-labelledby="crew-coverage-heading">
      <div className="crew-panel__head">
        <h2 className="crew-panel__title" id="crew-coverage-heading">
          Crew coverage
        </h2>
        <p className="crew-panel__sub">Minimum requirement, by family and rank</p>
      </div>

      <CrewReadiness
        available={heads.available}
        inTraining={heads.inTraining}
        required={coverage.totalRequired}
        met={coverage.metRequired}
        covered={coverage.covered}
      />

      {families.length === 0 ? (
        <p className="crew__note">
          No aircraft and no crew yet. Coverage appears here once you own an aeroplane or hire
          somebody.
        </p>
      ) : (
        <table className="crew__table crew__table--coverage">
          <caption className="crew__caption">
            Required is <strong>one departure per aeroplane you own</strong> — a floor, not a
            roster. A single aircraft flying a day of rotations needs several crews; duty and rest
            are modelled, rostering is not.
          </caption>
          <thead>
            <tr>
              <th scope="col">Rank</th>
              <th scope="col">Required</th>
              <th scope="col">Available</th>
              <th scope="col">Training</th>
              <th scope="col">Balance</th>
            </tr>
          </thead>
          {families.map((group) => (
            <tbody key={group.family}>
              <tr className="crew__group">
                {/*
                 * A group heading inside the table rather than a table per
                 * family: one header row, one tab stop, and a screen reader
                 * reads "Family, A320neo" once instead of meeting a fresh table
                 * for every aeroplane type the airline owns.
                 */}
                <th scope="colgroup" colSpan={5}>
                  <span className="figure">{group.family}</span>
                  {group.short && <span className="crew-tag crew-tag--short">short</span>}
                </th>
              </tr>
              {group.rows.map((row) => {
                const key = coverageKey(group.family, row.rank);
                return (
                  <tr
                    key={key}
                    data-cover={row.status}
                    aria-selected={selectedKey === key}
                    className={selectedKey === key ? 'crew__row crew__row--on' : 'crew__row'}
                  >
                    <th scope="row">
                      {/*
                       * The whole row is the target, but the control is a real
                       * button: a `onClick` on the `<tr>` is unreachable by
                       * keyboard and invisible to assistive tech, and a row of
                       * cells is not a widget.
                       */}
                      <button
                        type="button"
                        className="crew__rowbutton"
                        onClick={() => {
                          onSelect({ family: group.family, rank: row.rank });
                        }}
                      >
                        {CREW_RANK_LABEL[row.rank]}
                        <span className="visually-hidden">
                          {' '}
                          on {group.family}: {balanceWords(row.status, row.delta)}
                        </span>
                      </button>
                    </th>
                    <td className="figure">{row.required}</td>
                    <td className="figure">{row.available}</td>
                    <td className="figure">{row.inTraining === 0 ? '—' : row.inTraining}</td>
                    <td>
                      {/* Glyph and text, never colour alone (App. H.7). */}
                      <span className="crew-delta" data-cover={row.status}>
                        <span aria-hidden="true">{GLYPH[row.status]}</span>{' '}
                        {row.status === 'exact'
                          ? 'Exact'
                          : row.delta > 0
                            ? `+${String(row.delta)}`
                            : String(row.delta)}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          ))}
        </table>
      )}
    </section>
  );
}

const GLYPH: Record<'short' | 'exact' | 'surplus', string> = {
  short: '▼',
  exact: '=',
  surplus: '▲',
};

/** What a screen reader hears instead of a coloured cell. */
function balanceWords(status: 'short' | 'exact' | 'surplus', delta: number): string {
  if (status === 'short') return `short ${String(Math.abs(delta))}`;
  if (status === 'surplus') return `${String(delta)} spare`;
  return 'exactly covered';
}
