import { useState } from 'react';

import type {
  CrewMemberView,
  CrewRosterResponse,
  SkillBranch,
  TrainingCaptainRefusal,
  TrainingCoverageView,
} from '@tailfin/shared';

import { formatUsdMinor } from '../currency/display';
import { Button } from '../ui/Button';
import { StateBlock } from '../ui/StateBlock';

import { CREW_RANK_LABEL } from './CrewRoleBanner';
import { TableScroll } from './TableScroll';

import type { CrewFailure } from './api';
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

/**
 * Why *"Make Training Captain"* is not offered, in words a player can act on
 * (M9-04). Null where saying anything would be noise: cabin crew never convert,
 * and a Training Captain's card offers the way back instead.
 *
 * *"Centre of Excellence (academy level 5)"* is §10.1's own table — the level
 * that names *"own Training Captains"* — rather than a balance number.
 */
export function convertRefusalText(
  refusal: TrainingCaptainRefusal,
  maxLevel: number,
): string | null {
  switch (refusal) {
    case 'not_flight_deck':
    case 'already_training_captain':
      return null;
    case 'not_command_rank':
      return 'Only a Captain can become a Training Captain.';
    case 'below_max_level':
      return `Reaches level ${String(maxLevel)} first — only a top-level pilot can train others.`;
    case 'no_academy':
      return 'Needs a Centre of Excellence (academy level 5) at this base.';
    case 'academy_level':
      return 'Needs a Centre of Excellence (academy level 5) at this base — the academy here has not reached it yet.';
  }
}

export interface CrewRosterProps {
  roster: CrewRosterResponse | null;
  loading: boolean;
  failed: boolean;
  onSpend: (memberId: string, branch: SkillBranch) => void;
  /** Make a member a Training Captain (`true`) or return them to the line (M9-04). */
  onTrainingCaptain: (memberId: string, designate: boolean) => void;
  /** The last Training Captain change the server refused, said on the card. */
  refusal: CrewFailure | null;
  /** The member whose change is in flight, so its controls can be disabled. */
  pendingMemberId: string | null;
}

export function CrewRoster({
  roster,
  loading,
  failed,
  onSpend,
  onTrainingCaptain,
  refusal,
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
          <TableScroll label="Named crew">
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
                    <td>
                      {CREW_RANK_LABEL[member.rank]}
                      {member.trainingCaptain.since !== null && (
                        <span className="crew-tag">
                          {member.rank === 'training_captain' ? 'designated' : 'Training Captain'}
                        </span>
                      )}
                    </td>
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
          </TableScroll>

          {selected !== null && (
            <PilotCard
              member={selected}
              operatedFamilies={roster.operatedFamilies}
              maxPoints={Math.max(1, ...roster.branches.map((branch) => branch.maxPoints))}
              maxLevel={roster.maxLevel}
              onSpend={onSpend}
              onTrainingCaptain={onTrainingCaptain}
              refusal={refusal}
              pending={pendingMemberId === selected.id}
            />
          )}
        </div>
      )}

      {roster.trainingCoverage.length > 0 && <TrainingCoverage rows={roster.trainingCoverage} />}

      <div className="crew-panel__head">
        <h3 className="crew-panel__title" id="crew-boosts-heading">
          What the roster is worth
        </h3>
        <p className="crew-panel__sub">
          Stacked across every named crew member and capped at the design ceiling. Diminishing
          returns before the cap, so the tenth veteran is worth less than the first.
        </p>
      </div>
      <TableScroll label="What the roster is worth, by quantity">
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
      </TableScroll>
    </section>
  );
}

interface PilotCardProps {
  member: CrewMemberView;
  operatedFamilies: readonly string[];
  maxPoints: number;
  maxLevel: number;
  onSpend: (memberId: string, branch: SkillBranch) => void;
  onTrainingCaptain: (memberId: string, designate: boolean) => void;
  refusal: CrewFailure | null;
  pending: boolean;
}

/** §10.5's pilot card: who they are, what they have done, and what they may become. */
function PilotCard({
  member,
  operatedFamilies,
  maxPoints,
  maxLevel,
  onSpend,
  onTrainingCaptain,
  refusal,
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

      {/*
        Keyed on the designation, so a confirmation half-way through does not
        survive the change it was confirming — the card comes back closed.
      */}
      <TrainingCaptainDecision
        key={`${member.id}:${member.trainingCaptain.since ?? 'line'}`}
        member={member}
        maxLevel={maxLevel}
        onChange={onTrainingCaptain}
        refusal={refusal}
        pending={pending}
      />
    </div>
  );
}

interface TrainingCaptainDecisionProps {
  member: CrewMemberView;
  maxLevel: number;
  onChange: (memberId: string, designate: boolean) => void;
  refusal: CrewFailure | null;
  pending: boolean;
}

/**
 * §10.2's Training Captain, on the pilot card (M9-04).
 *
 * > *"A max-level pilot can be converted to **Training Captain**: they stop
 * > generating full revenue value and instead multiply XP gain for everyone they
 * > fly with."*
 *
 * Both directions cost money and the way back costs more, so both go through the
 * two-step confirmation the rest of the client uses for a decision with a price:
 * the first click states the price — of this step **and** of undoing it — and
 * only the second spends it. When the action is closed the card says why, in
 * words that point at the fix, rather than showing a disabled button that
 * explains nothing.
 */
function TrainingCaptainDecision({
  member,
  maxLevel,
  onChange,
  refusal,
  pending,
}: TrainingCaptainDecisionProps): ReactNode {
  const [confirming, setConfirming] = useState(false);
  const standing = member.trainingCaptain;
  const designated = standing.since !== null;

  // Cabin crew never convert; a card that said so on every purser would be noise.
  if (!designated && standing.convertRefusal === 'not_flight_deck') return null;

  const conversion = formatUsdMinor(standing.conversionCostMinor);
  const reversion = formatUsdMinor(standing.reversionCostMinor);
  const closed =
    !designated && standing.convertRefusal !== null
      ? convertRefusalText(standing.convertRefusal, maxLevel)
      : null;
  const open = designated || standing.convertRefusal === null;

  return (
    <div className="crew-designation" aria-label="Training Captain">
      {designated ? (
        <p className="crew__note">
          <span className="crew-tag">Training Captain</span> since{' '}
          {(standing.since ?? '').slice(0, 10)}. Every pilot at {member.airportIcao} on the{' '}
          {member.family} earns XP faster for it. Their own skill points count for less on the line,
          because they fly fewer sectors as the operating pilot.
        </p>
      ) : open ? (
        <p className="crew__note">
          A top-level Captain can become a Training Captain: every pilot at {member.airportIcao} on
          the {member.family} earns XP faster, and this pilot’s own skill points count for less on
          the line.
        </p>
      ) : (
        closed !== null && <p className="crew__note">{closed}</p>
      )}

      {open &&
        (confirming ? (
          <>
            <p className="crew__note">
              {designated
                ? `Charges ${reversion} for line checks and recurrent training. The course fee is not refunded.`
                : `Charges ${conversion} for the course now. Returning them to the line later costs ${reversion}.`}
            </p>
            <div className="crew-designation__actions">
              <Button
                variant={designated ? 'danger' : 'primary'}
                size="sm"
                disabled={pending}
                onClick={() => {
                  onChange(member.id, !designated);
                }}
              >
                {designated ? 'Confirm — return to the line' : 'Confirm — make Training Captain'}
              </Button>
              <Button
                variant="tertiary"
                size="sm"
                disabled={pending}
                onClick={() => {
                  setConfirming(false);
                }}
              >
                Keep
              </Button>
            </div>
          </>
        ) : (
          <div className="crew-designation__actions">
            <Button
              size="sm"
              disabled={pending}
              onClick={() => {
                setConfirming(true);
              }}
            >
              {designated
                ? `Return to the line · ${reversion}`
                : `Make Training Captain · ${conversion}`}
            </Button>
          </div>
        ))}

      {refusal !== null && <StateBlock kind="refused">{refusal.message}</StateBlock>}
    </div>
  );
}

/**
 * The loop, made visible: what the Training Captains at each base are doing to
 * its pilots' XP (M9-04).
 *
 * The multiplier is the one the next arrival there will be settled with — the
 * server computes both from the same function — and the two tags say the thing
 * a player most needs to hear: *another Training Captain here buys nothing*.
 */
function TrainingCoverage({ rows }: { rows: readonly TrainingCoverageView[] }): ReactNode {
  return (
    <>
      <div className="crew-panel__head">
        <h3 className="crew-panel__title" id="crew-training-heading">
          Training Captains and pilot XP
        </h3>
        <p className="crew-panel__sub">
          A Training Captain covers a share of a base’s pilots on their type, and the pilots they
          cover earn XP faster. The bonus stops growing once everyone is covered, and never passes
          its cap.
        </p>
      </div>
      <TableScroll label="Training Captains and pilot XP, by base and type">
        <table className="crew__table" aria-labelledby="crew-training-heading">
          <thead>
            <tr>
              <th scope="col">Base</th>
              <th scope="col">Type</th>
              <th scope="col" className="figure">
                Training Captains
              </th>
              <th scope="col" className="figure">
                Pilots
              </th>
              <th scope="col" className="figure">
                Covered
              </th>
              <th scope="col" className="figure">
                Pilot XP
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={`${row.crewBaseId}:${row.family}`}>
                <th scope="row">{row.airportIcao}</th>
                <td>{row.family}</td>
                <td className="figure">{row.trainingCaptains}</td>
                <td className="figure">{row.flightDeckHeads}</td>
                <td className="figure">{`${String(Math.round(row.coverage * 100))}%`}</td>
                <td className="figure">
                  {`×${row.multiplier.toFixed(2)}`}
                  {row.capped ? (
                    <span className="crew-tag crew-tag--short">at cap</span>
                  ) : (
                    row.coverage >= 1 && <span className="crew-tag">fully covered</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableScroll>
    </>
  );
}
