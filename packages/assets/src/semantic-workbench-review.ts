interface ComponentShape {
  componentId: string;
  triangles: number;
}

export interface SemanticDisposition {
  targetId: string;
  componentId: string;
  ranges: { startInclusive: number; endExclusive: number }[];
}

/** Deterministically compress component-local face assignments into half-open ranges. */
export function compressSemanticAssignments(
  components: readonly ComponentShape[],
  targetIds: readonly string[],
  assignments: ReadonlyMap<string, readonly (string | null)[]>,
): SemanticDisposition[] {
  const dispositions: SemanticDisposition[] = [];
  for (const component of components) {
    const values = assignments.get(component.componentId);
    if (values?.length !== component.triangles)
      throw new Error('Semantic workbench assignment shape changed.');
    for (const targetId of targetIds) {
      const ranges: SemanticDisposition['ranges'] = [];
      let start: number | null = null;
      for (let index = 0; index <= values.length; index += 1) {
        if (values[index] === targetId && start === null) start = index;
        if (values[index] !== targetId && start !== null) {
          ranges.push({ startInclusive: start, endExclusive: index });
          start = null;
        }
      }
      if (ranges.length)
        dispositions.push({ targetId, componentId: component.componentId, ranges });
    }
  }
  return dispositions;
}

/** Expand only exact, non-overlapping component-local ranges from a matching review. */
export function expandSemanticDispositions(
  components: readonly ComponentShape[],
  targetIds: ReadonlySet<string>,
  dispositions: readonly SemanticDisposition[],
): Map<string, (string | null)[]> {
  const assignments = new Map(
    components.map((component) => [
      component.componentId,
      new Array<string | null>(component.triangles).fill(null),
    ]),
  );
  for (const disposition of dispositions) {
    const values = assignments.get(disposition.componentId);
    if (!values || !targetIds.has(disposition.targetId))
      throw new Error('Semantic workbench disposition is unknown.');
    if (!disposition.ranges.length) throw new Error('Semantic workbench range is missing.');
    for (const range of disposition.ranges) {
      if (
        !Number.isInteger(range.startInclusive) ||
        !Number.isInteger(range.endExclusive) ||
        range.startInclusive < 0 ||
        range.endExclusive > values.length ||
        range.endExclusive <= range.startInclusive
      ) {
        throw new Error('Semantic workbench range is invalid.');
      }
      for (let face = range.startInclusive; face < range.endExclusive; face += 1) {
        if (values[face] !== null) throw new Error('Semantic workbench review overlaps one face.');
        values[face] = disposition.targetId;
      }
    }
  }
  return assignments;
}
