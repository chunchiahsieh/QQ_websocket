export type PointSide = '1' | '2';
export type PointResult = { side: PointSide; points: number };

// Big-road marks carry the winning side's point digit; ties are attached to
// the preceding mark and cannot be reconstructed as separate point results.
export function recentPointResults(raw: string, limit = 36): PointResult[] {
  return raw.split('#').flatMap(column => column.split(',')).flatMap(code => {
    if (!/^\d[0-9]\d[12]$/.test(code)) return [];
    return [{ side: code[3] as PointSide, points: Number(code[1]) }];
  }).slice(-limit);
}

export function pointCounts(results: readonly PointResult[], side: PointSide): number[] {
  const counts = Array(10).fill(0) as number[];
  for (const result of results) if (result.side === side) counts[result.points] += 1;
  return counts;
}
