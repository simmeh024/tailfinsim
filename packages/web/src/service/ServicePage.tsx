import { useCallback, useEffect, useRef, useState } from 'react';

import {
  CABIN_ORDER,
  type CabinClass,
  type ServicePackageContent,
  type ServiceSelection,
  type RouteGroupsResponse,
  type ServiceCatalogueResponse,
  type ServicePackageSummary,
  type ServicePaybackResponse,
} from '@tailfin/shared';

import { formatUsdMinor } from '../currency/display';
import { Button } from '../ui/Button';
import { StateBlock } from '../ui/StateBlock';

import {
  assignPackage,
  createPackage,
  fetchCatalogue,
  fetchPackages,
  fetchPayback,
  fetchRouteGroups,
  updatePackage,
  type ServiceWrite,
} from './api';

import type { ReactNode } from 'react';

/**
 * The service configurator and its payback table (M8-05, App. D.2 and D.4).
 *
 * > The service configurator shows this table live as you toggle options,
 * > computed against the actual segment mix of the routes the aircraft flies.
 * > It turns service design from a vibe into a decision — and it makes "budget
 * > or luxury?" a question with a *correct answer per route*, rather than a
 * > personality test.
 *
 * That sentence is the whole page. Toggling a tier changes what the package
 * costs, what it scores, and what fare premium each segment will bear for it,
 * and all three are on screen at once.
 *
 * ## The table comes from the server, and has to
 *
 * `packages/web` does not depend on `@tailfin/sim`, so the browser cannot run
 * App. A.3's utility function — and should not, because a second copy of it
 * would eventually disagree with the allocator that actually seats passengers.
 * Every change posts the draft package to `/api/service/payback` and renders
 * what comes back.
 *
 * Requests are **debounced and ordered**: a fast series of toggles sends one
 * request, and a slow reply for an older package is discarded rather than
 * allowed to overwrite a newer one. Without the second rule the table settles on
 * whichever request happened to finish last, which on a slow connection is
 * reliably the wrong one.
 *
 * ## Priced, then saved, then put to work
 *
 * Three separate steps, and keeping them separate is the point. Pricing a draft
 * changes nothing. **Saving** writes the package under a name. **Assigning** it
 * to a route group is what makes it reach a flight — App. D.5's rule that
 * packages attach per route group and not per aircraft, so one airframe can fly
 * a leisure config in the morning and a business one in the evening.
 *
 * A saved package is not automatically in service. That is deliberate: a player
 * editing "Budget short-haul" to try something should not thereby change what
 * every leisure route serves the moment they hit save.
 *
 * ## Money is USD minor units until it is rendered
 *
 * M8-02's rule: every figure here is integer minor units on the wire and passes
 * through `formatUsdMinor` at the boundary, so the player's display currency
 * applies without anything upstream knowing about it.
 */

/** How long a toggle waits for its neighbours before the table is re-priced. */
const DEBOUNCE_MS = 250;

const EMPTY: ServicePackageContent = { perClass: {}, commercialIntensity: 0 };

const SEGMENT_LABEL: Record<string, string> = {
  business: 'Business',
  leisure: 'Leisure',
  vfr: 'VFR',
};

const CABIN_LABEL: Record<CabinClass, string> = {
  economy: 'Economy',
  premium_economy: 'Premium economy',
  business: 'Business',
  first: 'First',
};

const money = (minor: number): string => formatUsdMinor(minor, { fractionDigits: 2 });

export function ServicePage(): ReactNode {
  const [catalogue, setCatalogue] = useState<ServiceCatalogueResponse | null>(null);
  const [groups, setGroups] = useState<RouteGroupsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [cabin, setCabin] = useState<CabinClass>('economy');
  const [groupId, setGroupId] = useState<string>('');
  const [content, setContent] = useState<ServicePackageContent>(EMPTY);
  const [payback, setPayback] = useState<ServicePaybackResponse | null>(null);
  const [pricing, setPricing] = useState(false);
  const [packages, setPackages] = useState<ServicePackageSummary[]>([]);
  // The saved package being edited, or '' for a new one.
  const [editing, setEditing] = useState<string>('');
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<(ServiceWrite & { ok: false }) | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void Promise.all([fetchCatalogue(), fetchRouteGroups(), fetchPackages()]).then(
      ([cat, grp, pkgs]) => {
        if (!live) return;
        setCatalogue(cat);
        setGroups(grp);
        setPackages(pkgs?.packages ?? []);
        setLoading(false);
      },
    );
    return () => {
      live = false;
    };
  }, []);

  // Monotonic request id. A reply whose id is not the newest is dropped, so a
  // slow answer for an older package cannot overwrite a newer one.
  const issued = useRef(0);

  const price = useCallback((draft: ServicePackageContent, group: string) => {
    const id = ++issued.current;
    setPricing(true);
    void fetchPayback(draft, group === '' ? undefined : group).then((result) => {
      if (id !== issued.current) return;
      setPricing(false);
      // A failed price keeps the last good table rather than blanking it — one
      // network blip should not erase the number the player is reading.
      if (result !== null) setPayback(result);
    });
  }, []);

  useEffect(() => {
    if (loading) return undefined;
    const timer = setTimeout(() => price(content, groupId), DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [content, groupId, loading, price]);

  const setTier = (category: string, tier: number): void => {
    setContent((current) => ({
      ...current,
      perClass: {
        ...current.perClass,
        [cabin]: { ...(current.perClass[cabin] ?? {}), [category]: tier },
      },
    }));
  };

  const selectedTier = (category: string): number =>
    content.perClass[cabin]?.[category as keyof ServiceSelection] ?? 0;

  const cabinLine = payback?.cabins.find((entry) => entry.cabin === cabin) ?? null;

  /** Pull a saved package onto the bench, or start a blank one. */
  const load = (id: string): void => {
    setEditing(id);
    setFailure(null);
    setSaved(null);
    const found = packages.find((entry) => entry.id === id);
    if (found === undefined) {
      setName('');
      setContent(EMPTY);
      return;
    }
    setName(found.name);
    setContent(found.content);
  };

  const refreshSaved = async (): Promise<readonly ServicePackageSummary[]> => {
    const listed = await fetchPackages();
    const next = listed?.packages ?? [];
    setPackages(next);
    return next;
  };

  const save = async (): Promise<void> => {
    const trimmed = name.trim();
    if (trimmed === '') {
      setFailure({
        ok: false,
        status: 0,
        code: 'no_name',
        message: 'Give the package a name first.',
      });
      return;
    }
    setSaving(true);
    setFailure(null);
    setSaved(null);
    const outcome =
      editing === ''
        ? await createPackage(trimmed, content)
        : await updatePackage(editing, trimmed, content);
    setSaving(false);
    if (!outcome.ok) {
      setFailure(outcome);
      return;
    }
    const next = await refreshSaved();
    // A create comes back without an id, so the saved package is found by the
    // name it was just written under — which is unique per airline.
    setEditing(next.find((entry) => entry.name === trimmed)?.id ?? editing);
    setSaved(trimmed);
  };

  const assign = async (routeGroupId: string, packageId: string): Promise<void> => {
    setSaving(true);
    setFailure(null);
    const outcome = await assignPackage(routeGroupId, packageId === '' ? null : packageId);
    setSaving(false);
    if (!outcome.ok) {
      setFailure(outcome);
      return;
    }
    setGroups(await fetchRouteGroups());
    await refreshSaved();
  };

  return (
    <section className="page service-page" aria-label="Service">
      <header className="service-page__heading">
        <div>
          <p className="airline-page__eyebrow">Cabin &amp; ancillary</p>
          {/* The h1 matches the rail label, as every other page's does. */}
          <h1 className="page__title">Service</h1>
          <p className="page__note">
            Tier sets the ceiling; how well your crew and caterer execute decides where inside it
            you land. The table on the right prices the package against the routes you actually fly
            — the same demand model that seats the passengers.
          </p>
        </div>
        <div className="service-page__scope">
          <label className="service-page__field">
            <span>Cabin</span>
            <select value={cabin} onChange={(event) => setCabin(event.target.value as CabinClass)}>
              {CABIN_ORDER.map((entry) => (
                <option key={entry} value={entry}>
                  {CABIN_LABEL[entry]}
                </option>
              ))}
            </select>
          </label>
          <label className="service-page__field">
            <span>Priced against</span>
            <select value={groupId} onChange={(event) => setGroupId(event.target.value)}>
              <option value="">My whole network</option>
              {(groups?.groups ?? []).map((group) => (
                <option key={group.id} value={group.id}>
                  {group.name}
                </option>
              ))}
            </select>
          </label>
        </div>
      </header>

      {loading ? (
        <StateBlock kind="loading">Reading the catalogue…</StateBlock>
      ) : catalogue === null ? (
        <StateBlock kind="broken">
          The service catalogue could not be read, so nothing can be priced.
        </StateBlock>
      ) : (
        <div className="service-page__body">
          <div className="service-ladders">
            {/*
              Saving and assigning are separate steps on purpose: editing a
              package a route group already flies must not change what that
              group serves until the player says so.
            */}
            <section className="service-bench" aria-label="Package">
              <label className="service-page__field">
                <span>Editing</span>
                <select value={editing} onChange={(event) => load(event.target.value)}>
                  <option value="">New package</option>
                  {packages.map((entry) => (
                    <option key={entry.id} value={entry.id}>
                      {entry.name}
                      {entry.assignedGroups > 0 ? ` (in service)` : ''}
                    </option>
                  ))}
                </select>
              </label>
              <label className="service-page__field service-bench__name">
                <span>Name</span>
                <input
                  type="text"
                  value={name}
                  maxLength={60}
                  placeholder="Budget short-haul"
                  onChange={(event) => setName(event.target.value)}
                />
              </label>
              <Button
                variant="primary"
                className="service-bench__save"
                disabled={saving}
                onClick={() => void save()}
              >
                {editing === '' ? 'Save package' : 'Save changes'}
              </Button>
              {saved !== null && (
                <p className="service-bench__saved" role="status">
                  Saved “{saved}”.
                </p>
              )}
              {failure !== null && (
                <StateBlock
                  kind={failure.status === 0 || failure.status >= 500 ? 'broken' : 'refused'}
                  className="service-bench__failure"
                >
                  {failure.message}
                </StateBlock>
              )}
            </section>

            {(groups?.groups ?? []).length > 0 && (
              <section className="service-bench" aria-label="In service">
                <p className="service-bench__hint">
                  A saved package only reaches a flight once a route group flies it.
                </p>
                {(groups?.groups ?? []).map((group) => (
                  <label key={group.id} className="service-page__field">
                    <span>{group.name}</span>
                    <select
                      value={group.servicePackageId ?? ''}
                      disabled={saving}
                      onChange={(event) => void assign(group.id, event.target.value)}
                    >
                      <option value="">Baseline service</option>
                      {packages.map((entry) => (
                        <option key={entry.id} value={entry.id}>
                          {entry.name}
                        </option>
                      ))}
                    </select>
                  </label>
                ))}
              </section>
            )}

            {catalogue.categories.map((category) => (
              <fieldset key={category.category} className="service-ladder">
                <legend>{category.category.replaceAll('_', ' ')}</legend>
                {category.tiers.map((tier) => (
                  <label key={tier.tier} className="service-ladder__rung">
                    <input
                      type="radio"
                      name={`${cabin}-${category.category}`}
                      checked={selectedTier(category.category) === tier.tier}
                      onChange={() => setTier(category.category, tier.tier)}
                    />
                    <span className="service-ladder__name">{tier.name}</span>
                    <span className="service-ladder__price">
                      {tier.revenuePerPaxMinor > tier.costPerPaxMinor
                        ? `+${money(tier.revenuePerPaxMinor - tier.costPerPaxMinor)}`
                        : money(tier.costPerPaxMinor - tier.revenuePerPaxMinor)}
                    </span>
                  </label>
                ))}
              </fieldset>
            ))}

            <label className="service-page__field service-page__intensity">
              <span>Commercial intensity</span>
              <input
                type="range"
                min={0}
                max={100}
                value={Math.round(content.commercialIntensity * 100)}
                onChange={(event) =>
                  setContent((current) => ({
                    ...current,
                    commercialIntensity: Number(event.target.value) / 100,
                  }))
                }
              />
              <output>{Math.round(content.commercialIntensity * 100)}%</output>
            </label>
          </div>

          <aside className="service-payback" aria-label="Payback" aria-busy={pricing}>
            <h2 className="service-payback__title">Does it pay back?</h2>

            {payback === null ? (
              <StateBlock kind="loading">Pricing the package…</StateBlock>
            ) : payback.context.routes === 0 ? (
              <StateBlock kind="empty">
                You fly no routes yet, so there is no segment mix to price this against. Open a
                route and the table fills in.
              </StateBlock>
            ) : (
              <>
                <p className="service-payback__context">
                  Against <strong>{payback.context.routes}</strong>{' '}
                  {payback.context.routeGroupName ?? 'route'}
                  {payback.context.routeGroupName === null && payback.context.routes !== 1
                    ? 's'
                    : ''}
                  , average fare {money(payback.context.averageFareMinor)}.
                </p>

                {cabinLine !== null && (
                  <dl className="service-payback__totals">
                    <div>
                      <dt>Cost / pax</dt>
                      <dd>{money(cabinLine.costPerPaxMinor)}</dd>
                    </div>
                    <div>
                      <dt>Earns / pax</dt>
                      <dd>{money(cabinLine.revenuePerPaxMinor)}</dd>
                    </div>
                    <div>
                      <dt>Product</dt>
                      <dd>
                        {cabinLine.productScore.toFixed(2)}{' '}
                        <span className="service-payback__delta">
                          ({cabinLine.productDelta >= 0 ? '+' : ''}
                          {cabinLine.productDelta.toFixed(2)})
                        </span>
                      </dd>
                    </div>
                    <div>
                      <dt>Turnaround</dt>
                      <dd>
                        {cabinLine.turnaroundDeltaMinutes >= 0 ? '+' : ''}
                        {cabinLine.turnaroundDeltaMinutes} min
                      </dd>
                    </div>
                  </dl>
                )}

                <table className="service-payback__table">
                  <caption className="service-payback__caption">
                    The identical package is worth a different amount to each segment — not because
                    the service differs, but because of who is in the seat.
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col">Segment</th>
                      <th scope="col">Mix</th>
                      <th scope="col">Utility</th>
                      <th scope="col">Fare premium</th>
                      <th scope="col">Net / pax</th>
                    </tr>
                  </thead>
                  <tbody>
                    {payback.segments.map((row) => (
                      <tr key={row.segment}>
                        <th scope="row">{SEGMENT_LABEL[row.segment] ?? row.segment}</th>
                        <td>{Math.round(row.share * 100)}%</td>
                        <td>
                          {row.utilityGain >= 0 ? '+' : ''}
                          {row.utilityGain.toFixed(3)}
                        </td>
                        <td>{money(row.farePremiumSupportedMinor)}</td>
                        <td
                          className="service-payback__net"
                          data-positive={row.netPerPaxMinor >= 0}
                        >
                          {row.netPerPaxMinor >= 0 ? '+' : ''}
                          {money(row.netPerPaxMinor)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>

                <p
                  className="service-payback__verdict"
                  data-positive={payback.weightedNetPerPaxMinor >= 0}
                  role="status"
                >
                  <span>Weighted by your own mix</span>
                  <strong>
                    {payback.weightedNetPerPaxMinor >= 0 ? '+' : ''}
                    {money(payback.weightedNetPerPaxMinor)} per passenger
                  </strong>
                </p>

                {/*
                  App. D.1's point, made where it is actionable: a high tier run
                  badly is the most expensive mistake in the catalogue, and the
                  lever holding it down is nameable.
                */}
                <p className="service-payback__execution">
                  Execution {(payback.execution.value * 100).toFixed(0)}%
                  {payback.execution.weakest.length > 0 && (
                    <>
                      {' — held down by '}
                      {payback.execution.weakest
                        .join(', ')
                        .replaceAll(/([A-Z])/g, ' $1')
                        .toLowerCase()}
                    </>
                  )}
                  {payback.execution.fromFallback &&
                    ' — nothing measurable yet, so a reference is used'}
                </p>
              </>
            )}
          </aside>
        </div>
      )}
    </section>
  );
}
