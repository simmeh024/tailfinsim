import type {
  AirframeAssignment,
  AirframeDetailResponse,
  BuildStepView,
  CapabilityMovement,
  SpecAxis,
  SpecMovement,
} from '@tailfin/shared';

import { compactUsdMinor } from '../currency/display';

import type { ReactNode } from 'react';

/**
 * One aircraft, and why it is the way it is (M4-07).
 *
 * The whole point of this view is M4-07's first acceptance criterion — the
 * effective spec shows the **base value and the delta per option**, not just the
 * total — so the spec is laid out twice, deliberately:
 *
 *   1. **base beside effective**, so the size of the change is visible at a
 *      glance and an unchanged axis reads as unchanged;
 *   2. **one block per option**, naming what that option moved and by how much.
 *
 * Both come from the server. The client does not fold a spec, cannot fold one —
 * lint forbids `packages/web` importing `@tailfin/sim` — and would get a
 * different answer if it tried, because the arithmetic is order-dependent and
 * rounded (see `spec-decomposition.ts`). What is rendered here is what the
 * simulation bills.
 */

/** Every axis, in the order a spec sheet reads rather than alphabetically. */
const AXIS_LABEL: Record<SpecAxis, string> = {
  seatsTwoClass: 'Seats, two-class',
  maxSeats: 'Seats, certified maximum',
  maxPayloadTonnes: 'Payload limit',
  rangeNm: 'Range',
  cruiseSpeedKt: 'Cruise speed',
  mtowTonnes: 'Maximum take-off weight',
  oewTonnes: 'Operating empty weight',
  runwayRequirementM: 'Runway required',
  fuelBurnKgPerHour: 'Fuel burn',
  noiseChapter: 'Noise chapter',
  turnaroundBaselineMin: 'Turnaround baseline',
};

const AXIS_UNIT: Record<SpecAxis, string> = {
  seatsTwoClass: '',
  maxSeats: '',
  maxPayloadTonnes: ' t',
  rangeNm: ' nm',
  cruiseSpeedKt: ' kt',
  mtowTonnes: ' t',
  oewTonnes: ' t',
  runwayRequirementM: ' m',
  fuelBurnKgPerHour: ' kg/h',
  noiseChapter: '',
  turnaroundBaselineMin: ' min',
};

/** Decimals worth showing per axis. Seats are whole; tonnes are not. */
const AXIS_DECIMALS: Record<SpecAxis, number> = {
  seatsTwoClass: 0,
  maxSeats: 0,
  maxPayloadTonnes: 1,
  rangeNm: 0,
  cruiseSpeedKt: 0,
  mtowTonnes: 1,
  oewTonnes: 1,
  runwayRequirementM: 0,
  fuelBurnKgPerHour: 1,
  noiseChapter: 0,
  turnaroundBaselineMin: 0,
};

const AXIS_ORDER: SpecAxis[] = [
  'seatsTwoClass',
  'maxSeats',
  'maxPayloadTonnes',
  'rangeNm',
  'cruiseSpeedKt',
  'mtowTonnes',
  'oewTonnes',
  'runwayRequirementM',
  'fuelBurnKgPerHour',
  'turnaroundBaselineMin',
  'noiseChapter',
];

const CAPABILITY_LABEL: Record<CapabilityMovement['axis'], string> = {
  cargoVolumeFactor: 'Belly volume',
  comfortDelta: 'Comfort',
  maintenanceCostFactor: 'Maintenance cost',
  lowVisibilityCancellationFactor: 'Low-visibility cancellations',
  etopsMinutes: 'ETOPS approval',
};

const CAPABILITY_GAINED_LABEL: Record<'ulhCapable' | 'unpavedCapable', string> = {
  ulhCapable: 'Cleared for ultra-long-haul',
  unpavedCapable: 'Cleared for unpaved strips',
};

function axisValue(axis: SpecAxis, value: number): string {
  return `${value.toFixed(AXIS_DECIMALS[axis])}${AXIS_UNIT[axis]}`;
}

/** Signed, always — a delta without its sign is not a delta. */
function axisDelta(axis: SpecAxis, movement: SpecMovement): string {
  const delta = movement.after - movement.before;
  const sign = delta > 0 ? '+' : '';
  return `${sign}${delta.toFixed(AXIS_DECIMALS[axis])}${AXIS_UNIT[axis]}`;
}

function capabilityValue(axis: CapabilityMovement['axis'], value: number | null): string {
  // Null is "no approval", which is a different fact from zero minutes: every
  // aircraft may fly inside the default 60-minute rule.
  if (value === null) return 'none';
  if (axis === 'etopsMinutes') return `${String(value)} min`;
  if (axis === 'comfortDelta') return value.toFixed(2);
  return `${(value * 100).toFixed(0)}%`;
}

function money(minor: number): string {
  // Compact figure in the player's display currency (M8-02). Wire stays USD minor.
  return compactUsdMinor(minor);
}

function minutesAsClock(minute: number): string {
  const hours = Math.floor(minute / 60);
  const minutes = minute % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

const WEEKDAY = ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function repeatLabel(assignment: AirframeAssignment): string {
  if (assignment.repeat.kind === 'daily') return 'Every day';
  return assignment.repeat.days.map((day) => WEEKDAY[day] ?? String(day)).join(', ');
}

function StepBlock({ step }: { step: BuildStepView }): ReactNode {
  const nothingMoved =
    step.movements.length === 0 &&
    step.wingspan === null &&
    step.capabilityMovements.length === 0 &&
    step.capabilitiesGained.length === 0;

  return (
    <li className="fleet__step">
      <h4 className="fleet__step-name">
        {step.label}
        {step.category !== null && <span className="fleet__step-category">{step.category}</span>}
      </h4>
      {step.summary !== null && <p className="fleet__step-summary">{step.summary}</p>}

      <dl className="fleet__step-deltas">
        {step.movements.map((movement) => (
          <div className="fleet__delta" key={movement.axis}>
            <dt>{AXIS_LABEL[movement.axis]}</dt>
            <dd>
              <span className="fleet__delta-amount">{axisDelta(movement.axis, movement)}</span>
              {/* The running value, so a player can follow the chain rather than
                  having to add the deltas up themselves. */}
              <span className="fleet__delta-running">
                {axisValue(movement.axis, movement.before)} →{' '}
                {axisValue(movement.axis, movement.after)}
              </span>
            </dd>
          </div>
        ))}

        {step.wingspan !== null && (
          <div className="fleet__delta" key="wingspan">
            <dt>Wingspan code</dt>
            <dd>
              <span className="fleet__delta-amount">
                {step.wingspan.before} → {step.wingspan.after}
              </span>
              {/* C.3 rule 3: a fuel-saving option that strands you at your own
                  gate is a mistake the game should let you make — visibly. */}
              <span className="fleet__delta-running">gate compatibility changes</span>
            </dd>
          </div>
        )}

        {step.capabilityMovements.map((movement) => (
          <div className="fleet__delta" key={movement.axis}>
            <dt>{CAPABILITY_LABEL[movement.axis]}</dt>
            <dd>
              <span className="fleet__delta-amount">
                {capabilityValue(movement.axis, movement.before)} →{' '}
                {capabilityValue(movement.axis, movement.after)}
              </span>
            </dd>
          </div>
        ))}

        {step.capabilitiesGained.map((capability) => (
          <div className="fleet__delta" key={capability}>
            <dt>Capability</dt>
            <dd>
              <span className="fleet__delta-amount">{CAPABILITY_GAINED_LABEL[capability]}</span>
            </dd>
          </div>
        ))}

        {nothingMoved && (
          // Reachable, and worth saying: sharklets on a code F aircraft cannot
          // raise the code any further, so the option was paid for and changed
          // nothing on this airframe. Silence would read as a rendering bug.
          <div className="fleet__delta">
            <dt>Effect</dt>
            <dd>
              <span className="fleet__delta-amount">nothing on this type</span>
            </dd>
          </div>
        )}
      </dl>

      <p className="fleet__step-cost">
        {money(step.priceMinor)}
        {step.leadTimeWeeks > 0 && ` · +${String(step.leadTimeWeeks)} weeks to delivery`}
      </p>
    </li>
  );
}

export function AirframeDetail({
  detail,
  onClose,
}: {
  detail: AirframeDetailResponse;
  onClose: () => void;
}): ReactNode {
  const { airframe: view, spec, assignments, provenance, maintenance } = detail;

  return (
    <section className="fleet__detail" aria-label={`${view.registration} detail`}>
      <header className="fleet__detail-head">
        <div>
          <h2 className="fleet__detail-title">{view.registration}</h2>
          <p className="fleet__detail-sub">
            {view.manufacturer} {view.typeDesignation} · {view.family} family · {view.ownership}
          </p>
        </div>
        <button type="button" className="fleet__close" onClick={onClose}>
          Close
        </button>
      </header>

      <h3 className="fleet__section-heading">Effective specification</h3>
      <p className="fleet__hint">
        Every system that flies this aircraft reads the effective column — reachability, fuel burn,
        fees and demand. The base column is the type as the catalogue publishes it.
      </p>
      <table className="fleet__spec">
        <caption>
          {spec.steps.length === 0
            ? 'Ordered off the shelf, so the effective specification is the type specification.'
            : `${String(spec.steps.length)} change${spec.steps.length === 1 ? '' : 's'} from the published type.`}
        </caption>
        <thead>
          <tr>
            <th scope="col">Axis</th>
            <th scope="col">Base</th>
            <th scope="col">Effective</th>
          </tr>
        </thead>
        <tbody>
          {AXIS_ORDER.map((axis) => {
            const changed = spec.base[axis] !== spec.effective[axis];
            return (
              <tr key={axis} data-changed={changed ? 'yes' : 'no'}>
                <th scope="row">{AXIS_LABEL[axis]}</th>
                <td className="figure">{axisValue(axis, spec.base[axis])}</td>
                <td className="figure">{axisValue(axis, spec.effective[axis])}</td>
              </tr>
            );
          })}
          <tr data-changed={spec.base.wingspanCode === spec.effective.wingspanCode ? 'no' : 'yes'}>
            <th scope="row">Wingspan code</th>
            <td className="figure">{spec.base.wingspanCode}</td>
            <td className="figure">{spec.effective.wingspanCode}</td>
          </tr>
        </tbody>
      </table>

      {spec.steps.length > 0 && (
        <>
          <h3 className="fleet__section-heading">What each option did</h3>
          <p className="fleet__hint">
            In the order the simulation folds them. A percentage applies to the value it finds, so
            the second of two burn options saves less than the first — these are the amounts as
            applied, not the brochure figures.
          </p>
          <ol className="fleet__steps">
            {spec.steps.map((step, index) => (
              <StepBlock key={step.optionId ?? `cabin-${String(index)}`} step={step} />
            ))}
          </ol>
          <p className="fleet__hint">
            Ordered at {money(spec.priceMinor)}
            {spec.leadTimeWeeks > 0 &&
              `, with ${String(spec.leadTimeWeeks)} weeks of options lead time`}
            .
          </p>
        </>
      )}

      <h3 className="fleet__section-heading">Cabin</h3>
      <p className="fleet__hint">
        {detail.cabinConfigId === null
          ? 'No cabin fitted. The cabin builder is a later milestone (M6); until then an aircraft flies its type’s reference cabin.'
          : `Cabin ${detail.cabinConfigId}.`}
      </p>

      <h3 className="fleet__section-heading">Assignment</h3>
      {assignments.length === 0 ? (
        <p className="fleet__hint">
          Not assigned to a rotation. It is at {view.locationIcao ?? 'an unknown airport'} and
          earning nothing.
        </p>
      ) : (
        <ul className="fleet__assignments">
          {assignments.map((assignment) => (
            <li className="fleet__assignment" key={assignment.scheduleId}>
              <p className="fleet__assignment-head">
                {repeatLabel(assignment)}
                {!assignment.active && <span className="fleet__paused">paused</span>}
                <span className="fleet__assignment-block">
                  {(assignment.dailyBlockMinutes / 60).toFixed(1)} block hours a day
                </span>
              </p>
              <ol className="fleet__legs">
                {assignment.legs.map((leg) => (
                  <li key={leg.legIndex}>
                    {minutesAsClock(leg.departureMinute)} {leg.originIcao} → {leg.destinationIcao} ·{' '}
                    {String(leg.blockMinutes)} min block, {String(leg.turnaroundMinutes)} min turn
                  </li>
                ))}
              </ol>
            </li>
          ))}
        </ul>
      )}

      <h3 className="fleet__section-heading">Maintenance</h3>
      <table className="fleet__spec">
        <caption>
          {maintenance.maintenanceProfile} programme. Whichever limit arrives first decides.
        </caption>
        <thead>
          <tr>
            <th scope="col">Check</th>
            <th scope="col">Hours left</th>
            <th scope="col">Cycles left</th>
            <th scope="col">Binding</th>
            <th scope="col">Cost</th>
            <th scope="col">Downtime</th>
          </tr>
        </thead>
        <tbody>
          {maintenance.tiers.map((tier) => (
            <tr key={tier.tier} data-due={tier.due ? 'yes' : 'no'}>
              <th scope="row">{tier.tier.toUpperCase()}-check</th>
              <td className="figure">{Math.round(tier.hoursRemaining)}</td>
              <td className="figure">{Math.round(tier.cyclesRemaining)}</td>
              <td>{tier.binding}</td>
              <td className="figure">{money(tier.costMinor)}</td>
              <td className="figure">{String(tier.downtimeDays)} d</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h3 className="fleet__section-heading">History</h3>
      <dl className="fleet__provenance">
        <div>
          <dt>Acquired</dt>
          <dd>{provenance.acquisitionKind}</dd>
        </div>
        <div>
          <dt>Delivered</dt>
          <dd>
            {provenance.deliveredAt.slice(0, 10)} at {provenance.deliveredToIcao}
          </dd>
        </div>
        <div>
          <dt>Built</dt>
          {/* Honestly unknown rather than silently the delivery date: a leased or
              pre-M4-05 airframe has no recorded build date, and inventing one
              would make every one of them eternally brand new. */}
          <dd>{provenance.builtAt === null ? 'not recorded' : provenance.builtAt.slice(0, 10)}</dd>
        </div>
        <div>
          <dt>Hours / cycles</dt>
          <dd>
            {view.hours.toFixed(1)} / {String(view.cycles)}
          </dd>
        </div>
      </dl>
      {provenance.ownerHistory.length > 0 && (
        <ul className="fleet__owners">
          {provenance.ownerHistory.map((entry) => (
            <li key={`${entry.ownerLabel}-${entry.acquiredAt}`}>
              {entry.ownerLabel}, {entry.acquiredAt.slice(0, 10)} –{' '}
              {entry.releasedAt === null ? 'present' : entry.releasedAt.slice(0, 10)}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
