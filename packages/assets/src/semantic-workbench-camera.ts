type Point = Readonly<{ x: number; y: number; z: number }>;
type Bounds = Readonly<{ min: Point; max: Point }>;

export type SemanticWorkbenchCloseUp = 'winglet_left' | 'winglet_right' | 'tail';

/** Candidate-relative close-up regions; no aircraft-specific metre threshold is embedded. */
export function semanticWorkbenchCloseUpIncludes(
  bounds: Bounds,
  closeUp: SemanticWorkbenchCloseUp,
  point: Point,
) {
  const xSpan = bounds.max.x - bounds.min.x;
  const zSpan = bounds.max.z - bounds.min.z;
  if (closeUp === 'winglet_left') return point.x <= bounds.min.x + xSpan * 0.1;
  if (closeUp === 'winglet_right') return point.x >= bounds.max.x - xSpan * 0.1;
  return point.z >= bounds.max.z - zSpan * 0.18;
}
