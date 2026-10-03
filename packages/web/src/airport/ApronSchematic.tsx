import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  TURNAROUND_PHASE_WINDOWS,
  turnaroundProgress,
  type AirportGatesResponse,
  type AirportStand,
  type ApronAircraft,
  type ApronAircraftSize,
  type ApronResponse,
  type StandKind,
  type TurnaroundPhase,
} from '@tailfin/shared';

import { Button } from '../ui/Button';

import {
  HEAT_GLYPH,
  HEAT_LABEL,
  heatBand,
  holdersInWords,
  liveMovements,
  movementPoint,
  percent,
  ringsInWords,
  runwayFor,
  standAccessibleName,
  standState,
  type HeatBand,
} from './apron-presentation';
import { AircraftPanel, StandPanel } from './ApronPanels';
import {
  assignAircraft,
  layoutApron,
  rectCenter,
  type ApronLayout,
  type Rect,
  type StandSlot,
} from './layout';
import { useApronCamera } from './useApronCamera';

import type { KeyboardEvent, MouseEvent, ReactNode } from 'react';

/**
 * The schematic itself (M7-07, App. B.7): the apron in SVG, its aircraft, the
 * runways, and the two panels.
 *
 * SVG rather than the world renderer's WebGL because App. H.2 says the airport
 * view is *"always a stylised 2D schematic regardless of projection — an apron
 * is a floor plan, not a landscape"*: it must look the same whichever
 * projection the player came from, it is a few hundred shapes rather than a
 * planet, and every stand is a real, focusable element a keyboard can reach.
 *
 * ## Colour is data where it is identity, and a token everywhere else
 *
 * An airline's colour arrives from the server — the same `airlineMapColour` its
 * routes and planes wear on the world map — and is the one colour on the page
 * that is not a theme token. App. B.7: *"Your gates highlighted in your brand
 * colours — the airport visibly becomes yours as you grow."* Rival stands are
 * muted tokens and unleased stands an outline, and each of the three also says
 * what it is in its accessible name, so none of them depends on hue.
 */

/** A top-down aeroplane, nose up, centred on the origin: ±48 wide, ±50 long. */
const AIRCRAFT_PATH =
  'M0 -50 L6 -38 L6 -8 L48 10 L48 18 L6 10 L5 34 L18 44 L18 50 L0 46 L-18 50 L-18 44 L-5 34 L-6 10 L-48 18 L-48 10 L-6 -8 L-6 -38 Z';

/** How much of a stand the sprite fills, by size: a widebody all of it, a regional most. */
const AIRCRAFT_SCALE: Record<ApronAircraftSize, number> = {
  regional: 0.24,
  narrowbody: 0.3,
  widebody: 0.36,
};

const RING_RADIUS = 2.6;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

type Selection = { kind: 'stand'; id: string } | { kind: 'aircraft'; key: string } | null;

/**
 * A stand's identity on the map: its kind and its position together.
 *
 * Position alone is what a lease addresses, but M7-06's labels collide at a
 * flagship — its cargo stands `C1`–`C8` share their names with pier C's gates —
 * and a map keyed by position would draw one and lose the other.
 */
function standId(stand: { kind: StandKind; position: string }): string {
  return `${stand.kind}:${stand.position}`;
}

/** Which of two same-named stands an aeroplane is drawn on: a passenger stand first. */
const KIND_PRIORITY: readonly StandKind[] = [
  'contact_gate',
  'remote_stand',
  'overnight_parking',
  'maintenance_stand',
  'cargo_stand',
];

export interface ApronSchematicProps {
  apron: ApronResponse;
  /** The world's game clock now — the live one, or the read's own `gameNow` before it syncs. */
  now: Date;
  heat: boolean;
  onExit: () => void;
  onGates: (gates: AirportGatesResponse) => void;
}

export function ApronSchematic({
  apron,
  now,
  heat,
  onExit,
  onGates,
}: ApronSchematicProps): ReactNode {
  const stands = apron.gates.stands;
  const positions = useMemo(() => new Set(stands.map((stand) => stand.position)), [stands]);
  const placement = useMemo(
    () => assignAircraft(apron.aircraft, positions),
    [apron.aircraft, positions],
  );
  /*
   * The layout depends on the stands, the runways and how many aircraft need the
   * overflow — not on who holds what — so a lease repaints a stand without
   * moving anything.
   */
  const standKey = stands.map(standId).join(',');
  const layout = useMemo(
    () =>
      layoutApron({
        stands: stands.map(({ position, kind }) => ({ position, kind })),
        runways: apron.runways,
        overflowCount: placement.overflow.length,
      }),
    // `standKey` stands in for `stands`, whose identity changes on every lease.
    [standKey, apron.runways, placement.overflow.length],
  );

  const svgRef = useRef<SVGSVGElement>(null);
  const camera = useApronCamera(svgRef, layout.width, layout.height, onExit);
  const [selection, setSelection] = useState<Selection>(null);
  const [hovered, setHovered] = useState<string | null>(null);

  const slotOf = useMemo(
    () => new Map(layout.stands.map((slot) => [standId(slot), slot])),
    [layout],
  );
  const standOf = useMemo(() => new Map(stands.map((stand) => [standId(stand), stand])), [stands]);
  /** The slot an aeroplane on `position` is drawn on, preferring a passenger stand. */
  const slotAtPosition = useMemo(() => {
    const ranked = [...layout.stands].sort(
      (a, b) => KIND_PRIORITY.indexOf(a.kind) - KIND_PRIORITY.indexOf(b.kind),
    );
    const byPosition = new Map<string, StandSlot>();
    for (const slot of ranked)
      if (!byPosition.has(slot.position)) byPosition.set(slot.position, slot);
    return byPosition;
  }, [layout]);

  /** Where each aeroplane is drawn: its stand, or its place on the overflow apron. */
  const aircraftPlaces = useMemo(() => {
    const places = new Map<string, { rect: Rect; heading: number; position: string | null }>();
    for (const plane of apron.aircraft) {
      const position = placement.onStand.get(plane.key);
      const slot = position === undefined ? undefined : slotAtPosition.get(position);
      if (slot !== undefined && position !== undefined) {
        places.set(plane.key, { rect: slot.rect, heading: slot.heading, position });
        continue;
      }
      const index = placement.overflow.indexOf(plane.key);
      const spot = layout.overflow[index];
      if (spot !== undefined) places.set(plane.key, { ...spot, position: null });
    }
    return places;
  }, [apron.aircraft, placement, slotAtPosition, layout.overflow]);

  /*
   * Closing a panel puts focus back on whatever opened it, so a keyboard user
   * does not start again at the top of the apron. Done after the render that
   * removes the panel, because the panel held focus until then.
   */
  const returnFocusTo = useRef<Selection>(null);
  const close = useCallback(() => {
    returnFocusTo.current = selection;
    setSelection(null);
  }, [selection]);
  useEffect(() => {
    const target = returnFocusTo.current;
    if (selection !== null || target === null) return;
    returnFocusTo.current = null;
    const [attribute, value] =
      target.kind === 'stand' ? ['data-stand-id', target.id] : ['data-aircraft', target.key];
    const element = [
      ...(svgRef.current?.querySelectorAll<SVGGElement>(`[${attribute}]`) ?? []),
    ].find((candidate) => candidate.getAttribute(attribute) === value);
    element?.focus();
  }, [selection]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape' && selection !== null) {
      event.stopPropagation();
      close();
    }
  };

  /** A click that ended a drag is not a click. Keyboard activation (detail 0) always is. */
  const activate = (event: MouseEvent, next: Selection) => {
    if (event.detail !== 0 && camera.wasDrag()) return;
    setSelection(next);
  };
  const onKeyActivate = (event: KeyboardEvent, next: Selection) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      setSelection(next);
    }
  };

  const selectedStand = selection?.kind === 'stand' ? standOf.get(selection.id) : undefined;
  const selectedAircraft =
    selection?.kind === 'aircraft'
      ? apron.aircraft.find((plane) => plane.key === selection.key)
      : undefined;
  const dayOf = (position: string) => apron.standDays.find((day) => day.position === position);

  const movements = liveMovements(apron.movements, now);
  const hoveredStand = hovered === null ? undefined : standOf.get(hovered);
  const hoveredSlot = hovered === null ? undefined : slotOf.get(hovered);

  return (
    <div className="apron" onKeyDown={onKeyDown}>
      <div className="apron__stage">
        <svg
          ref={svgRef}
          className="apron__svg"
          viewBox={camera.viewBox}
          preserveAspectRatio="xMidYMid meet"
          role="group"
          aria-label={`Schematic of ${apron.name}`}
          data-zoom={camera.zoom.toFixed(2)}
          {...camera.pointerHandlers}
        >
          <rect className="apron__ground" x={0} y={0} width={layout.width} height={layout.height} />

          <Ground layout={layout} />

          {layout.stands.map((slot) => {
            const id = standId(slot);
            const stand = standOf.get(id);
            if (stand === undefined) return null;
            return (
              <StandShape
                key={id}
                id={id}
                slot={slot}
                stand={stand}
                youColour={apron.you.colour}
                heat={heat}
                selected={selection?.kind === 'stand' && selection.id === id}
                onActivate={(event) => {
                  activate(event, { kind: 'stand', id });
                }}
                onKey={(event) => {
                  onKeyActivate(event, { kind: 'stand', id });
                }}
                onHover={setHovered}
              />
            );
          })}

          {apron.aircraft.map((plane) => {
            const place = aircraftPlaces.get(plane.key);
            if (place === undefined) return null;
            const progress = turnaroundProgress(
              new Date(plane.arrivedAt),
              plane.departsAt === null ? null : new Date(plane.departsAt),
              now,
            );
            return (
              <AircraftSprite
                key={plane.key}
                plane={plane}
                rect={place.rect}
                heading={place.heading}
                progress={progress}
                selected={selection?.kind === 'aircraft' && selection.key === plane.key}
                onActivate={(event) => {
                  activate(event, { kind: 'aircraft', key: plane.key });
                }}
                onKey={(event) => {
                  onKeyActivate(event, { kind: 'aircraft', key: plane.key });
                }}
              />
            );
          })}

          {movements.map((movement, index) => {
            const runway = runwayFor(movement.kind, layout.runways);
            if (runway === undefined) return null;
            const point = movementPoint(runway, movement, now);
            const scale = AIRCRAFT_SCALE.narrowbody;
            return (
              <g
                key={`${movement.kind}-${movement.at}-${String(index)}`}
                className="apron__movement"
                data-movement={movement.kind}
                transform={`translate(${String(point.x)} ${String(point.y)}) rotate(${String(point.heading)}) scale(${String(scale)})`}
              >
                <title>
                  {`${movement.airline.name} ${movement.typeDesignation ?? ''} ${movement.kind === 'arrival' ? 'landing from' : 'departing for'} ${movement.otherIcao}`.replace(
                    /\s+/g,
                    ' ',
                  )}
                </title>
                <path d={AIRCRAFT_PATH} style={{ fill: movement.airline.colour }} />
              </g>
            );
          })}

          {hoveredStand !== undefined && hoveredSlot !== undefined && (
            <StandTip slot={hoveredSlot} stand={hoveredStand} />
          )}
        </svg>

        <div className="apron__zoom" role="group" aria-label="Zoom">
          <Button
            size="sm"
            aria-label="Zoom in"
            onClick={() => {
              camera.zoomBy(1.4);
            }}
          >
            +
          </Button>
          <Button
            size="sm"
            aria-label="Zoom out"
            onClick={() => {
              camera.zoomBy(1 / 1.4);
            }}
          >
            −
          </Button>
          <Button size="sm" onClick={camera.fit}>
            Fit
          </Button>
        </div>

        {selectedStand !== undefined && (
          <StandPanel
            icao={apron.icao}
            stand={selectedStand}
            day={dayOf(selectedStand.position)}
            onClose={close}
            onGates={onGates}
          />
        )}
        {selectedAircraft !== undefined && (
          <AircraftPanel
            aircraft={selectedAircraft}
            standPosition={aircraftPlaces.get(selectedAircraft.key)?.position ?? null}
            progress={turnaroundProgress(
              new Date(selectedAircraft.arrivedAt),
              selectedAircraft.departsAt === null ? null : new Date(selectedAircraft.departsAt),
              now,
            )}
            onClose={close}
          />
        )}
      </div>

      <Legend youColour={apron.you.colour} heat={heat} />
    </div>
  );
}

/* -- The ground: zones, buildings, runways, pads ------------------------------- */

function Ground({ layout }: { layout: ApronLayout }): ReactNode {
  return (
    <g className="apron__static" aria-hidden="true">
      {layout.zones.map((zone) => (
        <g key={zone.id} className="apron__zone" data-area={zone.id}>
          <rect
            x={zone.rect.x}
            y={zone.rect.y}
            width={zone.rect.width}
            height={zone.rect.height}
            rx={6}
          />
          <text x={zone.rect.x + 10} y={zone.rect.y + 15} className="apron__label">
            {zone.label}
          </text>
        </g>
      ))}
      {layout.buildings.map((building) => (
        <g key={building.id} className="apron__building" data-area={building.id}>
          <rect
            x={building.rect.x}
            y={building.rect.y}
            width={building.rect.width}
            height={building.rect.height}
            rx={building.id === 'terminal' || building.id === 'hangar' ? 6 : 3}
          />
          {(building.id === 'terminal' || building.id === 'hangar') && (
            <text
              x={building.rect.x + building.rect.width / 2}
              y={building.rect.y + building.rect.height / 2 + 4}
              className="apron__label apron__label--centre"
            >
              {building.label}
            </text>
          )}
          {building.id.startsWith('pier-') && (
            <text
              x={building.rect.x + building.rect.width / 2}
              y={building.rect.y + building.rect.height - 3}
              className="apron__label apron__label--pier"
            >
              {building.id.slice('pier-'.length)}
            </text>
          )}
        </g>
      ))}
      {layout.runways.map((runway) => (
        <g key={runway.ident} className="apron__runway" data-runway={runway.ident}>
          <polygon points={runway.corners.map((c) => `${String(c.x)},${String(c.y)}`).join(' ')} />
          <line
            className="apron__centreline"
            x1={runway.ends[0].x}
            y1={runway.ends[0].y}
            x2={runway.ends[1].x}
            y2={runway.ends[1].y}
          />
          <text
            x={runway.center.x}
            y={runway.center.y - runway.width / 2 - 6}
            className="apron__label apron__label--centre"
          >
            {runway.assumed ? `${runway.ident} (assumed)` : runway.ident}
          </text>
        </g>
      ))}
      {layout.deicingPads.map((pad) => (
        <g key={pad.id} className="apron__pad">
          <circle cx={pad.center.x} cy={pad.center.y} r={pad.radius} />
          <text
            x={pad.center.x}
            y={pad.center.y + 3}
            className="apron__label apron__label--centre apron__label--tiny"
          >
            De-ice
          </text>
        </g>
      ))}
    </g>
  );
}

/* -- Stands --------------------------------------------------------------------- */

function StandShape({
  id,
  slot,
  stand,
  youColour,
  heat,
  selected,
  onActivate,
  onKey,
  onHover,
}: {
  id: string;
  slot: StandSlot;
  stand: AirportStand;
  youColour: string;
  heat: boolean;
  selected: boolean;
  onActivate: (event: MouseEvent) => void;
  onKey: (event: KeyboardEvent) => void;
  onHover: (id: string | null) => void;
}): ReactNode {
  const state = standState(stand);
  const band: HeatBand | null =
    heat && state === 'yours' && stand.utilisation !== null ? heatBand(stand.utilisation) : null;
  const { rect } = slot;
  const centre = rectCenter(rect);

  return (
    <g
      className="apron-stand"
      data-stand={stand.position}
      data-stand-id={id}
      data-state={state}
      data-exclusive={stand.exclusivelyHeld}
      data-heat={band ?? undefined}
      data-selected={selected}
      role="button"
      tabIndex={0}
      aria-label={standAccessibleName(stand)}
      aria-pressed={selected}
      onClick={onActivate}
      onKeyDown={onKey}
      onMouseEnter={() => {
        onHover(id);
      }}
      onMouseLeave={() => {
        onHover(null);
      }}
      onFocus={() => {
        onHover(id);
      }}
      onBlur={() => {
        onHover(null);
      }}
    >
      <rect
        className="apron-stand__shape"
        x={rect.x}
        y={rect.y}
        width={rect.width}
        height={rect.height}
        rx={3}
        style={state === 'yours' ? { fill: youColour } : undefined}
      />
      {band !== null && (
        <rect
          className="apron-stand__heat"
          x={rect.x}
          y={rect.y}
          width={rect.width}
          height={rect.height}
          rx={3}
        />
      )}
      {stand.exclusivelyHeld && (
        // A notch in the corner: the exclusive lease, drawn as a shape, not a hue.
        <path
          className="apron-stand__exclusive"
          d={`M${String(rect.x + rect.width - 9)} ${String(rect.y)} L${String(rect.x + rect.width)} ${String(rect.y)} L${String(rect.x + rect.width)} ${String(rect.y + 9)} Z`}
        />
      )}
      <text
        className="apron-stand__label"
        x={centre.x}
        y={rect.y + rect.height - 4}
        aria-hidden="true"
      >
        {band === null || stand.utilisation === null
          ? stand.position
          : `${HEAT_GLYPH[band]} ${percent(stand.utilisation.fraction)}`}
      </text>
    </g>
  );
}

/** Who holds a stand, shown on hover or focus — *"you can see exactly who holds what"*. */
function StandTip({ slot, stand }: { slot: StandSlot; stand: AirportStand }): ReactNode {
  const text = `${stand.position}: ${holdersInWords(stand.holders)}`;
  const width = Math.max(60, text.length * 5.6 + 12);
  const x = slot.rect.x + slot.rect.width / 2 - width / 2;
  const y = slot.rect.y - 22;
  return (
    <g className="apron-tip" aria-hidden="true" pointerEvents="none">
      <rect x={x} y={y} width={width} height={18} rx={4} />
      <text x={x + width / 2} y={y + 12.5}>
        {text}
      </text>
    </g>
  );
}

/* -- Aircraft ------------------------------------------------------------------- */

function AircraftSprite({
  plane,
  rect,
  heading,
  progress,
  selected,
  onActivate,
  onKey,
}: {
  plane: ApronAircraft;
  rect: Rect;
  heading: number;
  progress: Record<TurnaroundPhase, number>;
  selected: boolean;
  onActivate: (event: MouseEvent) => void;
  onKey: (event: KeyboardEvent) => void;
}): ReactNode {
  const centre = rectCenter(rect);
  const yours = plane.airline.isYou;
  const name = `${plane.airline.name} ${plane.typeDesignation ?? 'aircraft'}${plane.registration === null ? '' : ` ${plane.registration}`}`;
  // Rings in a row along the stand's outer edge, away from the pier.
  const ringY = rect.y + 4;
  const ringStart = centre.x - 2 * (RING_RADIUS * 2 + 1.6);

  const interactive = yours
    ? {
        role: 'button',
        tabIndex: 0,
        'aria-label': `${name} — ${ringsInWords(progress)}`,
        'aria-pressed': selected,
        onClick: onActivate,
        onKeyDown: onKey,
      }
    : {};

  return (
    <g
      className="apron-aircraft"
      data-aircraft={plane.key}
      data-yours={yours}
      data-selected={selected}
      {...interactive}
    >
      {!yours && <title>{name}</title>}
      <path
        className="apron-aircraft__body"
        d={AIRCRAFT_PATH}
        transform={`translate(${String(centre.x)} ${String(centre.y + 2)}) rotate(${String(heading)}) scale(${String(AIRCRAFT_SCALE[plane.size])})`}
        style={{ fill: plane.airline.colour }}
      />
      <g className="apron-aircraft__rings" aria-hidden="true">
        {TURNAROUND_PHASE_WINDOWS.map((window, i) => {
          const value = progress[window.phase];
          const cx = ringStart + i * (RING_RADIUS * 2 + 1.6);
          return (
            <g key={window.phase} data-phase={window.phase} data-progress={value.toFixed(2)}>
              <circle className="apron-ring__track" cx={cx} cy={ringY} r={RING_RADIUS} />
              <circle
                className="apron-ring__fill"
                data-complete={value >= 1}
                cx={cx}
                cy={ringY}
                r={RING_RADIUS}
                strokeDasharray={`${String(RING_CIRCUMFERENCE)} ${String(RING_CIRCUMFERENCE)}`}
                strokeDashoffset={RING_CIRCUMFERENCE * (1 - value)}
                transform={`rotate(-90 ${String(cx)} ${String(ringY)})`}
              />
            </g>
          );
        })}
      </g>
    </g>
  );
}

/* -- Legend --------------------------------------------------------------------- */

function Legend({ youColour, heat }: { youColour: string; heat: boolean }): ReactNode {
  return (
    <section className="apron-legend" aria-label="Legend">
      <ul className="apron-legend__list">
        <li>
          <span
            className="apron-legend__swatch"
            data-state="yours"
            style={{ background: youColour }}
          />
          Your stands
        </li>
        <li>
          <span className="apron-legend__swatch" data-state="rival" />
          Held by another airline
        </li>
        <li>
          <span className="apron-legend__swatch" data-state="open" />
          Unleased
        </li>
        <li>
          <span
            className="apron-legend__swatch apron-legend__swatch--exclusive"
            data-state="open"
          />
          Exclusive lease (corner notch)
        </li>
        <li>
          <span className="apron-legend__rings" aria-hidden="true">
            ○○○○○
          </span>
          Turnaround:{' '}
          {TURNAROUND_PHASE_WINDOWS.map((window) => window.label.toLowerCase()).join(', ')}
        </li>
      </ul>
      {heat && (
        <ul className="apron-legend__list" aria-label="Utilisation heat">
          {(['idle', 'working', 'jammed'] as const).map((band) => (
            <li key={band}>
              <span className="apron-legend__swatch" data-heat={band} />
              <span aria-hidden="true">{HEAT_GLYPH[band]}</span> {HEAT_LABEL[band]}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
