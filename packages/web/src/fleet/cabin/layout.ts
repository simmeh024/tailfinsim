/**
 * Deriving what the drawing shows from the flat element list (M6-08).
 *
 * Row numbers and class *sections* are never stored — they are read off the
 * element order here, so the one source of truth is the sequence of rows. A seat
 * row takes the next number; a monument takes none. A section is a run of
 * consecutive seat rows sharing a class, which is exactly the mockup's "Business
 * · rows 1–3" band, and it re-groups for free when a row's class changes.
 */

import { rowSeatCount } from './analysis';
import { CABIN_CLASS_META, isSeatRow } from './types';

import type { CabinClass, CabinConfig, Monument, SeatRow } from './types';

export type NumberedElement =
  { kind: 'seats'; row: SeatRow; rowNumber: number } | { kind: 'monument'; monument: Monument };

export function numberElements(config: CabinConfig): NumberedElement[] {
  let rowNumber = 0;
  return config.elements.map((element) => {
    if (isSeatRow(element)) {
      rowNumber += 1;
      return { kind: 'seats', row: element, rowNumber };
    }
    return { kind: 'monument', monument: element };
  });
}

export interface CabinSection {
  cabinClass: CabinClass;
  label: string;
  firstRow: number;
  lastRow: number;
  seats: number;
  rowCount: number;
}

export function sectionsOf(config: CabinConfig): CabinSection[] {
  const sections: CabinSection[] = [];
  let current: CabinSection | null = null;

  for (const numbered of numberElements(config)) {
    if (numbered.kind !== 'seats') continue;
    const { row, rowNumber } = numbered;
    if (current !== null && current.cabinClass === row.cabinClass) {
      current.lastRow = rowNumber;
      current.seats += rowSeatCount(row);
      current.rowCount += 1;
    } else {
      current = {
        cabinClass: row.cabinClass,
        label: CABIN_CLASS_META[row.cabinClass].label,
        firstRow: rowNumber,
        lastRow: rowNumber,
        seats: rowSeatCount(row),
        rowCount: 1,
      };
      sections.push(current);
    }
  }

  return sections;
}
