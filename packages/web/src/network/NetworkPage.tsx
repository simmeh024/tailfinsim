import { useCallback, useEffect, useState } from 'react';

import { CABIN_ORDER } from '@tailfin/shared';
import type {
  CabinClass,
  CabinMarketPosition,
  FarePreviewResponse,
  FareFloorViolation,
  FareTable,
} from '@tailfin/shared';

import { fetchRoutes, previewFares, type RouteSummary, saveFares } from './api';

import type { ReactNode } from 'react';

/**
 * Routes and per-class fares (M3-09, §8.3, App. A.10).
 *
 * Every number on this page comes from the server. The projected share, the
 * market average and the price floor are all computed by `@tailfin/sim` behind
 * `/api/routes/:id/fares/preview` — this file has no economics in it at all,
 * because invariant 1 says the server is authoritative and ESLint refuses the
 * client an import of the sim.
 *
 * That is what makes M3-09's second criterion true by construction: there is no
 * second estimate here to drift from resolution, because there is no estimate
 * here.
 */

/** `12345` minor units → `123.45`. Display only; the wire stays integer. */
function major(minor: number): string {
  return (minor / 100).toFixed(2);
}

/** Parse a typed major-unit fare back to whole minor units, or nothing. */
function toMinor(input: string): number | undefined {
  const trimmed = input.trim();
  if (trimmed === '') return undefined;
  const value = Number(trimmed);
  if (!Number.isFinite(value) || value < 0) return undefined;
  return Math.round(value * 100);
}

const CABIN_LABEL: Record<CabinClass, string> = {
  first: 'First',
  business: 'Business',
  premium_economy: 'Premium economy',
  economy: 'Economy',
};

function Position({
  position,
  draft,
  onChange,
  violation,
}: {
  position: CabinMarketPosition;
  draft: string;
  onChange: (value: string) => void;
  violation: FareFloorViolation | undefined;
}): ReactNode {
  const { cabin } = position;

  return (
    <tr className={violation ? 'fares__row fares__row--refused' : 'fares__row'}>
      <th scope="row" className="fares__cabin">
        {CABIN_LABEL[cabin]}
        <span className="fares__seats">
          {position.seats === 0 ? 'not fitted' : `${String(position.seats)} seats`}
        </span>
      </th>

      <td>
        <label className="fares__field">
          <span className="visually-hidden">{CABIN_LABEL[cabin]} fare</span>
          <input
            className="fares__input figure"
            type="text"
            inputMode="decimal"
            value={draft}
            disabled={position.seats === 0}
            aria-invalid={violation !== undefined}
            aria-describedby={violation ? `floor-${cabin}` : undefined}
            onChange={(event) => {
              onChange(event.target.value);
            }}
          />
        </label>
      </td>

      <td className="figure">{major(position.marketAverageMinor)}</td>

      <td className="figure">
        {/* A.3's PriceRel — the number the logit actually uses, so a player can
            see the input to their own share rather than a rephrasing of it. */}
        {position.priceRel === null ? '—' : `${(position.priceRel * 100).toFixed(0)}%`}
      </td>

      <td className="figure">{major(position.floorMinor)}</td>

      <td className="figure">
        {position.projectedShare === null ? '—' : `${(position.projectedShare * 100).toFixed(1)}%`}
      </td>
    </tr>
  );
}

function RoutePanel({ route }: { route: RouteSummary }): ReactNode {
  const [draft, setDraft] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      CABIN_ORDER.map((cabin) => [
        cabin,
        route.fares[cabin] === undefined ? '' : major(route.fares[cabin]),
      ]),
    ),
  );
  const [preview, setPreview] = useState<FarePreviewResponse | null>(null);
  const [violations, setViolations] = useState<FareFloorViolation[]>([]);
  const [saved, setSaved] = useState(false);
  const [failed, setFailed] = useState(false);

  const proposed = useCallback((): FareTable => {
    const fares: FareTable = {};
    for (const cabin of CABIN_ORDER) {
      const minor = toMinor(draft[cabin] ?? '');
      if (minor !== undefined) fares[cabin] = minor;
    }
    return fares;
  }, [draft]);

  // The live preview. Debounced, because it runs the whole demand model on the
  // server and a request per keystroke would be a denial of service written by
  // its own author.
  useEffect(() => {
    const timer = setTimeout(() => {
      void (async () => {
        try {
          setPreview(await previewFares(route.id, proposed()));
          setFailed(false);
        } catch {
          setFailed(true);
        }
      })();
    }, 400);

    return () => {
      clearTimeout(timer);
    };
  }, [route.id, proposed]);

  const onSave = async () => {
    setSaved(false);
    try {
      const result = await saveFares(route.id, proposed());
      if (result.ok) {
        setViolations([]);
        setSaved(true);
      } else {
        // Not an error state: the server's considered answer, with the floor.
        setViolations(result.violations);
      }
    } catch {
      setFailed(true);
    }
  };

  const violationFor = (cabin: CabinClass) => violations.find((v) => v.cabin === cabin);
  const delta = preview === null ? null : preview.projectedPassengers - preview.currentPassengers;

  return (
    <section className="card">
      <h2 className="card__heading">
        {route.originIcao} → {route.destinationIcao}
        <span className="fares__distance figure">{route.greatCircleNm.toFixed(0)} nm</span>
      </h2>

      <table className="admin__table fares__table">
        <thead>
          <tr>
            <th scope="col">Cabin</th>
            <th scope="col">Your fare</th>
            <th scope="col">Market avg</th>
            <th scope="col">vs market</th>
            <th scope="col">Floor</th>
            <th scope="col">Projected share</th>
          </tr>
        </thead>
        <tbody>
          {(preview?.positions ?? []).map((position) => (
            <Position
              key={position.cabin}
              position={position}
              draft={draft[position.cabin] ?? ''}
              onChange={(value) => {
                setDraft((current) => ({ ...current, [position.cabin]: value }));
                setSaved(false);
              }}
              violation={violationFor(position.cabin)}
            />
          ))}
        </tbody>
      </table>

      {preview === null && !failed && <p className="admin__note">Working out the market…</p>}
      {failed && (
        <p className="admin__note" role="alert">
          Could not reach the market model. The figures above may be stale.
        </p>
      )}

      {preview !== null && (
        <p className="fares__projection">
          <strong className="figure">{preview.projectedPassengers.toFixed(0)}</strong> passengers a
          day at these fares
          {delta !== null && Math.abs(delta) >= 0.5 && (
            <span
              className={
                delta > 0 ? 'fares__delta fares__delta--up' : 'fares__delta fares__delta--down'
              }
            >
              {delta > 0 ? '▲' : '▼'} {Math.abs(delta).toFixed(0)} against what is saved
            </span>
          )}
        </p>
      )}

      {violations.length > 0 && (
        <ul className="fares__violations" role="alert">
          {violations.map((v) => (
            <li key={v.cabin} id={`floor-${v.cabin}`} className="fares__violation">
              <strong>{CABIN_LABEL[v.cabin]}</strong> may not be priced below{' '}
              <span className="figure">{major(v.floorMinor)}</span> — that is{' '}
              {(v.ratio * 100).toFixed(0)}% of the{' '}
              <span className="figure">{major(v.variableCostPerSeatMinor)}</span> it costs to fly a
              seat on this route. You are <span className="figure">{major(v.shortfallMinor)}</span>{' '}
              under.
            </li>
          ))}
        </ul>
      )}

      <div className="fares__actions">
        <button className="admin__submit" type="button" onClick={() => void onSave()}>
          Save fares
        </button>
        {saved && <span className="fares__saved">Saved.</span>}
      </div>
    </section>
  );
}

export function NetworkPage(): ReactNode {
  const [routes, setRoutes] = useState<RouteSummary[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        setRoutes(await fetchRoutes());
      } catch {
        setFailed(true);
      }
    })();
  }, []);

  return (
    <section className="page">
      <h1 className="page__title">Network</h1>

      {failed && (
        <p className="page__note" role="alert">
          Could not load your routes.
        </p>
      )}
      {routes === null && !failed && <p className="page__note">Loading…</p>}
      {routes !== null && routes.length === 0 && (
        <p className="page__note">
          No routes yet. Opening one is M2-01&rsquo;s; once it exists, its fares are set here.
        </p>
      )}

      {(routes ?? []).map((route) => (
        <RoutePanel key={route.id} route={route} />
      ))}
    </section>
  );
}
