import { useMemo, useState } from 'react';

import type { CrewBaseView, CrewPoolView, CrewRank, CrewResponse } from '@tailfin/shared';

import { RANK_ORDER } from './crew-presentation';
import { CREW_RANK_LABEL } from './CrewRoleBanner';

import type { ReactNode } from 'react';

/**
 * Crew by base, then family, then rank (§9.2).
 *
 * ## Why the grouping is base first
 *
 * Because a crew base is where the money and the constraint live: hiring happens
 * at a base, the overhead is charged per base, and crew cannot be moved between
 * them. Grouping by family first would read better on a one-base airline and
 * would be the wrong shape the moment there are three.
 *
 * ## Empty combinations are not rendered
 *
 * A base × family × rank matrix is mostly zeroes and the zeroes carry no
 * information: an airline that has never hired a Cabin Service Manager for its
 * ATRs does not have a *gap*, it has a fleet with no widebodies in it. Only pools
 * that exist get a row. What is missing and *wanted* is the coverage table's job,
 * and it says so there.
 *
 * ## Filtering earns its place at the third base, not the first
 *
 * The controls are present but stay out of the way — a select and a checkbox, no
 * panel. "Shortages only" is the one that matters and it is the one a player
 * with forty pools will reach for; the rest is scannable without help until then.
 */

export interface CrewBaseTableProps {
  crew: CrewResponse;
  selectedKey: string | null;
  onSelect: (selection: { baseId: string; family: string; rank: CrewRank }) => void;
}

export function poolKey(baseId: string, family: string, rank: CrewRank): string {
  return `${baseId}/${family}/${rank}`;
}

interface Group {
  base: CrewBaseView;
  families: { family: string; pools: readonly CrewPoolView[] }[];
}

export function CrewBaseTable({ crew, selectedKey, onSelect }: CrewBaseTableProps): ReactNode {
  const [baseFilter, setBaseFilter] = useState('all');
  const [familyFilter, setFamilyFilter] = useState('all');
  const [shortagesOnly, setShortagesOnly] = useState(false);

  /*
   * Which family/rank pairs the fleet is actually short of. Read from the
   * server's demand fold rather than recomputed — "short" is its rule, and a
   * filter that disagreed with the coverage table above would be worse than no
   * filter at all.
   */
  const shortKeys = useMemo(
    () =>
      new Set(
        crew.demand.rows.filter((row) => row.delta < 0).map((row) => `${row.family}/${row.rank}`),
      ),
    [crew.demand.rows],
  );

  const groups = useMemo<Group[]>(() => {
    const out: Group[] = [];
    for (const base of crew.bases) {
      if (baseFilter !== 'all' && base.id !== baseFilter) continue;

      const byFamily = new Map<string, CrewPoolView[]>();
      for (const pool of base.pools) {
        if (familyFilter !== 'all' && pool.family !== familyFilter) continue;
        if (shortagesOnly && !shortKeys.has(`${pool.family}/${pool.rank}`)) continue;
        const list = byFamily.get(pool.family) ?? [];
        list.push(pool);
        byFamily.set(pool.family, list);
      }
      if (byFamily.size === 0) continue;

      out.push({
        base,
        families: [...byFamily]
          .map(([family, pools]) => ({
            family,
            pools: [...pools].sort(
              (a, b) => RANK_ORDER.indexOf(a.rank) - RANK_ORDER.indexOf(b.rank),
            ),
          }))
          .sort((a, b) => a.family.localeCompare(b.family)),
      });
    }
    return out;
  }, [crew.bases, baseFilter, familyFilter, shortagesOnly, shortKeys]);

  const families = [...new Set(crew.bases.flatMap((base) => base.pools.map((p) => p.family)))].sort(
    (a, b) => a.localeCompare(b),
  );

  return (
    <section className="crew-panel" aria-labelledby="crew-bases-heading">
      <div className="crew-panel__head">
        <h2 className="crew-panel__title" id="crew-bases-heading">
          Crew by base
        </h2>
        <div className="crew-filters">
          <label>
            <span className="visually-hidden">Filter by base</span>
            <select
              value={baseFilter}
              onChange={(event) => {
                setBaseFilter(event.target.value);
              }}
            >
              <option value="all">All bases</option>
              {crew.bases.map((base) => (
                <option key={base.id} value={base.id}>
                  {base.airportIcao}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span className="visually-hidden">Filter by aircraft family</span>
            <select
              value={familyFilter}
              onChange={(event) => {
                setFamilyFilter(event.target.value);
              }}
            >
              <option value="all">All families</option>
              {families.map((family) => (
                <option key={family} value={family}>
                  {family}
                </option>
              ))}
            </select>
          </label>
          <label className="crew-filters__check">
            <input
              type="checkbox"
              checked={shortagesOnly}
              onChange={(event) => {
                setShortagesOnly(event.target.checked);
              }}
            />
            Shortages only
          </label>
        </div>
      </div>

      {crew.bases.length === 0 ? (
        <p className="crew__note">
          No crew bases yet. A base is where crew are hired and held — open one to start.
        </p>
      ) : groups.length === 0 ? (
        <p className="crew__note">Nothing matches those filters.</p>
      ) : (
        groups.map((group) => (
          <div className="crew-base" key={group.base.id}>
            <h3 className="crew-base__title">
              <span className="figure">{group.base.airportIcao}</span>
              {group.base.status === 'closed' && (
                <span className="crew-tag crew-tag--muted">closed</span>
              )}
            </h3>

            <table className="crew__table">
              <caption className="visually-hidden">Crew at {group.base.airportIcao}</caption>
              <thead>
                <tr>
                  <th scope="col">Rank</th>
                  <th scope="col">On strength</th>
                  <th scope="col">Training</th>
                  <th scope="col">On duty</th>
                  <th scope="col">Standby</th>
                  <th scope="col">Available</th>
                </tr>
              </thead>
              {group.families.map((family) => (
                <tbody key={family.family}>
                  <tr className="crew__group">
                    <th scope="colgroup" colSpan={6}>
                      <span className="figure">{family.family}</span>
                    </th>
                  </tr>
                  {family.pools.map((pool) => {
                    const key = poolKey(group.base.id, pool.family, pool.rank);
                    return (
                      <tr
                        key={pool.id}
                        aria-selected={selectedKey === key}
                        className={selectedKey === key ? 'crew__row crew__row--on' : 'crew__row'}
                      >
                        <th scope="row">
                          <button
                            type="button"
                            className="crew__rowbutton"
                            onClick={() => {
                              onSelect({
                                baseId: group.base.id,
                                family: pool.family,
                                rank: pool.rank,
                              });
                            }}
                          >
                            {CREW_RANK_LABEL[pool.rank]}
                          </button>
                        </th>
                        <td className="figure">{pool.headcount}</td>
                        <td className="figure">
                          {pool.unavailable === 0 ? '—' : pool.unavailable}
                        </td>
                        <td className="figure">{pool.onDuty === 0 ? '—' : pool.onDuty}</td>
                        <td className="figure">{pool.reserve === 0 ? '—' : pool.reserve}</td>
                        <td className="figure">{pool.available}</td>
                      </tr>
                    );
                  })}
                </tbody>
              ))}
            </table>
          </div>
        ))
      )}
    </section>
  );
}
