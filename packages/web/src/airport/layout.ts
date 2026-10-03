import type { ApronAircraft, ApronRunway, StandKind } from '@tailfin/shared';

/**
 * The airport map's geometry (M7-07, App. B.7) — pure, and the only place a
 * coordinate on the schematic is decided.
 *
 * > *"A clean 2D schematic — accurate in topology, stylised in geometry, in the
 * > house design language."*
 *
 * **Accurate in topology** means everything the game knows about an apron is
 * where it belongs: every stand the airport has is drawn exactly once, contact
 * gates sit on the pier their letter names (`A1`–`A12` on pier A, the way
 * `standInventory` numbers them) with odd numbers down one side and even down
 * the other, remote stands, overnight parking, the cargo area and the
 * maintenance hangar are each their own place, and the runways lie along their
 * real headings. **Stylised in geometry** means none of the distances are real:
 * the game stores no apron survey, so a stand is a fixed box, a pier is as long
 * as its gates need, and runways are scaled to fit the picture rather than the
 * airfield. Two airports of the same tier therefore look alike — which is true
 * of their stands, since the apron is derived from the tier (ADR-0029).
 *
 * ## Units
 *
 * SVG user units, with the y axis pointing down and headings measured
 * clockwise from north, so a runway of true heading `h` is the x axis rotated
 * by `h − 90°`. The whole layout is translated so it starts at (0, 0) and
 * `width` × `height` encloses it, margin included: the view fits that box and
 * calls it the widest zoom.
 *
 * ## The invariants the tests hold
 *
 *   - every stand in the input appears exactly once;
 *   - no stand overlaps another stand, a building, a runway, a de-icing pad or
 *     the overflow apron, and every grid stand lies inside its own area;
 *   - no two areas overlap, and the runways lie wholly below the apron.
 */

export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Which part of the airport a stand or a shape belongs to. */
export type ApronAreaId =
  | 'terminal'
  | `pier-${string}`
  | 'remote'
  | 'overflow'
  | 'overnight'
  | 'cargo'
  | 'maintenance'
  | 'hangar';

/** One stand, placed. */
export interface StandSlot {
  position: string;
  kind: StandKind;
  rect: Rect;
  /**
   * Which way an aeroplane parked here points, degrees clockwise from north:
   * nose-in to the pier for a contact gate, nose to the terminal elsewhere.
   */
  heading: number;
  area: ApronAreaId;
}

/** A building — drawn solid, and nothing may be parked on it. */
export interface ApronBuilding {
  id: ApronAreaId;
  label: string;
  rect: Rect;
}

/** An apron area — drawn as ground, and its stands lie inside it. */
export interface ApronZone {
  id: ApronAreaId;
  label: string;
  rect: Rect;
}

export interface RunwayShape {
  ident: string;
  center: Point;
  /** Stylised length and width, in user units. */
  length: number;
  width: number;
  /** True heading of the lower-numbered end, as drawn (a parallel set shares one). */
  heading: number;
  /** The rectangle's corners, for drawing and for overlap tests. */
  corners: [Point, Point, Point, Point];
  /** The two thresholds: `ends[0]` is the lower-numbered end's. */
  ends: [Point, Point];
  /** True when the import had no runway and this one is the default. */
  assumed: boolean;
}

export interface DeicingPad {
  id: string;
  center: Point;
  radius: number;
}

export interface ApronLayout {
  width: number;
  height: number;
  stands: StandSlot[];
  buildings: ApronBuilding[];
  zones: ApronZone[];
  runways: RunwayShape[];
  deicingPads: DeicingPad[];
  /** Places on the remote apron for aircraft with no stand of their own, in order. */
  overflow: { rect: Rect; heading: number }[];
}

/* -- Dimensions -------------------------------------------------------------- */

/** A stand's footprint: `STAND_W` along its row, `STAND_D` deep. */
export const STAND_W = 36;
export const STAND_D = 44;
const STAND_GAP = 6;

const PIER_W = 18;
/** The jet bridge between a pier and its stands. */
const BRIDGE = 6;
const PIER_INSET = 10;
const PIER_TIP = 12;
const PIER_GAP = 36;

const TERMINAL_H = 56;
const TERMINAL_PAD = 24;
const MIN_TERMINAL_W = 160;

const ZONE_PAD = 12;
const ZONE_LABEL = 22;
const HANGAR_H = 50;
const MIN_HANGAR_W = 120;
const COLUMN_GAP = 48;
const ZONE_GAP = 24;

const GRID_COLUMNS: Record<Exclude<StandKind, 'contact_gate'> | 'overflow', number> = {
  remote_stand: 5,
  overnight_parking: 6,
  cargo_stand: 4,
  maintenance_stand: 4,
  overflow: 5,
};

const MARGIN = 40;

/*
 * Runways. A real one is 6,000–13,000 ft and several times the length of a
 * terminal; drawn to that scale the apron — the part of the map that is the
 * player's — would be a speck beside them. So a runway is drawn at 240–520
 * units, around half a large airport's apron, long enough to read as a runway
 * and short enough to leave the apron the picture.
 */
const RUNWAY_FT_SCALE = 0.04;
const RUNWAY_MIN_LENGTH = 240;
const RUNWAY_MAX_LENGTH = 520;
const RUNWAY_DEFAULT_FT = 9_000;
const RUNWAY_WIDTH_SCALE = 0.12;
const RUNWAY_MIN_WIDTH = 14;
const RUNWAY_MAX_WIDTH = 26;
const RUNWAY_DEFAULT_WIDTH_FT = 150;
const RUNWAY_APRON_GAP = 64;
const RUNWAY_SET_GAP = 56;
const RUNWAY_SEPARATION = 30;
/** Runways within this many degrees of each other are drawn as one parallel set. */
const PARALLEL_TOLERANCE_DEG = 20;
const PAD_RADIUS = 12;
const PAD_GAP = 10;

/** The runway an airport with none in its import is drawn with: east–west, unnamed length. */
export const DEFAULT_RUNWAY: ApronRunway = {
  ident: '09/27',
  lengthFt: null,
  widthFt: null,
  headingDeg: null,
};

/* -- Contact gates ------------------------------------------------------------ */

interface PierGate {
  position: string;
  number: number;
}

/**
 * Contact gates grouped by pier letter, each pier in gate-number order.
 *
 * `B12` is pier B, gate 12. A label that does not read as letters-then-number
 * still gets drawn — on a pier of its own named after it — because the first
 * invariant is that every stand appears, and a label this code did not expect
 * is not a reason to drop somebody's lease off the map.
 */
export function piersOf(positions: readonly string[]): { pier: string; gates: PierGate[] }[] {
  const byPier = new Map<string, PierGate[]>();
  for (const position of positions) {
    const match = /^([A-Za-z]+)(\d+)$/.exec(position);
    const pier = match?.[1] ?? position;
    const number = match?.[2] === undefined ? 0 : Number(match[2]);
    const gates = byPier.get(pier) ?? [];
    gates.push({ position, number });
    byPier.set(pier, gates);
  }
  return [...byPier.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([pier, gates]) => ({
      pier,
      gates: [...gates].sort((a, b) => a.number - b.number || (a.position < b.position ? -1 : 1)),
    }));
}

/* -- Grid areas --------------------------------------------------------------- */

interface GridArea {
  width: number;
  height: number;
  /** Relative to the area's top-left. */
  cells: Rect[];
  /** Height above the first row reserved for the area's own contents (the hangar). */
  innerTop: number;
}

function gridArea(count: number, columns: number, innerTop = 0, minInnerWidth = 0): GridArea {
  const cols = Math.max(1, Math.min(columns, count));
  const rows = Math.ceil(count / cols);
  const gridWidth = cols * STAND_W + (cols - 1) * STAND_GAP;
  const innerWidth = Math.max(gridWidth, minInnerWidth);
  const cells: Rect[] = [];
  const top = ZONE_LABEL + ZONE_PAD + innerTop;
  for (let i = 0; i < count; i += 1) {
    cells.push({
      x: ZONE_PAD + (i % cols) * (STAND_W + STAND_GAP),
      y: top + Math.floor(i / cols) * (STAND_D + STAND_GAP),
      width: STAND_W,
      height: STAND_D,
    });
  }
  return {
    width: innerWidth + 2 * ZONE_PAD,
    height: top + rows * STAND_D + Math.max(0, rows - 1) * STAND_GAP + ZONE_PAD,
    cells,
    innerTop,
  };
}

function offset(rect: Rect, dx: number, dy: number): Rect {
  return { x: rect.x + dx, y: rect.y + dy, width: rect.width, height: rect.height };
}

/* -- Runways ------------------------------------------------------------------ */

function runwayLength(runway: ApronRunway): number {
  const feet = runway.lengthFt ?? RUNWAY_DEFAULT_FT;
  return Math.min(RUNWAY_MAX_LENGTH, Math.max(RUNWAY_MIN_LENGTH, feet * RUNWAY_FT_SCALE));
}

function runwayWidth(runway: ApronRunway): number {
  const feet = runway.widthFt ?? RUNWAY_DEFAULT_WIDTH_FT;
  return Math.min(RUNWAY_MAX_WIDTH, Math.max(RUNWAY_MIN_WIDTH, feet * RUNWAY_WIDTH_SCALE));
}

/** The axis a heading lies on, 0–180: 09/27 and 27/09 are one runway. */
function axisOf(heading: number): number {
  return ((heading % 180) + 180) % 180;
}

function axisDistance(a: number, b: number): number {
  const d = Math.abs(axisOf(a) - axisOf(b));
  return Math.min(d, 180 - d);
}

interface PlacedRunways {
  runways: RunwayShape[];
  pads: DeicingPad[];
  bounds: Rect;
}

/**
 * One set of parallel runways, laid side by side along their common normal,
 * each with a de-icing pad beside each threshold.
 *
 * Coordinates are relative; the caller translates the set into the band.
 */
function runwaySet(members: readonly ApronRunway[], heading: number, assumed: boolean) {
  const theta = ((heading - 90) * Math.PI) / 180;
  const along = { x: Math.cos(theta), y: Math.sin(theta) };
  const normal = { x: -Math.sin(theta), y: Math.cos(theta) };
  const widest = Math.max(...members.map(runwayWidth));
  const spacing = widest + 2 * (PAD_GAP + 2 * PAD_RADIUS) + RUNWAY_SEPARATION;

  const runways: RunwayShape[] = [];
  const pads: DeicingPad[] = [];
  members.forEach((runway, index) => {
    const length = runwayLength(runway);
    const width = runwayWidth(runway);
    const center = { x: normal.x * spacing * index, y: normal.y * spacing * index };
    const half = { x: (along.x * length) / 2, y: (along.y * length) / 2 };
    const side = { x: (normal.x * width) / 2, y: (normal.y * width) / 2 };
    const ends: [Point, Point] = [
      { x: center.x - half.x, y: center.y - half.y },
      { x: center.x + half.x, y: center.y + half.y },
    ];
    runways.push({
      ident: runway.ident,
      center,
      length,
      width,
      heading,
      corners: [
        { x: ends[0].x - side.x, y: ends[0].y - side.y },
        { x: ends[1].x - side.x, y: ends[1].y - side.y },
        { x: ends[1].x + side.x, y: ends[1].y + side.y },
        { x: ends[0].x + side.x, y: ends[0].y + side.y },
      ],
      ends,
      assumed,
    });
    // One pad beside each threshold, on the side away from the runway before it.
    const reach = width / 2 + PAD_GAP + PAD_RADIUS;
    ends.forEach((end, which) => {
      pads.push({
        id: `${runway.ident}-${which === 0 ? 'low' : 'high'}`,
        center: { x: end.x + normal.x * reach, y: end.y + normal.y * reach },
        radius: PAD_RADIUS,
      });
    });
  });

  const xs = [
    ...runways.flatMap((runway) => runway.corners.map((corner) => corner.x)),
    ...pads.flatMap((pad) => [pad.center.x - pad.radius, pad.center.x + pad.radius]),
  ];
  const ys = [
    ...runways.flatMap((runway) => runway.corners.map((corner) => corner.y)),
    ...pads.flatMap((pad) => [pad.center.y - pad.radius, pad.center.y + pad.radius]),
  ];
  const bounds = {
    x: Math.min(...xs),
    y: Math.min(...ys),
    width: Math.max(...xs) - Math.min(...xs),
    height: Math.max(...ys) - Math.min(...ys),
  };
  return { runways, pads, bounds };
}

function translateRunways(set: PlacedRunways, dx: number, dy: number): PlacedRunways {
  const move = (point: Point): Point => ({ x: point.x + dx, y: point.y + dy });
  return {
    runways: set.runways.map((runway) => ({
      ...runway,
      center: move(runway.center),
      corners: runway.corners.map(move) as RunwayShape['corners'],
      ends: runway.ends.map(move) as RunwayShape['ends'],
    })),
    pads: set.pads.map((pad) => ({ ...pad, center: move(pad.center) })),
    bounds: offset(set.bounds, dx, dy),
  };
}

/**
 * Group runways into parallel sets by heading, in import order.
 *
 * Runways within {@link PARALLEL_TOLERANCE_DEG} of one another are one set and
 * share the first member's heading, so a pair of parallels is drawn parallel
 * rather than as two lines a degree apart. A runway with no heading is taken as
 * east–west, which is a guess the picture states by drawing it like any other.
 */
function runwaySets(
  runways: readonly ApronRunway[],
): { heading: number; members: ApronRunway[] }[] {
  const sets: { heading: number; members: ApronRunway[] }[] = [];
  for (const runway of runways) {
    const heading = runway.headingDeg ?? 90;
    const set = sets.find((row) => axisDistance(row.heading, heading) < PARALLEL_TOLERANCE_DEG);
    if (set === undefined) sets.push({ heading, members: [runway] });
    else set.members.push(runway);
  }
  return sets;
}

/* -- The whole apron ---------------------------------------------------------- */

export interface LayoutInput {
  stands: readonly { position: string; kind: StandKind }[];
  runways: readonly ApronRunway[];
  /** Aircraft with nowhere of their own to stand — see {@link assignAircraft}. */
  overflowCount: number;
}

/**
 * Lay out an airport.
 *
 * The middle column is the terminal with its piers hanging below it; cargo and
 * the maintenance hangar stand to its left, the remote apron (with its
 * overflow) and overnight parking to its right; the runways lie below the lot.
 * That is a stylised plan of a great many real airports, and the point of it is
 * that a player who has seen one airport map can read every other.
 */
export function layoutApron({ stands, runways, overflowCount }: LayoutInput): ApronLayout {
  const byKind = (kind: StandKind) =>
    stands.filter((stand) => stand.kind === kind).map((stand) => stand.position);

  const placed: StandSlot[] = [];
  const buildings: ApronBuilding[] = [];
  const zones: ApronZone[] = [];

  /* Left column: cargo above the maintenance area. */
  const cargo = byKind('cargo_stand');
  const maintenance = byKind('maintenance_stand');
  const cargoArea = cargo.length > 0 ? gridArea(cargo.length, GRID_COLUMNS.cargo_stand) : null;
  const maintenanceArea =
    maintenance.length > 0
      ? gridArea(
          maintenance.length,
          GRID_COLUMNS.maintenance_stand,
          HANGAR_H + STAND_GAP,
          MIN_HANGAR_W,
        )
      : null;
  const leftWidth = Math.max(cargoArea?.width ?? 0, maintenanceArea?.width ?? 0);

  let leftY = 0;
  if (cargoArea !== null) {
    zones.push({
      id: 'cargo',
      label: 'Cargo',
      rect: { x: 0, y: leftY, width: cargoArea.width, height: cargoArea.height },
    });
    cargo.forEach((position, i) => {
      placed.push({
        position,
        kind: 'cargo_stand',
        rect: offset(cargoArea.cells[i]!, 0, leftY),
        heading: 0,
        area: 'cargo',
      });
    });
    leftY += cargoArea.height + ZONE_GAP;
  }
  if (maintenanceArea !== null) {
    zones.push({
      id: 'maintenance',
      label: 'Maintenance',
      rect: { x: 0, y: leftY, width: maintenanceArea.width, height: maintenanceArea.height },
    });
    buildings.push({
      id: 'hangar',
      label: 'Hangar',
      rect: {
        x: ZONE_PAD,
        y: leftY + ZONE_LABEL + ZONE_PAD,
        width: maintenanceArea.width - 2 * ZONE_PAD,
        height: HANGAR_H,
      },
    });
    maintenance.forEach((position, i) => {
      placed.push({
        position,
        kind: 'maintenance_stand',
        rect: offset(maintenanceArea.cells[i]!, 0, leftY),
        // Nose to the hangar door.
        heading: 0,
        area: 'maintenance',
      });
    });
    leftY += maintenanceArea.height;
  }
  const leftHeight = leftY;

  /* Middle column: the terminal and its piers. */
  const middleX = leftWidth > 0 ? leftWidth + COLUMN_GAP : 0;
  const piers = piersOf(byKind('contact_gate'));
  const pierPitch = PIER_W + 2 * (BRIDGE + STAND_D) + PIER_GAP;
  const firstPierCenter = middleX + TERMINAL_PAD + BRIDGE + STAND_D + PIER_W / 2;
  let middleHeight = TERMINAL_H;
  piers.forEach(({ pier, gates }, index) => {
    const center = firstPierCenter + index * pierPitch;
    const slots = Math.ceil(gates.length / 2);
    const length = PIER_INSET + slots * (STAND_W + STAND_GAP) - STAND_GAP + PIER_TIP;
    buildings.push({
      id: `pier-${pier}`,
      label: `Pier ${pier}`,
      rect: { x: center - PIER_W / 2, y: TERMINAL_H, width: PIER_W, height: length },
    });
    gates.forEach((gate, i) => {
      // Odd numbers down the left side, even down the right, from the terminal outward.
      const left = i % 2 === 0;
      const slot = Math.floor(i / 2);
      placed.push({
        position: gate.position,
        kind: 'contact_gate',
        rect: {
          x: left ? center - PIER_W / 2 - BRIDGE - STAND_D : center + PIER_W / 2 + BRIDGE,
          y: TERMINAL_H + PIER_INSET + slot * (STAND_W + STAND_GAP),
          width: STAND_D,
          height: STAND_W,
        },
        heading: left ? 90 : 270,
        area: `pier-${pier}`,
      });
    });
    middleHeight = Math.max(middleHeight, TERMINAL_H + length);
  });
  const terminalWidth =
    piers.length === 0
      ? MIN_TERMINAL_W
      : Math.max(
          MIN_TERMINAL_W,
          (piers.length - 1) * pierPitch + 2 * (TERMINAL_PAD + BRIDGE + STAND_D) + PIER_W,
        );
  buildings.push({
    id: 'terminal',
    label: 'Terminal',
    rect: { x: middleX, y: 0, width: terminalWidth, height: TERMINAL_H },
  });

  /* Right column: the remote apron, its overflow, then overnight parking. */
  const rightX = middleX + terminalWidth + COLUMN_GAP;
  let rightY = 0;
  let rightWidth = 0;
  const remote = byKind('remote_stand');
  const overnight = byKind('overnight_parking');
  const overflow: ApronLayout['overflow'] = [];
  const gridColumn = (
    id: ApronAreaId,
    label: string,
    positions: readonly string[],
    kind: StandKind,
    columns: number,
  ) => {
    if (positions.length === 0) return;
    const area = gridArea(positions.length, columns);
    zones.push({
      id,
      label,
      rect: { x: rightX, y: rightY, width: area.width, height: area.height },
    });
    positions.forEach((position, i) => {
      placed.push({
        position,
        kind,
        rect: offset(area.cells[i]!, rightX, rightY),
        // Nose to the terminal side of the field.
        heading: 0,
        area: id,
      });
    });
    rightWidth = Math.max(rightWidth, area.width);
    rightY += area.height + ZONE_GAP;
  };
  gridColumn('remote', 'Remote apron', remote, 'remote_stand', GRID_COLUMNS.remote_stand);
  if (overflowCount > 0) {
    const area = gridArea(overflowCount, GRID_COLUMNS.overflow);
    zones.push({
      id: 'overflow',
      label: 'Remote apron — overflow',
      rect: { x: rightX, y: rightY, width: area.width, height: area.height },
    });
    for (const cell of area.cells) {
      overflow.push({ rect: offset(cell, rightX, rightY), heading: 0 });
    }
    rightWidth = Math.max(rightWidth, area.width);
    rightY += area.height + ZONE_GAP;
  }
  gridColumn(
    'overnight',
    'Overnight parking',
    overnight,
    'overnight_parking',
    GRID_COLUMNS.overnight_parking,
  );
  const rightHeight = Math.max(0, rightY - ZONE_GAP);

  const apronWidth = rightWidth > 0 ? rightX + rightWidth : middleX + terminalWidth;
  const apronHeight = Math.max(leftHeight, middleHeight, rightHeight);

  /* The runways, below the apron, parallel sets side by side. */
  const assumed = runways.length === 0;
  const sets = runwaySets(assumed ? [DEFAULT_RUNWAY] : runways).map((set) =>
    runwaySet(set.members, set.heading, assumed),
  );
  const bandWidth =
    sets.reduce((sum, set) => sum + set.bounds.width, 0) +
    Math.max(0, sets.length - 1) * RUNWAY_SET_GAP;
  const bandTop = apronHeight + RUNWAY_APRON_GAP;
  let bandX = Math.max(0, (apronWidth - bandWidth) / 2);
  const placedRunways: RunwayShape[] = [];
  const pads: DeicingPad[] = [];
  let bandBottom = bandTop;
  for (const set of sets) {
    const moved = translateRunways(set, bandX - set.bounds.x, bandTop - set.bounds.y);
    placedRunways.push(...moved.runways);
    pads.push(...moved.pads);
    bandX += set.bounds.width + RUNWAY_SET_GAP;
    bandBottom = Math.max(bandBottom, bandTop + set.bounds.height);
  }

  const contentWidth = Math.max(apronWidth, bandX - RUNWAY_SET_GAP);
  const contentHeight = bandBottom;

  /* Translate everything by the margin. */
  const shift = (rect: Rect) => offset(rect, MARGIN, MARGIN);
  const shiftPoint = (point: Point): Point => ({ x: point.x + MARGIN, y: point.y + MARGIN });
  return {
    width: contentWidth + 2 * MARGIN,
    height: contentHeight + 2 * MARGIN,
    stands: placed.map((slot) => ({ ...slot, rect: shift(slot.rect) })),
    buildings: buildings.map((building) => ({ ...building, rect: shift(building.rect) })),
    zones: zones.map((zone) => ({ ...zone, rect: shift(zone.rect) })),
    runways: placedRunways.map((runway) => ({
      ...runway,
      center: shiftPoint(runway.center),
      corners: runway.corners.map(shiftPoint) as RunwayShape['corners'],
      ends: runway.ends.map(shiftPoint) as RunwayShape['ends'],
    })),
    deicingPads: pads.map((pad) => ({ ...pad, center: shiftPoint(pad.center) })),
    overflow: overflow.map((slot) => ({ ...slot, rect: shift(slot.rect) })),
  };
}

/* -- Aircraft ----------------------------------------------------------------- */

/**
 * Which aeroplane is drawn where.
 *
 * The server assigns `standPosition`; this only honours it. An aeroplane with no
 * stand, a stand this airport does not have, or a stand an earlier aeroplane in
 * the list already occupies goes to the remote apron's overflow, in list order —
 * two aircraft are never drawn on one stand, because the map must not show a
 * state the rest of the game could not be in.
 */
export function assignAircraft(
  aircraft: readonly Pick<ApronAircraft, 'key' | 'standPosition'>[],
  positions: ReadonlySet<string>,
): { onStand: Map<string, string>; overflow: string[] } {
  const onStand = new Map<string, string>();
  const taken = new Set<string>();
  const overflow: string[] = [];
  for (const plane of aircraft) {
    const position = plane.standPosition;
    if (position !== null && positions.has(position) && !taken.has(position)) {
      taken.add(position);
      onStand.set(plane.key, position);
    } else {
      overflow.push(plane.key);
    }
  }
  return { onStand, overflow };
}

/* -- Geometry helpers --------------------------------------------------------- */

/** Do two rectangles share any area? Touching edges do not count. */
export function rectsOverlap(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

export function rectContains(outer: Rect, inner: Rect): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.width <= outer.x + outer.width &&
    inner.y + inner.height <= outer.y + outer.height
  );
}

export function rectCenter(rect: Rect): Point {
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}
