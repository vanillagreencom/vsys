/**
 * The nearest-rank percentile both benchmarks report: the smallest value with
 * at least `fraction` of the values at or below it. A fraction of 1 is the
 * slowest value. An empty set has no percentile, and saying so beats
 * reporting a zero for a timing nobody took.
 */
export function percentile(values: number[], fraction: number): number {
  if (!values.length) throw new Error("percentile: no values to rank");
  const sorted = [...values].sort((a, b) => a - b);
  const value = sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
  if (value === undefined)
    throw new Error(`percentile: fraction=${fraction} is outside 0 to 1`);
  return value;
}
