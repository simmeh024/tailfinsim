import { useState } from 'react';

import type { CrewMemberView, CrewRosterResponse, SkillBranch } from '@tailfin/shared';

import { StateBlock } from '../ui/StateBlock';

import { CREW_RANK_LABEL } from './CrewRoleBanner';

import type { ReactNode } from 'react';

/**
 * §10.5's roster board and pilot card (M9-03).
 *
 * > *"**Roster board:** filter and sort crew by level, type rating, branch,
 * > base… **Pilot card:** portrait, hours, types, skill tree, career history."*
 *
 * The card is the board's selected row rather than a second page, because they
 * are two views of one list and a route per pilot would be a navigation for data
 * already in hand.
 *
 * ## Every class here is one the crew page already declares
 *
 * `operations-ui.test.tsx` fails the build on a `className` the stylesheets do
 * not carry, and the reason is worth repeating: a page with its own `.crew-pips`
 * looks fine in jsdom and is a second vocabulary in the product. So the tree is
 * built from `crew-bars`, the tags from `crew-tag`, and the tables from
 * `crew__table` — the same components the coverage and morale panels use.
 *
 * ## The empty state is the interesting one
 *
 * Naming happens eight levels in, so **most airlines see nothing here for
 * weeks**, and an empty table with no explanation reads as a broken page. The
 * `StateBlock` says which of the two it is, and what earns a name. On a node
 * with no worker it is permanent, which is the same trap every §9 and §10
 * surface carries.
 *
 * ## No portrait
 *
 * §10.5 asks for one. There is no asset pipeline for pictures of people — the
 * livery and aircraft pipelines are for aeroplanes — so inventing one here would
 * be a VIS-shaped decision taken inside a crew page. The card leads with the
 * name and rank instead, and the absence is recorded rather than approximated.
 */

/** The four §10.4 ceilings a skill point can reach, in the order the page shows them. */
const CEILING_LABEL: Record<string, string> = {
  fuelBurn: 'Fuel burn',
  turnaroundTime: 'Turnaround',
  maintenanceCost: 'Maintenance cost',
  incidentRate: 'Incidents and delays',
};

export const BRANCH_LABEL: Record<SkillBranch, string> = {
  performance_fuel: 'Performance & Fuel',
  handling_safety: 'Handling & Safety',
  command_leadership: 'Command & Leadership',
  type_mastery: 'Type Mastery',
  service: 'Service',
  safety: 'Safety',
  leadership: 'Leadership',
};

const CABIN_RANKS = new Set(['cabin_crew', 'senior_cabin_crew', 'purser', 'cabin_service_manager']);

const PILOT_TREE: readonly SkillBranch[] = [
  'performance_fuel',
  'handling_safety',
  'command_leadership',
  'type_mastery',
];
const CABIN_TREE: readonly SkillBranch[] = ['service', 'safety', 'leadership'];

function percent(fraction: number): string {
  return `${(fraction * 100).toFixed(1)}%`;
}

export interface CrewRosterProps {
  roster: CrewRosterResponse | null;
  loading: boolean;
  failed: boolean;
  onSpend: (memberId: string, branch: SkillBranch) => void;
  /** The member whose spend is in flight, so its controls can be disabled. */
  pendingMemberId: string | null;
}

export function CrewRoster({
  roster,
  loading,
  failed,
  onSpend,
  pendingMemberId,
}: CrewRosterProps): ReactNode {
  const [selectedId, setSelectedId] = useState<string | null>(null);

  if (loading || failed || roster === null) {
    return (
      <section className="crew-panel" aria-labelledby="crew-roster-heading">
        <div className="crew-panel__head">
          <h2 className="crew-panel__title" id="crew-roster-heading">
            Roster board
          </h2>
        </div>
        <StateBlock kind={loading ? 'loading' : 'broken'}>
          {loading ? 'Reading the roster…' : 'The roster could not be read.'}
        </StateBlock>
      </section>
    );
  }

  const selected =
    roster.members.find((member) => member.id === selectedId) ?? roster.members[0] ?? null;

  return (
    <section className="crew-panel" aria-labelledby="crew-roster-heading">
      <div className="crew-panel__head">
        <h2 className="crew-panel__title" id="crew-roster-heading">
          Roster board
        </h2>
        <p className="crew-panel__sub">
          Crew who reach level {roster.namedFromLevel} are named and tracked individually. Their
          points make the airline cheaper and faster — never more popular.
        </p>
      </div>

      {roster.members.length === 0 ? (
        <StateBlock kind="empty">
          No crew have reached level {roster.namedFromLevel} yet. Crew earn experience on every
          flight, and harder sectors — difficult airfields, bad weather, night arrivals, long
          oceanic legs — earn it faster.
        </StateBlock>
      ) : (
        <div className="crew-stack">
          <table className="crew__table">
            <caption className="visually-hidden">Named crew, by level</caption>
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Rank</th>
                <th scope="col">Base</th>
                <th scope="col">Type</th>
                <th scope="col" className="figure">
                  Level
                </th>
                <th scope="col">Points</th>
              </tr>
            </thead>
            <tbody>
              {roster.members.map((member) => (
                <tr key={member.id}>
                  <th scope="row">
                    <button
                      type="button"
                      className="crew__rowbutton"
                      aria-pressed={selected?.id === member.id}
                      onClick={() => {
                        setSelectedId(member.id);
                      }}
                    >
                      {member.name}
                    </button>
                  </th>
                  <td>{CREW_RANK_LABEL[member.rank]}</td>
                  <td>{member.airportIcao}</td>
                  <td>{member.family}</td>
                  <td className="figure">{member.level}</td>
                  <td>
                    {member.unspentPoints > 0 ? (
                      <span className="crew-tag">{member.unspentPoints} unspent</span>
                    ) : (
                      <span className="crew-tag crew-tag--muted">all spent</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {selected !== null && (
            <PilotCard
              member={selected}
              operatedFamilies={roster.operatedFamilies}
              maxPoints={Math.max(1, ...roster.branches.map((branch) => branch.maxPoints))}
              onSpend={onSpend}
              pending={pendingMemberId === selected.id}
            />
          )}
        </div>
      )}

      <div className="crew-panel__head">
        <h3 className="crew-panel__title" id="crew-boosts-heading">
          What the roster is worth
        </h3>
        <p className="crew-panel__sub">
          Stacked across every named crew member and capped at the design ceiling. Diminishing
          returns before the cap, so the tenth veteran is worth less than the first.
        </p>
      </div>
      <table className="crew__table" aria-labelledby="crew-boosts-heading">
        <thead>
          <tr>
            <th scope="col">Efficiency</th>
            <th scope="col" className="figure">
              Now
            </th>
            <th scope="col" className="figure">
              Ceiling
            </th>
            <th scope="col">Contributors</th>
          </tr>
        </thead>
        <tbody>
          {roster.boosts.map((boost) => (
            <tr key={boost.ceiling}>
              <th scope="row">{CEILING_LABEL[boost.ceiling] ?? boost.ceiling}</th>
              <td className="figure">
                {boost.fraction > 0 ? `−${percent(boost.fraction)}` : '—'}{' '}
                {boost.capped && <span className="crew-tag crew-tag--short">at ceiling</span>}
              </td>
              <td className="figure">−{percent(boost.maxFraction)}</td>
              <td>
                {boost.contributors === 0 ? 'nobody yet' : `${String(boost.contributors)} crew`}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

interface PilotCardProps {
  member: CrewMemberView;
  operatedFamilies: readonly string[];
  maxPoints: number;
  onSpend: (memberId: string, branch: SkillBranch) => void;
  pending: boolean;
}

/** §10.5's pilot card: who they are, what they have done, and what they may become. */
function PilotCard({
  member,
  operatedFamilies,
  maxPoints,
  onSpend,
  pending,
}: PilotCardProps): ReactNode {
  const tree = CABIN_RANKS.has(member.rank) ? CABIN_TREE : PILOT_TREE;

  return (
    <div className="crew-base" aria-label={`${member.name}, ${CREW_RANK_LABEL[member.rank]}`}>
      <h4 className="crew-base__title">
        {member.name} · {CREW_RANK_LABEL[member.rank]} · {member.family} · {member.airportIcao}
      </h4>

      <table className="crew__table">
        <caption className="visually-hidden">Career history</caption>
        <tbody>
          <tr>
            <th scope="row">Level</th>
            <td className="figure">{member.level}</td>
            <th scope="row">Block hours</th>
            <td className="figure">{member.career.blockHours.toFixed(1)}</td>
          </tr>
          <tr>
            <th scope="row">Sectors</th>
            <td className="figure">{member.career.sectors}</td>
            <th scope="row">Incidents handled</th>
            <td className="figure">{member.career.incidentsHandled}</td>
          </tr>
          <tr>
            <th scope="row">Types</th>
            <td>{member.career.typesFlown.join(', ') || '—'}</td>
            <th scope="row">To next level</th>
            <td className="figure">
              {member.xpToNextLevel === null
                ? 'at ceiling'
                : `${member.xpToNextLevel.toLocaleString('en-US')} XP`}
            </td>
          </tr>
        </tbody>
      </table>

      <p className="crew__note">
        Skill tree
        {member.unspentPoints > 0 && (
          <>
            {' '}
            <span className="crew-tag">{member.unspentPoints} unspent</span>
          </>
        )}
      </p>
      <div className="crew-bars">
        {tree.map((branch) => {
          const spent = member.spent[branch] ?? 0;
          const inert = branch === 'type_mastery' && !member.typeMasteryActive;
          const full = spent >= maxPoints;
          return (
            <button
              key={branch}
              type="button"
              className="crew-bars__row"
              disabled={pending || member.unspentPoints === 0 || full}
              onClick={() => {
                onSpend(member.id, branch);
              }}
            >
              <span className="crew-bars__value">
                {BRANCH_LABEL[branch]}
                {inert && (
                  <>
                    {' '}
                    <span className="crew-tag crew-tag--muted">inert</span>
                  </>
                )}
              </span>
              <span className="crew-bars__track">
                <span
                  className="crew-bars__fill"
                  style={{ width: `${String((spent / maxPoints) * 100)}%` }}
                />
              </span>
              <span className="crew-bars__value figure">
                {spent}/{maxPoints}
              </span>
            </button>
          );
        })}
      </div>

      {!member.typeMasteryActive && (member.spent.type_mastery ?? 0) > 0 && (
        <p className="crew__note">
          Type Mastery is inert: this airline operates{' '}
          {operatedFamilies.length === 0 ? 'no aircraft' : operatedFamilies.join(', ')}, not{' '}
          {member.family}. The points are kept, not refunded — buy the family back and they work
          again.
        </p>
      )}
    </div>
  );
}
