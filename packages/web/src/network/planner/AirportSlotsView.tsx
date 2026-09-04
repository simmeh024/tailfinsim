import { useCallback, useEffect, useMemo, useState } from 'react';

import type { AirportSlotBand, AirportSlotsResponse } from '@tailfin/shared';

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
 */

function hourLabel(band: number): string {
  return `${String(band).padStart(2, '0')}:00`;
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
        <p className="admin__note">
          Open a route first. Slots are held at the airports you fly from, so there is nothing to
          manage until you have one.
        </p>
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

      {data === 'loading' && <p className="admin__note">Loading slots…</p>}
      {data === 'error' && (
        <p className="page__note" role="alert">
          Could not load this airport’s slots.
        </p>
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
          {notice !== null && (
            <p className="page__note" role="alert">
              {notice}
            </p>
          )}
          <table className="admin__table net-comp-table">
            <thead>
              <tr>
                <th scope="col">Band</th>
                <th scope="col">Filled</th>
                <th scope="col">You</th>
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
  const label = band.heldByYou ? 'Release' : full ? 'Full' : 'Claim';
  return (
    <tr>
      <th scope="row">{hourLabel(band.band)}</th>
      <td>
        <div className="net-comp-product">
          <Meter value={band.capacity === 0 ? 0 : band.held / band.capacity} tone="accent" />
          <span className="figure">
            {band.held}/{band.capacity}
          </span>
        </div>
      </td>
      <td>
        {band.heldByYou ? <Chip tone="positive">Held</Chip> : <span className="figure">—</span>}
      </td>
      <td>
        <button type="button" className="net-slots__btn" disabled={busy || full} onClick={onToggle}>
          {busy ? '…' : label}
        </button>
      </td>
    </tr>
  );
}
