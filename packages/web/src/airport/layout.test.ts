import { describe, expect, it } from 'vitest';

import { STAND_KINDS, type ApronRunway, type StandKind } from '@tailfin/shared';

import {
  assignAircraft,
  layoutApron,
  piersOf,
  rectContains,
  rectsOverlap,
  type ApronLayout,
  type Point,
  type Rect,
} from './layout';

/**
 * The airport map's geometry (M7-07, App. B.7).
 *
 * *"Accurate in topology, stylised in geometry"* — so the tests hold the
 * topology: every stand is drawn exactly once, nothing is drawn on top of
 * anything else, contact gates sit on the pier their letter names, and the
 * runways lie along their headings, below the apron. They run over every tier's
 * real inventory (the counts `standInventory` derives, M7-06) and over a spread
 * of awkward inputs, because the layout must never drop somebody's lease off the
 * map whatever the server sends.
 */

/** M7-06's apron by tier (server/src/network/gates.ts), restated as data. */
const INVENTORY: Record<string, Record<StandKind, number>> = {
  flagship: {
    contact_gate: 48,
    remote_stand: 20,
    overnight_parking: 30,
    cargo_stand: 8,
    maintenance_stand: 4,
  },
  large: {
    contact_gate: 24,
    remote_stand: 12,
    overnight_parking: 16,
    cargo_stand: 4,
    maintenance_stand: 3,
  },
  medium: {
    contact_gate: 12,
    remote_stand: 8,
    overnight_parking: 10,
    cargo_stand: 2,
    maintenance_stand: 2,
  },
  small: {
    contact_gate: 6,
    remote_stand: 4,
    overnight_parking: 6,
    cargo_stand: 1,
    maintenance_stand: 1,
  },
  regional: {
    contact_gate: 2,
    remote_stand: 3,
    overnight_parking: 4,
    cargo_stand: 1,
    maintenance_stand: 1,
  },
};

const PREFIX: Record<StandKind, string> = {
  contact_gate: '',
  remote_stand: 'R',
  overnight_parking: 'P',
  cargo_stand: 'C',
  maintenance_stand: 'M',
};

/** `standInventory`'s labelling: piers of twelve, lettered; everything else a prefixed run. */
function inventory(counts: Record<StandKind, number>): { position: string; kind: StandKind }[] {
  return STAND_KINDS.flatMap((kind) =>
    Array.from({ length: counts[kind] }, (_, i) => ({
      kind,
      position:
        kind === 'contact_gate'
          ? `${String.fromCharCode(65 + Math.floor(i / 12))}${String((i % 12) + 1)}`
          : `${PREFIX[kind]}${String(i + 1)}`,
    })),
  );
}

const runway = (ident: string, headingDeg: number | null, lengthFt: number | null = 11_000) =>
  ({ ident, headingDeg, lengthFt, widthFt: 150 }) satisfies ApronRunway;

/* -- Overlap helpers ------------------------------------------------------------ */

/** Separating-axis test for two convex polygons; touching does not count. */
function polygonsOverlap(a: readonly Point[], b: readonly Point[]): boolean {
  for (const polygon of [a, b]) {
    for (let i = 0; i < polygon.length; i += 1) {
      const p = polygon[i]!;
      const q = polygon[(i + 1) % polygon.length]!;
      const axis = { x: q.y - p.y, y: p.x - q.x };
      const project = (points: readonly Point[]) =>
        points.map((pt) => pt.x * axis.x + pt.y * axis.y);
      const pa = project(a);
      const pb = project(b);
      const epsilon = 1e-6;
      if (
        Math.max(...pa) <= Math.min(...pb) + epsilon ||
        Math.max(...pb) <= Math.min(...pa) + epsilon
      ) {
        return false;
      }
    }
  }
  return true;
}

const corners = (r: Rect): Point[] => [
  { x: r.x, y: r.y },
  { x: r.x + r.width, y: r.y },
  { x: r.x + r.width, y: r.y + r.height },
  { x: r.x, y: r.y + r.height },
];

const padBox = (pad: ApronLayout['deicingPads'][number]): Rect => ({
  x: pad.center.x - pad.radius,
  y: pad.center.y - pad.radius,
  width: pad.radius * 2,
  height: pad.radius * 2,
});

/** Every invariant at once, so each scenario below is one call. */
function expectSound(
  layout: ApronLayout,
  stands: readonly { position: string; kind: StandKind }[],
): void {
  // 1. Every stand exactly once. A stand is its kind and position together, because
  //    M7-06's labels collide at a flagship (cargo `C1`–`C8` and pier C's gates).
  const identity = (s: { kind: StandKind; position: string }) => `${s.kind}:${s.position}`;
  expect(layout.stands.map(identity).sort()).toEqual(stands.map(identity).sort());
  expect(new Set(layout.stands.map(identity)).size).toBe(layout.stands.length);

  // 2. No stand overlaps another stand, an overflow place, a building, a pad or a runway.
  const others: Rect[] = [
    ...layout.overflow.map((o) => o.rect),
    ...layout.buildings.map((b) => b.rect),
    ...layout.deicingPads.map(padBox),
  ];
  layout.stands.forEach((slot, i) => {
    for (const other of layout.stands.slice(i + 1)) {
      expect(rectsOverlap(slot.rect, other.rect), `${slot.position} × ${other.position}`).toBe(
        false,
      );
    }
    for (const rect of others) expect(rectsOverlap(slot.rect, rect), slot.position).toBe(false);
    for (const rw of layout.runways) {
      expect(
        polygonsOverlap(corners(slot.rect), rw.corners),
        `${slot.position} × ${rw.ident}`,
      ).toBe(false);
    }
  });

  // 3. Every grid stand lies inside its own area; contact gates hang off their pier.
  for (const slot of layout.stands) {
    if (slot.kind === 'contact_gate') {
      const pier = layout.buildings.find((b) => b.id === slot.area);
      expect(pier, slot.position).toBeDefined();
      continue;
    }
    const zone = layout.zones.find((z) => z.id === slot.area);
    expect(zone, slot.position).toBeDefined();
    expect(rectContains((zone as { rect: Rect }).rect, slot.rect), slot.position).toBe(true);
  }
  for (const spot of layout.overflow) {
    const zone = layout.zones.find((z) => z.id === 'overflow');
    expect(rectContains((zone as { rect: Rect }).rect, spot.rect)).toBe(true);
  }

  // 4. Areas do not overlap each other, or the terminal and piers.
  layout.zones.forEach((zone, i) => {
    for (const other of layout.zones.slice(i + 1)) {
      expect(rectsOverlap(zone.rect, other.rect), `${zone.id} × ${other.id}`).toBe(false);
    }
    for (const building of layout.buildings.filter((b) => b.id !== 'hangar')) {
      expect(rectsOverlap(zone.rect, building.rect), `${zone.id} × ${building.id}`).toBe(false);
    }
  });

  // 5. Runways and pads lie wholly below the apron, and never on one another.
  const apronBottom = Math.max(
    ...[...layout.zones, ...layout.buildings].map((a) => a.rect.y + a.rect.height),
    ...layout.stands.map((s) => s.rect.y + s.rect.height),
  );
  for (const rw of layout.runways) {
    for (const c of rw.corners) expect(c.y).toBeGreaterThan(apronBottom);
    for (const pad of layout.deicingPads) {
      expect(polygonsOverlap(corners(padBox(pad)), rw.corners), `${pad.id} × ${rw.ident}`).toBe(
        false,
      );
    }
  }
  layout.runways.forEach((rw, i) => {
    for (const other of layout.runways.slice(i + 1)) {
      expect(polygonsOverlap(rw.corners, other.corners), `${rw.ident} × ${other.ident}`).toBe(
        false,
      );
    }
  });

  // 6. Everything is inside the drawn extent.
  const extent = { x: 0, y: 0, width: layout.width, height: layout.height };
  for (const rect of [...layout.stands.map((s) => s.rect), ...layout.zones.map((z) => z.rect)]) {
    expect(rectContains(extent, rect)).toBe(true);
  }
  for (const rw of layout.runways) {
    for (const c of rw.corners)
      expect(rectContains(extent, { ...c, width: 0, height: 0 })).toBe(true);
  }
}

describe('layoutApron', () => {
  it.each(Object.keys(INVENTORY))('draws every %s stand once, with nothing overlapping', (tier) => {
    const stands = inventory(INVENTORY[tier]!);
    const runways = [runway('09/27', 90), runway('18/36', 180, 8_000)];
    for (const overflowCount of [0, 1, 7]) {
      expectSound(layoutApron({ stands, runways, overflowCount }), stands);
    }
  });

  it('puts contact gates on the pier their letter names, odd down one side and even down the other', () => {
    const stands = inventory(INVENTORY.large!);
    const layout = layoutApron({ stands, runways: [], overflowCount: 0 });
    const piers = layout.buildings.filter((b) => b.id.startsWith('pier-')).map((b) => b.id);
    expect(piers).toEqual(['pier-A', 'pier-B']);

    const slot = (position: string) => layout.stands.find((s) => s.position === position);
    expect(slot('A1')?.area).toBe('pier-A');
    expect(slot('B12')?.area).toBe('pier-B');
    const pierA = layout.buildings.find((b) => b.id === 'pier-A')?.rect;
    if (pierA === undefined) throw new Error('pier A was not drawn');
    const centreA = pierA.x + pierA.width / 2;
    // A1, A3 … on the left, nose-in east; A2, A4 … on the right, nose-in west.
    expect((slot('A1')?.rect.x ?? 0) + (slot('A1')?.rect.width ?? 0)).toBeLessThan(centreA);
    expect(slot('A2')?.rect.x ?? 0).toBeGreaterThan(centreA);
    expect(slot('A1')?.heading).toBe(90);
    expect(slot('A2')?.heading).toBe(270);
    // Numbered outward from the terminal.
    expect(slot('A3')?.rect.y ?? 0).toBeGreaterThan(slot('A1')?.rect.y ?? 0);
    expect(slot('A11')?.rect.y ?? 0).toBeGreaterThan(slot('A9')?.rect.y ?? 0);
  });

  it('gives remote stands, overnight parking, cargo and maintenance areas of their own', () => {
    const stands = inventory(INVENTORY.medium!);
    const layout = layoutApron({ stands, runways: [], overflowCount: 2 });
    expect(layout.zones.map((z) => z.id).sort()).toEqual(
      ['cargo', 'maintenance', 'overflow', 'overnight', 'remote'].sort(),
    );
    expect(layout.buildings.map((b) => b.id)).toEqual(
      expect.arrayContaining(['terminal', 'hangar']),
    );
    expect(layout.stands.find((s) => s.position === 'R1')?.area).toBe('remote');
    expect(layout.stands.find((s) => s.position === 'P10')?.area).toBe('overnight');
    expect(layout.stands.find((s) => s.position === 'C2')?.area).toBe('cargo');
    expect(layout.stands.find((s) => s.position === 'M1')?.area).toBe('maintenance');
    expect(layout.overflow).toHaveLength(2);
  });

  it('draws both stands when two kinds share a label, as a flagship’s cargo and pier C do', () => {
    const stands = inventory(INVENTORY.flagship!);
    const labelled = stands.filter((s) => s.position === 'C3').map((s) => s.kind);
    // The inventory as the server labels it today: a real collision, reported on #72.
    expect(labelled.sort()).toEqual(['cargo_stand', 'contact_gate']);
    const layout = layoutApron({ stands, runways: [], overflowCount: 0 });
    expect(
      layout.stands
        .filter((s) => s.position === 'C3')
        .map((s) => s.area)
        .sort(),
    ).toEqual(['cargo', 'pier-C']);
  });

  it('places a stand it did not expect rather than dropping it', () => {
    const stands = [
      { position: 'A1', kind: 'contact_gate' as const },
      { position: 'A13', kind: 'contact_gate' as const },
      { position: 'GATEX', kind: 'contact_gate' as const },
      { position: 'AA1', kind: 'contact_gate' as const },
      { position: 'R1', kind: 'remote_stand' as const },
    ];
    const layout = layoutApron({ stands, runways: [], overflowCount: 0 });
    expectSound(layout, stands);
    expect(layout.stands.find((s) => s.position === 'GATEX')?.area).toBe('pier-GATEX');
  });

  it('draws an airport with no stands of a kind without an empty area for it', () => {
    const stands = [{ position: 'A1', kind: 'contact_gate' as const }];
    const layout = layoutApron({ stands, runways: [], overflowCount: 0 });
    expectSound(layout, stands);
    expect(layout.zones).toEqual([]);
  });

  it('survives an apron with no stands at all', () => {
    const layout = layoutApron({ stands: [], runways: [], overflowCount: 3 });
    expectSound(layout, []);
    expect(layout.overflow).toHaveLength(3);
  });

  it('is deterministic', () => {
    const stands = inventory(INVENTORY.flagship!);
    const runways = [runway('06/24', 58), runway('18L/36R', 183), runway('18R/36L', 180)];
    expect(layoutApron({ stands, runways, overflowCount: 4 })).toEqual(
      layoutApron({ stands, runways, overflowCount: 4 }),
    );
  });
});

describe('runways', () => {
  const stands = inventory(INVENTORY.small!);

  it('orients each runway along its heading', () => {
    const layout = layoutApron({ stands, runways: [runway('04/22', 40)], overflowCount: 0 });
    const [rw] = layout.runways;
    const dx = (rw?.ends[1].x ?? 0) - (rw?.ends[0].x ?? 0);
    const dy = (rw?.ends[1].y ?? 0) - (rw?.ends[0].y ?? 0);
    // Heading 040: north-east, which in SVG (y down) is +x, −y.
    const bearing = ((Math.atan2(dx, -dy) * 180) / Math.PI + 360) % 360;
    expect(bearing).toBeCloseTo(40, 6);
    expect(rw?.assumed).toBe(false);
  });

  it('draws a sensible default when the import has no runway', () => {
    const layout = layoutApron({ stands, runways: [], overflowCount: 0 });
    expect(layout.runways).toHaveLength(1);
    expect(layout.runways[0]?.ident).toBe('09/27');
    expect(layout.runways[0]?.assumed).toBe(true);
    expect(layout.runways[0]?.ends[0].y).toBeCloseTo(layout.runways[0]?.ends[1].y ?? 0, 6);
    expectSound(layout, stands);
  });

  it('draws parallel runways parallel, side by side, never on top of each other', () => {
    const layout = layoutApron({
      stands,
      runways: [runway('18L/36R', 183), runway('18C/36C', 180), runway('18R/36L', 178)],
      overflowCount: 0,
    });
    expectSound(layout, stands);
    const headings = new Set(layout.runways.map((rw) => rw.heading));
    expect(headings.size).toBe(1);
  });

  it('takes a runway with no heading as east–west, and still draws one with no length', () => {
    const layout = layoutApron({
      stands,
      runways: [runway('X', null, null), runway('Y', 135)],
      overflowCount: 0,
    });
    expectSound(layout, stands);
    expect(layout.runways.map((rw) => rw.heading)).toEqual([90, 135]);
  });

  it('puts a de-icing pad beside each threshold', () => {
    const layout = layoutApron({ stands, runways: [runway('09/27', 90)], overflowCount: 0 });
    const [rw] = layout.runways;
    expect(layout.deicingPads).toHaveLength(2);
    for (const pad of layout.deicingPads) {
      const nearest = Math.min(
        ...(rw?.ends ?? []).map((end) => Math.hypot(end.x - pad.center.x, end.y - pad.center.y)),
      );
      expect(nearest).toBeLessThan(60);
    }
  });

  it('lays crossing runways out apart, a spread of headings and lengths', () => {
    // A small deterministic sweep standing in for a property test.
    for (let seed = 0; seed < 24; seed += 1) {
      const count = 1 + (seed % 4);
      const runways = Array.from({ length: count }, (_, i) =>
        runway(
          `R${String(i)}`,
          (seed * 37 + i * 61) % 360,
          5_000 + ((seed * 977 + i * 1_301) % 9_000),
        ),
      );
      expectSound(layoutApron({ stands, runways, overflowCount: seed % 3 }), stands);
    }
  });
});

describe('piersOf', () => {
  it('groups by letter and orders by gate number, not by string', () => {
    expect(piersOf(['B2', 'A10', 'A2', 'A1', 'B1'])).toEqual([
      {
        pier: 'A',
        gates: [
          { position: 'A1', number: 1 },
          { position: 'A2', number: 2 },
          { position: 'A10', number: 10 },
        ],
      },
      {
        pier: 'B',
        gates: [
          { position: 'B1', number: 1 },
          { position: 'B2', number: 2 },
        ],
      },
    ]);
  });
});

describe('assignAircraft', () => {
  const positions = new Set(['A1', 'A2', 'R1']);

  it('honours the server’s stand, and sends the rest to the overflow in order', () => {
    const { onStand, overflow } = assignAircraft(
      [
        { key: 'a', standPosition: 'A1' },
        { key: 'b', standPosition: null },
        { key: 'c', standPosition: 'Z9' },
        { key: 'd', standPosition: 'A1' },
        { key: 'e', standPosition: 'R1' },
      ],
      positions,
    );
    expect([...onStand.entries()]).toEqual([
      ['a', 'A1'],
      ['e', 'R1'],
    ]);
    // No stand, a stand the airport lacks, and a stand already occupied.
    expect(overflow).toEqual(['b', 'c', 'd']);
  });
});
