import { useCallback, useEffect, useMemo, useState } from 'react';

import type {
  AirportGatesResponse,
  AirportStand,
  GateContract,
  StandHolder,
  StandKind,
  StandRequirement,
} from '@tailfin/shared';

import { StateBlock } from '../../ui/StateBlock';
import { fetchAirportGates, leaseStand, releaseStand } from '../api';

import { Chip, major, StatTile } from './ui';

import type { ReactNode } from 'react';

/**
 * The Gates view — lease and release stands, in the context of an airport
 * (M7-06, App. B.6).
 *
 * The companion to Slots, and App. B.8's point is that they are not the same
 * thing: *"you need both to fly a schedule. Acquiring one without the other is a
 * classic new-player mistake and the UI should warn about it loudly — not prevent
 * it."* This page is the second half of that pair.
 *
 * ## What it is actually for
 *
 * App. B.6's worked example ends with a sentence this page exists to make true:
 *
 * > *"You are paying for a gate you use 12% of the time. That's the lesson the
 * > first hub teaches, and it is the correct one: your gate is nearly idle, your
 * > aircraft is your only revenue source, and the fix is more rotations, not more
 * > gates."*
 *
 * So the summary tiles lead with **what the schedule needs against what is
 * held** — not with a list of stands to buy — and every gate the airline holds
 * carries its own utilisation. A player who is only told they are short of gates
 * learns the opposite of that lesson.
 *
 * ## Why the whole apron is listed, including other airlines' stands
 *
 * B.7: *"you can see exactly who holds what, which makes gate competition
 * legible and personal"*. An exclusive lease **denies** a stand to everybody
 * else, and a denial nobody can attribute reads like a bug. What is not shown is
 * a rival's utilisation or what their lease cost — the server does not send
 * either.
 *
 * The page computes nothing. Every price, every utilisation figure and the fresh
 * picture after a lease comes straight from the server.
 */

const KIND_LABEL: Record<StandKind, string> = {
  contact_gate: 'Contact gate',
  remote_stand: 'Remote stand',
  overnight_parking: 'Overnight',
  cargo_stand: 'Cargo',
  maintenance_stand: 'Maintenance',
};

const KIND_ORDER: readonly StandKind[] = [
  'contact_gate',
  'remote_stand',
  'overnight_parking',
  'cargo_stand',
  'maintenance_stand',
];

const CONTRACT_LABEL: Record<GateContract, string> = {
  common_use: 'Common use',
  preferential: 'Preferential',
  exclusive: 'Exclusive',
};

function percent(fraction: number): string {
  return `${String(Math.round(fraction * 100))}%`;
}

/** Who else is here. Codes rather than names, because a full apron is a wall. */
function Holders({ holders }: { holders: readonly StandHolder[] }): ReactNode {
  if (holders.length === 0) return <span className="figure">—</span>;
  return (
    <span className="figure">
      {holders
        .map((holder) => {
          const who = holder.isYou ? 'You' : (holder.iataCode ?? holder.name);
          return holder.contract === 'exclusive' ? `${who} (exclusive)` : who;
        })
        .join(', ')}
    </span>
  );
}

/**
 * What the schedule asks of this airport, against what is held.
 *
 * `sampledGameDate` being null is the case worth reading carefully: it means no
 * flight was found in the next game day, which on a node with no Worker is
 * permanent. *"You need no gates"* and *"nothing has been scheduled yet"* are
 * very different statements and the page must not make the first one on the
 * second one's evidence.
 */
function Requirement({ requirement }: { requirement: StandRequirement }): ReactNode {
  if (requirement.sampledGameDate === null) {
    return (
      <StateBlock kind="empty">
        Nothing is scheduled through here in the next day, so there is no gate requirement to
        compute yet. Publish a rotation and this will fill in.
      </StateBlock>
    );
  }

  const short = requirement.contactGates - requirement.contactGatesHeld;
  const overnightShort = requirement.overnightPositions - requirement.overnightPositionsHeld;
  return (
    <div className="net-tiles">
      <StatTile
        label="Contact gates needed"
        value={requirement.contactGates}
        sub={`${String(requirement.contactGatesHeld)} held`}
        tone={short > 0 ? 'warn' : 'positive'}
        tip="P95 of the aircraft on stand together, plus 20% — and never more than the busiest instant needs."
      />
      <StatTile
        label="Overnight positions"
        value={requirement.overnightPositions}
        sub={`${String(requirement.overnightPositionsHeld)} held`}
        tone={overnightShort > 0 ? 'warn' : 'positive'}
        tip="Aircraft still on the ground when the operating day closes. Cheap parking, not a gate."
      />
      <StatTile
        label="Busiest instant"
        value={requirement.peakConcurrency}
        sub={`${String(requirement.turns)} turns a day`}
        tip="The most aircraft you have on stand here at once."
      />
    </div>
  );
}

/** One stand's row: who holds it, how busy it is for you, and what it costs. */
function StandRow({
  stand,
  busy,
  onLease,
  onRelease,
}: {
  stand: AirportStand;
  busy: boolean;
  onLease: (contract: GateContract) => void;
  onRelease: () => void;
}): ReactNode {
  const yours = stand.yourContract !== null;
  return (
    <tr>
      <th scope="row" className="figure">
        {stand.position}
      </th>
      <td>
        <Holders holders={stand.holders} />
      </td>
      <td className="figure">
        {stand.utilisation === null ? (
          '—'
        ) : (
          <>
            {percent(stand.utilisation.fraction)}
            {stand.utilisation.belowFloor && (
              <>
                {' '}
                <Chip tone="warn">Idle</Chip>
              </>
            )}
          </>
        )}
      </td>
      <td className="figure">
        {yours
          ? `${CONTRACT_LABEL[stand.yourContract ?? 'preferential']} · ${major(Math.round((stand.annualFeeMinor[stand.yourContract ?? 'preferential'] ?? 0) / 12))}/mo`
          : `${major(Math.round(stand.annualFeeMinor.preferential / 12))}/mo · ${major(stand.commonUseTurnFeeMinor)}/turn`}
      </td>
      <td>
        {yours ? (
          <button type="button" className="btn btn--ghost" disabled={busy} onClick={onRelease}>
            Release
          </button>
        ) : (
          <span className="net-gates__actions">
            <button
              type="button"
              className="btn btn--ghost"
              disabled={busy || !stand.available}
              onClick={() => {
                onLease('preferential');
              }}
            >
              Lease
            </button>
            <button
              type="button"
              className="btn btn--ghost"
              disabled={busy || !stand.available || stand.holders.length > 0}
              onClick={() => {
                onLease('exclusive');
              }}
            >
              Exclusive
            </button>
          </span>
        )}
      </td>
    </tr>
  );
}

export function AirportGatesView({ airports }: { airports: readonly string[] }): ReactNode {
  const options = useMemo(() => [...new Set(airports)].sort(), [airports]);
  const [icao, setIcao] = useState<string | null>(options[0] ?? null);
  const [kind, setKind] = useState<StandKind>('contact_gate');
  const [data, setData] = useState<AirportGatesResponse | 'loading' | 'error'>('loading');
  const [busyStand, setBusyStand] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Keep the selection valid as the operated airports change.
  useEffect(() => {
    if (icao === null || !options.includes(icao)) setIcao(options[0] ?? null);
  }, [options, icao]);

  const load = useCallback((code: string) => {
    setData('loading');
    setNotice(null);
    fetchAirportGates(code)
      .then((response) => {
        setData(response);
      })
      .catch(() => {
        setData('error');
      });
  }, []);

  useEffect(() => {
    if (icao !== null) load(icao);
  }, [icao, load]);

  const onChange = useCallback(
    async (stand: AirportStand, contract: GateContract | null) => {
      if (icao === null) return;
      setBusyStand(stand.position);
      setNotice(null);
      try {
        const result =
          contract === null
            ? await releaseStand(icao, stand.position)
            : await leaseStand(icao, stand.position, contract, stand.annualFeeMinor[contract]);
        if (result.ok) setData(result.gates);
        else setNotice(result.reason);
      } catch {
        setNotice('That change could not be saved.');
      } finally {
        setBusyStand(null);
      }
    },
    [icao],
  );

  if (options.length === 0) {
    return (
      <section className="net-panel">
        <div className="net-panel__head">
          <h2 className="net-panel__title">Gates</h2>
        </div>
        <StateBlock kind="empty">
          Open a route first. Stands are leased at the airports you fly through, so there is nothing
          to manage until you have one.
        </StateBlock>
      </section>
    );
  }

  const shown = typeof data === 'object' ? data.stands.filter((stand) => stand.kind === kind) : [];

  return (
    <div className="net-performance">
      <div className="net-panel__head">
        <h2 className="net-panel__title">Gates</h2>
        <label className="net-slots__pick">
          <span className="visually-hidden">Airport</span>
          <select
            className="net-rail__search"
            value={icao ?? ''}
            onChange={(event) => {
              setIcao(event.target.value);
            }}
          >
            {options.map((code) => (
              <option key={code} value={code}>
                {code}
              </option>
            ))}
          </select>
        </label>
      </div>

      {data === 'loading' && <StateBlock kind="loading">Loading stands…</StateBlock>}
      {data === 'error' && (
        <StateBlock kind="broken">Could not load this airport’s stands.</StateBlock>
      )}

      {typeof data === 'object' && (
        <section className="net-panel">
          <div className="net-panel__head">
            <h3 className="net-panel__title">
              {data.name} ({data.icao})
            </h3>
            <span className="net-panel__hint">
              {major(data.monthlyFeeMinor)}/mo in leases here · a lease beats paying per turn from{' '}
              {String(Math.ceil(data.leaseBreakevenTurnsPerMonth))} turns a month
            </span>
          </div>

          <Requirement requirement={data.requirement} />

          {notice !== null && (
            <p className="page__note" role="alert">
              {notice}
            </p>
          )}

          <label className="net-slots__pick">
            <span className="visually-hidden">Stand type</span>
            <select
              className="net-rail__search"
              value={kind}
              onChange={(event) => {
                setKind(event.target.value as StandKind);
              }}
            >
              {KIND_ORDER.map((option) => (
                <option key={option} value={option}>
                  {KIND_LABEL[option]}
                </option>
              ))}
            </select>
          </label>

          <table className="admin__table net-comp-table">
            <thead>
              <tr>
                <th scope="col">Stand</th>
                <th scope="col">Held by</th>
                <th scope="col">Your use</th>
                <th scope="col">Cost</th>
                <th scope="col" />
              </tr>
            </thead>
            <tbody>
              {shown.map((stand) => (
                <StandRow
                  key={stand.position}
                  stand={stand}
                  busy={busyStand === stand.position}
                  onLease={(contract) => {
                    void onChange(stand, contract);
                  }}
                  onRelease={() => {
                    void onChange(stand, null);
                  }}
                />
              ))}
            </tbody>
          </table>

          <p className="net-panel__hint">
            A slot is permission to move; a stand is somewhere to park. You need both. An exclusive
            lease costs about two and a half times a preferential one and buys no operational
            advantage at all — what it buys is that nobody else can have the stand.
          </p>
        </section>
      )}
    </div>
  );
}
