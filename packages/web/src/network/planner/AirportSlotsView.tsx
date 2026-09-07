import { useCallback, useEffect, useMemo, useState } from 'react';

import type {
  AirportSlotBand,
  AirportSlotsResponse,
  SlotBandShape,
  SlotHolder,
  SlotReleaseSchedule,
} from '@tailfin/shared';

import { StateBlock } from '../../ui/StateBlock';
import { claimSlot, fetchAirportSlots, releaseSlot } from '../api';

import { Chip, Meter } from './ui';

import type { ReactNode } from 'react';

/**
 * The Slots view — hold and release departure bands, in the context of an airport
 * (M7-05, §"Slots").
 *
 * A coordinated airport's day is 24 hourly bands; to schedule a departure in one
 * you must hold it. This lists the airports you operate from and, for the one you
 * pick, its bands: how full each is, which you hold, and a button to claim or
 * release. An uncoordinated airport says so — nothing there is scarce.
 *
 * The page computes nothing: every band, and the fresh picture after a claim or
 * release, comes straight from the server.
 *
 * ## Why it shows the release schedule
 *
 * §21's answer to the launch land grab is that capacity arrives in waves, and a
 * wave nobody can see is indistinguishable from a permanently full board. A
 * newcomer looking at a mature world has to be able to tell *"taken for ever"*
 * from *"not open yet"*, so the banner states what fraction is released and when
 * the next wave lands — and each band shows today's released capacity against its
 * eventual ceiling rather than one number that quietly means different things.
 */

function hourLabel(band: number): string {
  return `${String(band).padStart(2, '0')}:00`;
}

const SHAPE_LABEL: Record<SlotBandShape, string> = {
  peak: 'Peak',
  shoulder: 'Shoulder',
  off_peak: 'Off-peak',
};

/**
 * The published wave schedule.
 *
 * Phrased as what the player can do about it rather than as a percentage on its
 * own: "more opens on game day 90" is actionable, "60% released" is trivia.
 */
function ReleaseNotice({ releases }: { releases: SlotReleaseSchedule }): ReactNode {
  const pct = Math.round(releases.releasedFraction * 100);
  if (releases.nextWaveAtGameDay === null) {
    return (
      <p className="net-panel__hint">
        All slots released. What is held here is held until it is given up.
      </p>
    );
  }
  return (
    <p className="net-panel__hint">
      {pct}% of this airport’s slots are released. The next wave opens on game day{' '}
      {releases.nextWaveAtGameDay}
      {releases.nextWaveInGameDays !== null && releases.nextWaveInGameDays > 0
        ? ` — ${String(releases.nextWaveInGameDays)} game day${releases.nextWaveInGameDays === 1 ? '' : 's'} away`
        : ''}
      . A full band now is not a full band for ever.
    </p>
  );
}

/** Who else is here. Codes rather than names, because 24 rows of names is a wall. */
function Holders({ holders }: { holders: readonly SlotHolder[] }): ReactNode {
  if (holders.length === 0) return <span className="figure">—</span>;
  return (
    <span className="figure">
      {holders
        .map((holder) => (holder.isYou ? 'You' : (holder.iataCode ?? holder.name)))
        .join(', ')}
    </span>
  );
}

export function AirportSlotsView({ airports }: { airports: readonly string[] }): ReactNode {
  const options = useMemo(() => [...new Set(airports)].sort(), [airports]);
  const [icao, setIcao] = useState<string | null>(options[0] ?? null);
  const [data, setData] = useState<AirportSlotsResponse | 'loading' | 'error'>('loading');
  const [busyBand, setBusyBand] = useState<number | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Keep the selection valid as the operated airports change.
  useEffect(() => {
    if (icao === null || !options.includes(icao)) setIcao(options[0] ?? null);
  }, [options, icao]);

  const load = useCallback((code: string) => {
    setData('loading');
    setNotice(null);
    fetchAirportSlots(code)
      .then((response) => setData(response))
      .catch(() => setData('error'));
  }, []);

  useEffect(() => {
    if (icao !== null) load(icao);
  }, [icao, load]);

  const onClaim = useCallback(
    async (band: number, held: boolean) => {
      if (icao === null) return;
      setBusyBand(band);
      setNotice(null);
      try {
        const result = held ? await releaseSlot(icao, band) : await claimSlot(icao, band);
        if (result.ok) setData(result.slots);
        else setNotice(result.reason);
      } catch {
        setNotice('That change could not be saved.');
      } finally {
        setBusyBand(null);
      }
    },
    [icao],
  );

  if (options.length === 0) {
    return (
      <section className="net-panel">
        <div className="net-panel__head">
          <h2 className="net-panel__title">Slots</h2>
        </div>
        <StateBlock kind="empty">
          Open a route first. Slots are held at the airports you fly from, so there is nothing to
          manage until you have one.
        </StateBlock>
      </section>
    );
  }

  return (
    <div className="net-performance">
      <div className="net-panel__head">
        <h2 className="net-panel__title">Slots</h2>
        <label className="net-slots__pick">
          <span className="visually-hidden">Airport</span>
          <select
            className="net-rail__search"
            value={icao ?? ''}
            onChange={(event) => setIcao(event.target.value)}
          >
            {options.map((code) => (
              <option key={code} value={code}>
                {code}
              </option>
            ))}
          </select>
        </label>
      </div>

      {data === 'loading' && <StateBlock kind="loading">Loading slots…</StateBlock>}
      {data === 'error' && (
        <StateBlock kind="broken">Could not load this airport’s slots.</StateBlock>
      )}

      {typeof data === 'object' && !data.coordinated && (
        <section className="net-panel">
          <p className="admin__note">
            {data.name} ({data.icao}) is not slot-coordinated. You can schedule departures here
            freely — no slot needed.
          </p>
        </section>
      )}

      {typeof data === 'object' && data.coordinated && (
        <section className="net-panel">
          <div className="net-panel__head">
            <h3 className="net-panel__title">
              {data.name} ({data.icao})
            </h3>
            <span className="net-panel__hint">Level {data.slotLevel} · coordinated</span>
          </div>
          {data.releases !== null && <ReleaseNotice releases={data.releases} />}
          {notice !== null && (
            <p className="page__note" role="alert">
              {notice}
            </p>
          )}
          <table className="admin__table net-comp-table">
            <thead>
              <tr>
                <th scope="col">Band</th>
                <th scope="col">Demand</th>
                <th scope="col">Filled</th>
                <th scope="col">Held by</th>
                <th scope="col" />
              </tr>
            </thead>
            <tbody>
              {data.bands.map((band) => (
                <BandRow
                  key={band.band}
                  band={band}
                  busy={busyBand === band.band}
                  onToggle={() => void onClaim(band.band, band.heldByYou)}
                />
              ))}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}

function BandRow({
  band,
  busy,
  onToggle,
}: {
  band: AirportSlotBand;
  busy: boolean;
  onToggle: () => void;
}): ReactNode {
  const full = !band.heldByYou && band.available === 0;
  // "Full" and "not open yet" are different refusals and must not read the same:
  // the first is somebody else's slot, the second is a wave that has not landed.
  const awaitingWave = full && band.released < band.capacity;
  const label = band.heldByYou ? 'Release' : awaitingWave ? 'Not yet' : full ? 'Full' : 'Claim';
  return (
    <tr>
      <th scope="row">{hourLabel(band.band)}</th>
      <td>
        <Chip tone={band.shape === 'off_peak' ? 'positive' : 'neutral'}>
          {SHAPE_LABEL[band.shape]}
        </Chip>
      </td>
      <td>
        <div className="net-comp-product">
          <Meter value={band.released === 0 ? 1 : band.held / band.released} tone="accent" />
          <span className="figure">
            {band.held}/{band.released}
            {band.released < band.capacity ? ` of ${String(band.capacity)}` : ''}
          </span>
        </div>
      </td>
      <td>
        {band.heldByYou && <Chip tone="positive">Held</Chip>} <Holders holders={band.holders} />
      </td>
      <td>
        <button
          type="button"
          className="net-slots__btn"
          disabled={busy || full}
          onClick={onToggle}
          title={
            awaitingWave
              ? 'Every released slot in this band is taken. More open at the next release wave.'
              : undefined
          }
        >
          {busy ? '…' : label}
        </button>
      </td>
    </tr>
  );
}
