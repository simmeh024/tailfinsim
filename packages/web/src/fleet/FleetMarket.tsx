import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useSearchParams } from 'react-router';

import type {
  AircraftAcquisitionQuoteResponse,
  AircraftAcquisitionResponse,
  AircraftAvailabilityState,
  AircraftClass,
  CatalogueEntry,
  CatalogueOption,
  FleetCatalogueResponse,
  OwnAirlineResponse,
  UsedMarketListing,
  UsedMarketResponse,
} from '@tailfin/shared';

import { fetchOwnAirline } from '../airline/api';
import { useContextSelection } from '../shell/context-selection';

import { AircraftImage } from './AircraftImage';
import { acquireAircraft, fetchUsedMarket, quoteAircraft, type FleetApiRefusal } from './api';
import {
  AVAILABILITY_LABEL,
  browseCatalogue,
  CLASS_LABEL,
  exposesMethod,
  formatMoney,
  type MarketFilters,
} from './market-model';

import type { ReactNode } from 'react';

const MAX_COMPARE = 3;

const DEFAULT_FILTERS: MarketFilters = {
  query: '',
  manufacturer: 'all',
  aircraftClass: 'all',
  availability: 'all',
  role: 'all',
  method: 'all',
  sort: 'name',
};

function cardId(designation: string): string {
  return `market-card-${designation.toLocaleLowerCase().replaceAll(/[^a-z0-9]+/g, '-')}`;
}

function categoryLabel(category: string): string {
  return category.replaceAll('_', ' ');
}

function integer(value: number): string {
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(value);
}

function decimal(value: number, digits = 1): string {
  return new Intl.NumberFormat('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value);
}

function dateLabel(value: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(value));
}

function CatalogueCard({
  entry,
  selected,
  compared,
  compareFull,
  usedCount,
  onSelect,
  onCompare,
}: {
  entry: CatalogueEntry;
  selected: boolean;
  compared: boolean;
  compareFull: boolean;
  usedCount: number;
  onSelect: () => void;
  onCompare: () => void;
}): ReactNode {
  return (
    <article
      className="market-card"
      data-selected={selected ? 'yes' : 'no'}
      data-availability={entry.availability}
    >
      <button
        id={cardId(entry.designation)}
        type="button"
        className="market-card__select"
        aria-current={selected ? 'true' : undefined}
        aria-label={`View ${entry.manufacturer} ${entry.designation}`}
        onClick={onSelect}
      >
        <span className="market-card__visual">
          <AircraftImage designation={entry.designation} manufacturer={entry.manufacturer} />
          <span className="market-card__status" data-status={entry.availability}>
            {AVAILABILITY_LABEL[entry.availability]}
          </span>
        </span>
        <span className="market-card__manufacturer">{entry.manufacturer}</span>
        <strong className="market-card__name">{entry.designation}</strong>
        <span className="market-card__class">{CLASS_LABEL[entry.class]}</span>
        <span className="market-card__figures">
          <span>
            <span>{entry.class === 'freighter' ? 'Payload' : 'Seats'}</span>
            <strong className="figure">
              {entry.class === 'freighter'
                ? `${decimal(entry.mtowTonnes)} t MTOW`
                : integer(entry.seatsTwoClass)}
            </strong>
          </span>
          <span>
            <span>Range</span>
            <strong className="figure">{integer(entry.rangeNm)} nm</strong>
          </span>
          <span>
            <span>Runway</span>
            <strong className="figure">{integer(entry.runwayRequirementM)} m</strong>
          </span>
          <span>
            <span>{entry.listPrice === null ? 'New' : 'List price'}</span>
            <strong className="figure">
              {entry.listPrice === null ? 'Unavailable' : formatMoney(entry.listPrice)}
            </strong>
          </span>
        </span>
        {usedCount > 0 && (
          <span className="market-card__inventory">{usedCount} used available</span>
        )}
      </button>
      <button
        type="button"
        className="market-card__compare"
        aria-pressed={compared}
        disabled={compareFull && !compared}
        onClick={onCompare}
      >
        {compared ? 'Remove from compare' : 'Compare'}
      </button>
    </article>
  );
}

function Comparison({
  entries,
  onRemove,
}: {
  entries: CatalogueEntry[];
  onRemove: (id: string) => void;
}): ReactNode {
  if (entries.length < 2) return null;
  const rows: { label: string; value: (entry: CatalogueEntry) => ReactNode }[] = [
    { label: 'Status', value: (entry) => AVAILABILITY_LABEL[entry.availability] },
    { label: 'Class', value: (entry) => CLASS_LABEL[entry.class] },
    {
      label: 'List price',
      value: (entry) => (entry.listPrice === null ? 'Unavailable' : formatMoney(entry.listPrice)),
    },
    {
      label: 'Seats',
      value: (entry) => (entry.seatsTwoClass === 0 ? 'Freighter' : integer(entry.seatsTwoClass)),
    },
    { label: 'Range', value: (entry) => `${integer(entry.rangeNm)} nm` },
    { label: 'Runway', value: (entry) => `${integer(entry.runwayRequirementM)} m` },
    { label: 'Wingspan code', value: (entry) => entry.wingspanCode },
  ];

  return (
    <section className="market-compare" aria-labelledby="market-compare-title">
      <div className="market-compare__head">
        <div>
          <span className="market__eyebrow">Side by side</span>
          <h3 id="market-compare-title">Aircraft comparison</h3>
        </div>
        <span>
          {entries.length} of {MAX_COMPARE}
        </span>
      </div>
      <div className="market-compare__scroll">
        <table>
          <thead>
            <tr>
              <th scope="col">Specification</th>
              {entries.map((entry) => (
                <th scope="col" key={entry.designation}>
                  <span>{entry.manufacturer}</span>
                  <strong>{entry.designation}</strong>
                  <button type="button" onClick={() => onRemove(entry.designation)}>
                    Remove
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.label}>
                <th scope="row">{row.label}</th>
                {entries.map((entry) => (
                  <td className="figure" key={entry.designation}>
                    {row.value(entry)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function SpecGrid({
  entry,
  effective,
}: {
  entry: CatalogueEntry;
  effective?: AircraftAcquisitionQuoteResponse['effectiveSpec'];
}): ReactNode {
  const spec = effective;
  return (
    <dl className="market-detail__spec-grid">
      <div>
        <dt>Typical seats</dt>
        <dd className="figure">{entry.seatsTwoClass || '—'}</dd>
      </div>
      <div>
        <dt>Maximum seats</dt>
        <dd className="figure">{(spec?.maxSeats ?? entry.maxSeats) || '—'}</dd>
      </div>
      <div>
        <dt>Maximum payload</dt>
        <dd className="figure">{spec ? `${decimal(spec.maxPayloadTonnes)} t` : 'Unavailable'}</dd>
      </div>
      <div>
        <dt>Range</dt>
        <dd className="figure">{integer(spec?.rangeNm ?? entry.rangeNm)} nm</dd>
      </div>
      <div>
        <dt>Cruise speed</dt>
        <dd className="figure">{spec ? `${integer(spec.cruiseSpeedKt)} kt` : 'Unavailable'}</dd>
      </div>
      <div>
        <dt>MTOW</dt>
        <dd className="figure">{decimal(spec?.mtowTonnes ?? entry.mtowTonnes)} t</dd>
      </div>
      <div>
        <dt>Operating empty</dt>
        <dd className="figure">{spec ? `${decimal(spec.oewTonnes)} t` : 'Unavailable'}</dd>
      </div>
      <div>
        <dt>Runway required</dt>
        <dd className="figure">
          {integer(spec?.runwayRequirementM ?? entry.runwayRequirementM)} m
        </dd>
      </div>
      <div>
        <dt>Fuel burn</dt>
        <dd className="figure">
          {spec ? `${integer(spec.fuelBurnKgPerHour)} kg/h` : 'Unavailable'}
        </dd>
      </div>
      <div>
        <dt>Wingspan code</dt>
        <dd className="figure">{spec?.wingspanCode ?? entry.wingspanCode}</dd>
      </div>
      <div>
        <dt>Noise chapter</dt>
        <dd className="figure">{spec?.noiseChapter ?? 'Unavailable'}</dd>
      </div>
      <div>
        <dt>Base turnaround</dt>
        <dd className="figure">
          {spec ? `${integer(spec.turnaroundBaselineMin)} min` : 'Unavailable'}
        </dd>
      </div>
    </dl>
  );
}

function UsedListingCard({
  listing,
  optionNames,
  canAcquire,
  onReview,
}: {
  listing: UsedMarketListing;
  optionNames: ReadonlyMap<string, string>;
  canAcquire: boolean;
  onReview: () => void;
}): ReactNode {
  return (
    <article className="used-listing">
      <div className="used-listing__head">
        <div>
          <strong>{listing.registration}</strong>
          <span>
            {listing.locationIcao} · {decimal(listing.valuation.ageYears)} years
          </span>
        </div>
        <strong className="figure">{formatMoney(listing.askingPriceMinor)}</strong>
      </div>
      <dl>
        <div>
          <dt>Hours</dt>
          <dd className="figure">{integer(listing.hours)}</dd>
        </div>
        <div>
          <dt>Cycles</dt>
          <dd className="figure">{integer(listing.cycles)}</dd>
        </div>
        <div>
          <dt>Range</dt>
          <dd className="figure">{integer(listing.effectiveSpec.rangeNm)} nm</dd>
        </div>
        <div>
          <dt>Seats</dt>
          <dd className="figure">{listing.effectiveSpec.seatsTwoClass || '—'}</dd>
        </div>
      </dl>
      <p className="used-listing__config">
        {listing.buildOptionIds.length === 0
          ? 'Standard factory configuration'
          : listing.buildOptionIds.map((id) => optionNames.get(id) ?? id).join(' · ')}
      </p>
      <p className="used-listing__valuation">
        Asking price: {decimal(listing.valuation.ageFactor, 2)} age ×{' '}
        {decimal(listing.valuation.utilisationFactor, 2)} utilisation ×{' '}
        {decimal(listing.valuation.configurationFactor, 2)} configuration.
      </p>
      {canAcquire && (
        <button type="button" className="market-action market-action--primary" onClick={onReview}>
          Review used purchase
        </button>
      )}
    </article>
  );
}

export function FleetMarket({
  catalogue,
  onAcquired,
}: {
  catalogue: FleetCatalogueResponse;
  onAcquired: (result: AircraftAcquisitionResponse) => void;
}): ReactNode {
  const [searchParams, setSearchParams] = useSearchParams();
  const {
    selection: contextSelection,
    select: selectContext,
    clear: clearContext,
    panelBody: contextPanelBody,
  } = useContextSelection();
  const [filters, setFilters] = useState<MarketFilters>(DEFAULT_FILTERS);
  const [selectedDesignation, setSelectedDesignation] = useState<string | null>(null);
  const [compareIds, setCompareIds] = useState<string[]>([]);
  const [tab, setTab] = useState<'overview' | 'specifications'>('overview');
  const [panelMode, setPanelMode] = useState<'detail' | 'used' | 'acquire'>('detail');
  const [usedMarket, setUsedMarket] = useState<UsedMarketResponse | null>(null);
  const [usedFailed, setUsedFailed] = useState(false);
  const [ownAirline, setOwnAirline] = useState<OwnAirlineResponse | null>(null);
  const [ownFailed, setOwnFailed] = useState(false);
  const [acquisitionKind, setAcquisitionKind] = useState<'new' | 'lease' | null>(null);
  const [selectedOptionIds, setSelectedOptionIds] = useState<string[]>([]);
  const [quote, setQuote] = useState<AircraftAcquisitionQuoteResponse | null>(null);
  const [quoteRefusal, setQuoteRefusal] = useState<FleetApiRefusal | null>(null);
  const [quoteLoading, setQuoteLoading] = useState(false);
  const [deliveryAirport, setDeliveryAirport] = useState('');
  const [reviewing, setReviewing] = useState(false);
  const [usedReview, setUsedReview] = useState<UsedMarketListing | null>(null);
  const [requestId, setRequestId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submissionRefusal, setSubmissionRefusal] = useState<FleetApiRefusal | null>(null);
  const [result, setResult] = useState<AircraftAcquisitionResponse | null>(null);
  const [compareNotice, setCompareNotice] = useState('');
  const initialSelectionApplied = useRef(false);

  const manufacturers = useMemo(
    () => [...new Set(catalogue.types.map((entry) => entry.manufacturer))].sort(),
    [catalogue.types],
  );
  const classes = useMemo(
    () => [...new Set(catalogue.types.map((entry) => entry.class))],
    [catalogue.types],
  );
  const statuses = useMemo(
    () => [...new Set(catalogue.types.map((entry) => entry.availability))],
    [catalogue.types],
  );
  const optionById = useMemo(
    () => new Map(catalogue.options.map((option) => [option.id, option])),
    [catalogue.options],
  );
  const usedCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const listing of usedMarket?.listings ?? []) {
      counts.set(listing.typeDesignation, (counts.get(listing.typeDesignation) ?? 0) + 1);
    }
    return counts;
  }, [usedMarket]);
  const visible = useMemo(
    () => browseCatalogue(catalogue.types, filters, usedCounts),
    [catalogue.types, filters, usedCounts],
  );
  const selected =
    catalogue.types.find((entry) => entry.designation === selectedDesignation) ?? null;
  const compareEntries = compareIds
    .map((id) => catalogue.types.find((entry) => entry.designation === id))
    .filter((entry): entry is CatalogueEntry => entry !== undefined);
  const typeOptions = selected
    ? selected.availableOptionIds
        .map((id) => optionById.get(id))
        .filter((option): option is CatalogueOption => option !== undefined)
    : [];
  const typeListings = selected
    ? (usedMarket?.listings ?? []).filter(
        (listing) => listing.typeDesignation === selected.designation,
      )
    : [];
  const activeAirline = ownAirline?.airline?.status === 'active';

  const closeDetail = useCallback(
    (previous: string) => {
      setSelectedDesignation(null);
      setPanelMode('detail');
      setSearchParams(
        (current) => {
          const next = new URLSearchParams(current);
          next.delete('market');
          next.delete('type');
          return next;
        },
        { replace: true },
      );
      requestAnimationFrame(() => {
        document.getElementById(cardId(previous))?.focus();
      });
    },
    [setSearchParams],
  );

  const publishSelection = useCallback(
    (entry: CatalogueEntry) => {
      selectContext({
        kind: 'fleet-market-type',
        id: entry.designation,
        title: entry.designation,
        subtitle: entry.manufacturer,
        body: null,
        onClear: () => closeDetail(entry.designation),
      });
    },
    [closeDetail, selectContext],
  );

  const selectType = useCallback(
    (entry: CatalogueEntry) => {
      setSelectedDesignation(entry.designation);
      setPanelMode('detail');
      setTab('overview');
      setSelectedOptionIds([]);
      setAcquisitionKind(null);
      setReviewing(false);
      setUsedReview(null);
      setRequestId(null);
      setResult(null);
      setSubmissionRefusal(null);
      setSearchParams(
        (current) => {
          const next = new URLSearchParams(current);
          next.delete('market');
          next.delete('type');
          return next;
        },
        { replace: true },
      );
      publishSelection(entry);
      requestAnimationFrame(() => document.getElementById('context-panel-title')?.focus());
    },
    [publishSelection, setSearchParams],
  );

  useEffect(() => {
    let live = true;
    void fetchUsedMarket()
      .then((value) => {
        if (live) setUsedMarket(value);
      })
      .catch(() => {
        if (live) setUsedFailed(true);
      });
    void fetchOwnAirline()
      .then((value) => {
        if (live) setOwnAirline(value);
      })
      .catch(() => {
        if (live) setOwnFailed(true);
      });
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    if (initialSelectionApplied.current || catalogue.types.length === 0) return;
    initialSelectionApplied.current = true;
    const linkedType = searchParams.get('type');
    const linked = catalogue.types.find((entry) => entry.designation === linkedType);
    const initial = linked ?? catalogue.types[0]!;
    setSelectedDesignation(initial.designation);
    publishSelection(initial);
    if (linked && searchParams.get('market') === 'used') setPanelMode('used');
  }, [catalogue.types, publishSelection, searchParams]);

  useEffect(() => clearContext, [clearContext]);

  useEffect(() => {
    if (panelMode !== 'acquire' || acquisitionKind === null || selected === null) {
      setQuote(null);
      setQuoteRefusal(null);
      setQuoteLoading(false);
      return;
    }
    let live = true;
    setQuote(null);
    setQuoteRefusal(null);
    setQuoteLoading(true);
    setReviewing(false);
    const input =
      acquisitionKind === 'lease'
        ? { kind: 'lease' as const, typeDesignation: selected.designation }
        : {
            kind: 'new' as const,
            typeDesignation: selected.designation,
            optionIds: selectedOptionIds,
          };
    void quoteAircraft(input)
      .then((outcome) => {
        if (!live) return;
        if (outcome.ok) setQuote(outcome.value);
        else setQuoteRefusal(outcome.refusal);
      })
      .catch(() => {
        if (live) {
          setQuoteRefusal({
            status: 0,
            code: 'quote_unavailable',
            message: 'The authoritative acquisition quote could not be loaded.',
          });
        }
      })
      .finally(() => {
        if (live) setQuoteLoading(false);
      });
    return () => {
      live = false;
    };
  }, [acquisitionKind, panelMode, selected, selectedOptionIds]);

  function toggleCompare(designation: string): void {
    setCompareIds((current) => {
      if (current.includes(designation)) {
        setCompareNotice(`${designation} removed from comparison.`);
        return current.filter((id) => id !== designation);
      }
      if (current.length >= MAX_COMPARE) {
        setCompareNotice(`Compare is limited to ${MAX_COMPARE} aircraft.`);
        return current;
      }
      setCompareNotice(`${designation} added to comparison.`);
      return [...current, designation];
    });
  }

  function beginAcquisition(kind: 'new' | 'lease'): void {
    setPanelMode('acquire');
    setAcquisitionKind(kind);
    setSelectedOptionIds([]);
    setReviewing(false);
    setUsedReview(null);
    setRequestId(null);
    setResult(null);
    setSubmissionRefusal(null);
  }

  function openUsedMarket(): void {
    if (!selected) return;
    setPanelMode('used');
    setUsedReview(null);
    setRequestId(null);
    setResult(null);
    setSubmissionRefusal(null);
    const next = new URLSearchParams(searchParams);
    next.set('market', 'used');
    next.set('type', selected.designation);
    setSearchParams(next);
  }

  async function refreshCommerce(): Promise<void> {
    const [airlineResult, usedResult] = await Promise.allSettled([
      fetchOwnAirline(),
      fetchUsedMarket(),
    ]);
    if (airlineResult.status === 'fulfilled') setOwnAirline(airlineResult.value);
    if (usedResult.status === 'fulfilled') setUsedMarket(usedResult.value);
  }

  async function submitTypeAcquisition(): Promise<void> {
    if (!selected || !quote || !acquisitionKind || deliveryAirport.length !== 4) return;
    const stableId = requestId ?? crypto.randomUUID();
    setRequestId(stableId);
    setSubmitting(true);
    setSubmissionRefusal(null);
    const input =
      acquisitionKind === 'lease'
        ? {
            requestId: stableId,
            kind: 'lease' as const,
            typeDesignation: selected.designation,
            deliveryAirportIcao: deliveryAirport,
          }
        : {
            requestId: stableId,
            kind: 'new' as const,
            typeDesignation: selected.designation,
            optionIds: quote.buildOptionIds,
            deliveryAirportIcao: deliveryAirport,
          };
    try {
      const outcome = await acquireAircraft(input);
      if (!outcome.ok) {
        setSubmissionRefusal(outcome.refusal);
        return;
      }
      setResult(outcome.value);
      onAcquired(outcome.value);
      await refreshCommerce();
    } catch {
      setSubmissionRefusal({
        status: 0,
        code: 'acquisition_unavailable',
        message: 'The acquisition response was lost. Retry safely with the same request id.',
      });
    } finally {
      setSubmitting(false);
    }
  }

  async function submitUsedAcquisition(): Promise<void> {
    if (!usedReview) return;
    const stableId = requestId ?? crypto.randomUUID();
    setRequestId(stableId);
    setSubmitting(true);
    setSubmissionRefusal(null);
    try {
      const outcome = await acquireAircraft({
        requestId: stableId,
        kind: 'used',
        listingId: usedReview.id,
      });
      if (!outcome.ok) {
        setSubmissionRefusal(outcome.refusal);
        return;
      }
      setResult(outcome.value);
      onAcquired(outcome.value);
      await refreshCommerce();
    } catch {
      setSubmissionRefusal({
        status: 0,
        code: 'acquisition_unavailable',
        message: 'The acquisition response was lost. Retry safely with the same request id.',
      });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="market" aria-labelledby="fleet-market-title">
      <header className="market__header">
        <div>
          <span className="market__eyebrow">Aircraft marketplace</span>
          <h2 id="fleet-market-title">Fleet catalogue</h2>
          <p>
            Browse the aircraft that exist on {dateLabel(catalogue.inGameDate)} in this world.
            Availability, specifications and prices come from catalogue {catalogue.catalogueVersion}
            .
          </p>
        </div>
        <div className="market__count">
          <strong className="figure">{visible.length}</strong>
          <span>of {catalogue.types.length} types</span>
        </div>
      </header>

      <div className="market-toolbar" aria-label="Aircraft catalogue controls">
        <label className="market-toolbar__search">
          <span>Search aircraft</span>
          <input
            type="search"
            value={filters.query}
            placeholder="Type or manufacturer"
            onChange={(event) => setFilters({ ...filters, query: event.target.value })}
          />
        </label>
        <label>
          <span>Manufacturer</span>
          <select
            value={filters.manufacturer}
            onChange={(event) => setFilters({ ...filters, manufacturer: event.target.value })}
          >
            <option value="all">All manufacturers</option>
            {manufacturers.map((manufacturer) => (
              <option key={manufacturer} value={manufacturer}>
                {manufacturer}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Class</span>
          <select
            value={filters.aircraftClass}
            onChange={(event) =>
              setFilters({ ...filters, aircraftClass: event.target.value as AircraftClass | 'all' })
            }
          >
            <option value="all">All classes</option>
            {classes.map((aircraftClass) => (
              <option key={aircraftClass} value={aircraftClass}>
                {CLASS_LABEL[aircraftClass]}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Status</span>
          <select
            value={filters.availability}
            onChange={(event) =>
              setFilters({
                ...filters,
                availability: event.target.value as AircraftAvailabilityState | 'all',
              })
            }
          >
            <option value="all">All statuses</option>
            {statuses.map((status) => (
              <option key={status} value={status}>
                {AVAILABILITY_LABEL[status]}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Role</span>
          <select
            value={filters.role}
            onChange={(event) =>
              setFilters({ ...filters, role: event.target.value as MarketFilters['role'] })
            }
          >
            <option value="all">Passenger & cargo</option>
            <option value="passenger">Passenger</option>
            <option value="cargo">Cargo</option>
          </select>
        </label>
        <label>
          <span>Acquisition</span>
          <select
            value={filters.method}
            onChange={(event) =>
              setFilters({ ...filters, method: event.target.value as MarketFilters['method'] })
            }
          >
            <option value="all">All methods</option>
            <option value="new">New available</option>
            <option value="lease">Lease available</option>
            <option value="used">Used inventory</option>
          </select>
        </label>
        <label>
          <span>Sort by</span>
          <select
            value={filters.sort}
            onChange={(event) =>
              setFilters({ ...filters, sort: event.target.value as MarketFilters['sort'] })
            }
          >
            <option value="name">Manufacturer / type</option>
            <option value="price">Price · low first</option>
            <option value="range">Range · high first</option>
            <option value="seats">Seats · high first</option>
            <option value="runway">Runway · short first</option>
          </select>
        </label>
        <button
          type="button"
          className="market-toolbar__clear"
          onClick={() => setFilters(DEFAULT_FILTERS)}
        >
          Clear filters
        </button>
      </div>

      {compareNotice && (
        <p className="market__announcer" role="status" aria-live="polite">
          {compareNotice}
        </p>
      )}
      <Comparison entries={compareEntries} onRemove={toggleCompare} />

      <div className="market__layout">
        <div className="market__catalogue">
          {visible.length === 0 ? (
            <div className="market__empty">
              <strong>No aircraft match these controls.</strong>
              <span>
                Clear a filter or broaden the search. Era-hidden types are not present in this
                world.
              </span>
            </div>
          ) : (
            <div className="market-grid">
              {visible.map((entry) => (
                <CatalogueCard
                  key={entry.designation}
                  entry={entry}
                  selected={selectedDesignation === entry.designation}
                  compared={compareIds.includes(entry.designation)}
                  compareFull={compareIds.length >= MAX_COMPARE}
                  usedCount={usedCounts.get(entry.designation) ?? 0}
                  onSelect={() => selectType(entry)}
                  onCompare={() => toggleCompare(entry.designation)}
                />
              ))}
            </div>
          )}
        </div>

        {contextPanelBody !== null &&
          contextSelection?.kind === 'fleet-market-type' &&
          contextSelection.id === selected?.designation &&
          selected !== null &&
          createPortal(
            <div
              className="market-detail"
              aria-label="Selected aircraft"
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  event.preventDefault();
                  closeDetail(selected.designation);
                  clearContext();
                }
              }}
            >
              <AircraftImage
                designation={selected.designation}
                manufacturer={selected.manufacturer}
                priority
                className="market-detail__image"
              />
              <div className="market-detail__status-row">
                <span className="market-detail__status" data-status={selected.availability}>
                  {AVAILABILITY_LABEL[selected.availability]}
                </span>
              </div>

              {panelMode === 'detail' && (
                <>
                  <div
                    className="market-detail__tabs"
                    role="tablist"
                    aria-label="Aircraft information"
                  >
                    <button
                      type="button"
                      role="tab"
                      aria-selected={tab === 'overview'}
                      onClick={() => setTab('overview')}
                    >
                      Overview
                    </button>
                    <button
                      type="button"
                      role="tab"
                      aria-selected={tab === 'specifications'}
                      onClick={() => setTab('specifications')}
                    >
                      Specifications
                    </button>
                  </div>
                  {tab === 'overview' ? (
                    <div className="market-detail__body">
                      <p className="market-detail__summary">{selected.detail}</p>
                      <dl className="market-detail__overview">
                        <div>
                          <dt>Category</dt>
                          <dd>{CLASS_LABEL[selected.class]}</dd>
                        </div>
                        <div>
                          <dt>Role</dt>
                          <dd>{selected.class === 'freighter' ? 'Cargo' : 'Passenger'}</dd>
                        </div>
                        <div>
                          <dt>Seats</dt>
                          <dd className="figure">{selected.seatsTwoClass || '—'}</dd>
                        </div>
                        <div>
                          <dt>Range</dt>
                          <dd className="figure">{integer(selected.rangeNm)} nm</dd>
                        </div>
                        <div>
                          <dt>Runway</dt>
                          <dd className="figure">{integer(selected.runwayRequirementM)} m</dd>
                        </div>
                        <div>
                          <dt>List price</dt>
                          <dd className="figure">
                            {selected.listPrice === null
                              ? 'Unavailable'
                              : formatMoney(selected.listPrice)}
                          </dd>
                        </div>
                        <div>
                          <dt>Factory lead</dt>
                          <dd className="figure">
                            {selected.acquisitionMethods.includes('new')
                              ? `${selected.baseDeliveryLeadWeeks} weeks`
                              : 'Unavailable'}
                          </dd>
                        </div>
                        <div>
                          <dt>Entry into service</dt>
                          <dd>
                            {selected.arrivesOn
                              ? dateLabel(selected.arrivesOn)
                              : 'Not exposed by this catalogue response'}
                          </dd>
                        </div>
                      </dl>
                      {selected.restrictions.length > 0 && (
                        <div className="market-detail__restrictions">
                          <strong>Operating restrictions</strong>
                          <ul>
                            {selected.restrictions.map((restriction) => (
                              <li key={`${restriction.kind}-${restriction.since}`}>
                                {restriction.note} · {formatMoney(restriction.amountMinor)} per
                                departure since {restriction.since}
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}
                    </div>
                  ) : (
                    <SpecGrid entry={selected} />
                  )}

                  <div className="market-detail__actions">
                    {ownFailed && (
                      <p role="alert">
                        Financial status is unavailable; acquisition controls are withheld.
                      </p>
                    )}
                    {ownAirline?.airline && !activeAirline && (
                      <p>
                        This airline is {ownAirline.airline.status}; new financial commitments are
                        unavailable.
                      </p>
                    )}
                    {activeAirline && exposesMethod(selected, 'new', typeListings.length) && (
                      <button
                        type="button"
                        className="market-action market-action--primary"
                        onClick={() => beginAcquisition('new')}
                      >
                        Order new
                      </button>
                    )}
                    {activeAirline && exposesMethod(selected, 'lease', typeListings.length) && (
                      <button
                        type="button"
                        className="market-action"
                        onClick={() => beginAcquisition('lease')}
                      >
                        Lease
                      </button>
                    )}
                    {exposesMethod(selected, 'used', typeListings.length) && (
                      <button type="button" className="market-action" onClick={openUsedMarket}>
                        View used aircraft <span>{typeListings.length}</span>
                      </button>
                    )}
                    {usedFailed && <p role="alert">Used inventory could not be checked.</p>}
                    {!exposesMethod(selected, 'new', typeListings.length) &&
                      !exposesMethod(selected, 'lease', typeListings.length) &&
                      !exposesMethod(selected, 'used', typeListings.length) && (
                        <p>
                          No acquisition path is available for this type at the current world date.
                        </p>
                      )}
                  </div>
                </>
              )}

              {panelMode === 'used' && (
                <div className="market-detail__body">
                  <button
                    type="button"
                    className="market-detail__back"
                    onClick={() => {
                      setPanelMode('detail');
                      setUsedReview(null);
                    }}
                  >
                    ← Back to type
                  </button>
                  {result ? (
                    <div className="acquisition-result" role="status">
                      <strong>{result.order.typeDesignation} acquired</strong>
                      <p>
                        {result.airframe
                          ? `${result.airframe.registration} is now in your fleet at ${result.airframe.deliveredToIcao}.`
                          : `Order ${result.order.id} was accepted.`}
                      </p>
                      {result.replayed && (
                        <p>
                          This was a safe replay of the original request; no second charge was made.
                        </p>
                      )}
                    </div>
                  ) : usedReview ? (
                    <div className="acquisition-review">
                      <span className="market__eyebrow">Explicit confirmation</span>
                      <h4>Buy {usedReview.registration}</h4>
                      <dl>
                        <div>
                          <dt>Aircraft</dt>
                          <dd>
                            {selected.designation} · {usedReview.registration}
                          </dd>
                        </div>
                        <div>
                          <dt>Configuration</dt>
                          <dd>
                            {usedReview.buildOptionIds.length
                              ? usedReview.buildOptionIds
                                  .map((id) => optionById.get(id)?.name ?? id)
                                  .join(', ')
                              : 'Standard'}
                          </dd>
                        </div>
                        <div>
                          <dt>Price / cash impact</dt>
                          <dd className="figure">−{formatMoney(usedReview.askingPriceMinor)}</dd>
                        </div>
                        <div>
                          <dt>Delivery</dt>
                          <dd>Immediate at {usedReview.locationIcao}</dd>
                        </div>
                        <div>
                          <dt>Current cash</dt>
                          <dd className="figure">
                            {ownAirline?.airline
                              ? formatMoney(ownAirline.airline.cash)
                              : 'Unavailable'}
                          </dd>
                        </div>
                      </dl>
                      {submissionRefusal && (
                        <p className="acquisition-error" role="alert">
                          {submissionRefusal.message}
                        </p>
                      )}
                      <div className="acquisition-review__buttons">
                        <button
                          type="button"
                          className="market-action"
                          onClick={() => {
                            setUsedReview(null);
                            setRequestId(null);
                            setSubmissionRefusal(null);
                          }}
                        >
                          Cancel
                        </button>
                        <button
                          type="button"
                          className="market-action market-action--primary"
                          disabled={submitting}
                          onClick={() => void submitUsedAcquisition()}
                        >
                          {submitting ? 'Submitting…' : 'Confirm used purchase'}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <div className="used-market__intro">
                        <strong>
                          {typeListings.length} physical airframe
                          {typeListings.length === 1 ? '' : 's'}
                        </strong>
                        <span>
                          {usedMarket
                            ? `${usedMarket.listings.length} of ${usedMarket.slots} market berths occupied worldwide.`
                            : 'Loading inventory…'}
                        </span>
                      </div>
                      {typeListings.map((listing) => (
                        <UsedListingCard
                          key={listing.id}
                          listing={listing}
                          optionNames={
                            new Map([...optionById].map(([id, option]) => [id, option.name]))
                          }
                          canAcquire={activeAirline}
                          onReview={() => {
                            setUsedReview(listing);
                            setRequestId(null);
                            setSubmissionRefusal(null);
                          }}
                        />
                      ))}
                    </>
                  )}
                </div>
              )}

              {panelMode === 'acquire' && acquisitionKind && (
                <div className="market-detail__body">
                  <button
                    type="button"
                    className="market-detail__back"
                    onClick={() => {
                      setPanelMode('detail');
                      setAcquisitionKind(null);
                    }}
                  >
                    ← Back to type
                  </button>
                  {result ? (
                    <div className="acquisition-result" role="status">
                      <strong>
                        {result.order.kind === 'new' ? 'Factory order accepted' : 'Lease delivered'}
                      </strong>
                      <p>
                        {result.order.typeDesignation} · {formatMoney(result.order.chargedMinor)}{' '}
                        charged.
                      </p>
                      <p>
                        {result.airframe
                          ? `${result.airframe.registration} is now in your fleet.`
                          : `Delivery is scheduled for ${dateLabel(result.order.deliveryAt)}.`}
                      </p>
                      {result.replayed && (
                        <p>This was a safe replay; no second charge or aircraft was created.</p>
                      )}
                    </div>
                  ) : (
                    <>
                      <div className="acquisition-heading">
                        <span className="market__eyebrow">
                          {acquisitionKind === 'new' ? 'Buy new' : 'Lease'}
                        </span>
                        <h4>
                          {acquisitionKind === 'new'
                            ? 'Configure factory order'
                            : 'Review lease offer'}
                        </h4>
                      </div>
                      {acquisitionKind === 'new' && typeOptions.length > 0 && !reviewing && (
                        <fieldset className="factory-options">
                          <legend>Factory configuration</legend>
                          {typeOptions.map((option) => (
                            <label
                              key={option.id}
                              data-selected={selectedOptionIds.includes(option.id) ? 'yes' : 'no'}
                            >
                              <input
                                type="checkbox"
                                checked={selectedOptionIds.includes(option.id)}
                                onChange={() =>
                                  setSelectedOptionIds((current) =>
                                    current.includes(option.id)
                                      ? current.filter((id) => id !== option.id)
                                      : [...current, option.id],
                                  )
                                }
                              />
                              <span>
                                <strong>{option.name}</strong>
                                <small>
                                  {categoryLabel(option.category)} · {option.summary}
                                </small>
                                <small className="figure">
                                  {option.priceMinor === 0
                                    ? 'No price charge'
                                    : `+${formatMoney(option.priceMinor)}`}{' '}
                                  · +{option.leadTimeWeeks} weeks
                                </small>
                              </span>
                            </label>
                          ))}
                        </fieldset>
                      )}
                      {quoteLoading && (
                        <p className="acquisition-loading">
                          Folding the authoritative effective specification…
                        </p>
                      )}
                      {quoteRefusal && (
                        <p className="acquisition-error" role="alert">
                          {quoteRefusal.message}
                          {quoteRefusal.fields?.optionIds?.map((message) => (
                            <span key={message}>{message}</span>
                          ))}
                        </p>
                      )}
                      {quote && !reviewing && (
                        <>
                          <div className="acquisition-quote">
                            <dl>
                              <div>
                                <dt>
                                  {acquisitionKind === 'lease'
                                    ? 'Deposit due'
                                    : 'Authoritative price'}
                                </dt>
                                <dd className="figure">{formatMoney(quote.chargedMinor)}</dd>
                              </div>
                              {quote.monthlyLeaseRateMinor !== null && (
                                <div>
                                  <dt>Monthly obligation</dt>
                                  <dd className="figure">
                                    {formatMoney(quote.monthlyLeaseRateMinor)}
                                  </dd>
                                </div>
                              )}
                              <div>
                                <dt>Delivery</dt>
                                <dd>
                                  {quote.totalLeadTimeWeeks === 0
                                    ? 'Immediate'
                                    : `${quote.totalLeadTimeWeeks} real weeks · est. ${dateLabel(quote.estimatedDeliveryAt)}`}
                                </dd>
                              </div>
                              <div>
                                <dt>Current cash</dt>
                                <dd className="figure">{formatMoney(quote.cashMinor)}</dd>
                              </div>
                              <div>
                                <dt>After acceptance</dt>
                                <dd
                                  className="figure"
                                  data-negative={quote.resultingCashMinor < 0 ? 'yes' : 'no'}
                                >
                                  {formatMoney(quote.resultingCashMinor)}
                                </dd>
                              </div>
                            </dl>
                          </div>
                          <h5>Effective specification</h5>
                          <SpecGrid entry={selected} effective={quote.effectiveSpec} />
                          <label className="delivery-field">
                            <span>Delivery airport ICAO</span>
                            <input
                              value={deliveryAirport}
                              maxLength={4}
                              autoCapitalize="characters"
                              placeholder="EHAM"
                              onChange={(event) =>
                                setDeliveryAirport(
                                  event.target.value.toLocaleUpperCase().replaceAll(/[^A-Z]/g, ''),
                                )
                              }
                            />
                            <small>
                              The server validates that this is a known airport when the order is
                              submitted.
                            </small>
                          </label>
                          <button
                            type="button"
                            className="market-action market-action--primary"
                            disabled={deliveryAirport.length !== 4 || quote.resultingCashMinor < 0}
                            onClick={() => setReviewing(true)}
                          >
                            Review {acquisitionKind === 'new' ? 'order' : 'lease'}
                          </button>
                          {quote.resultingCashMinor < 0 && (
                            <p className="acquisition-error">
                              The current cash snapshot is below this quote. The server will
                              validate funds again.
                            </p>
                          )}
                        </>
                      )}
                      {quote && reviewing && (
                        <div className="acquisition-review">
                          <span className="market__eyebrow">Explicit confirmation</span>
                          <h4>
                            {acquisitionKind === 'new' ? 'Place factory order' : 'Accept lease'}
                          </h4>
                          <dl>
                            <div>
                              <dt>Aircraft</dt>
                              <dd>
                                {selected.manufacturer} {selected.designation}
                              </dd>
                            </div>
                            <div>
                              <dt>Configuration</dt>
                              <dd>
                                {quote.buildOptionIds.length
                                  ? quote.buildOptionIds
                                      .map((id) => optionById.get(id)?.name ?? id)
                                      .join(', ')
                                  : 'Standard factory specification'}
                              </dd>
                            </div>
                            <div>
                              <dt>Price / cash impact</dt>
                              <dd className="figure">−{formatMoney(quote.chargedMinor)}</dd>
                            </div>
                            <div>
                              <dt>Delivery</dt>
                              <dd>
                                {quote.totalLeadTimeWeeks === 0
                                  ? `Immediate at ${deliveryAirport}`
                                  : `${dateLabel(quote.estimatedDeliveryAt)} at ${deliveryAirport}`}
                              </dd>
                            </div>
                            <div>
                              <dt>Resulting cash</dt>
                              <dd className="figure">{formatMoney(quote.resultingCashMinor)}</dd>
                            </div>
                          </dl>
                          {submissionRefusal && (
                            <p className="acquisition-error" role="alert">
                              {submissionRefusal.message}
                            </p>
                          )}
                          <div className="acquisition-review__buttons">
                            <button
                              type="button"
                              className="market-action"
                              onClick={() => {
                                setReviewing(false);
                                setRequestId(null);
                                setSubmissionRefusal(null);
                              }}
                            >
                              Change order
                            </button>
                            <button
                              type="button"
                              className="market-action market-action--primary"
                              disabled={submitting}
                              onClick={() => void submitTypeAcquisition()}
                            >
                              {submitting
                                ? 'Submitting…'
                                : acquisitionKind === 'new'
                                  ? 'Confirm and order'
                                  : 'Confirm lease deposit'}
                            </button>
                          </div>
                        </div>
                      )}
                    </>
                  )}
                </div>
              )}
            </div>,
            contextPanelBody,
          )}
      </div>
    </section>
  );
}
