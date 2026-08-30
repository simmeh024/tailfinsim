/** Keep reviewed semantic boundaries intact unless the operator explicitly clears one label. */
export function semanticWorkbenchFloodCompatible(
  seedAssignment: string | null,
  candidateAssignment: string | null,
  clearing: boolean,
) {
  return clearing
    ? seedAssignment !== null && candidateAssignment === seedAssignment
    : candidateAssignment === null;
}
