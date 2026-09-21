export type RoadOutcome = '1' | '2' | '3';
export type RoadSide = '1' | '2';

export type WalkForwardAccuracy = {
  hits: number;
  evaluated: number;
  noSignal: number;
  ties: number;
  percent: number | null;
};

// Call predict with only the results that existed before each reveal. A
// missing/conflicting signal and a tie are reported separately, not counted
// as a correct forecast or silently removed from the history.
export function walkForwardAccuracy<T extends { outcome: RoadOutcome }>(
  results: readonly T[],
  predict: (known: readonly T[]) => RoadSide | undefined,
): WalkForwardAccuracy {
  let hits = 0;
  let evaluated = 0;
  let noSignal = 0;
  let ties = 0;
  for (let index = 1; index < results.length; index += 1) {
    const signal = predict(results.slice(0, index));
    if (results[index].outcome === '3') { ties += 1; continue; }
    if (signal === undefined) { noSignal += 1; continue; }
    evaluated += 1;
    if (signal === results[index].outcome) hits += 1;
  }
  return { hits, evaluated, noSignal, ties,
    percent: evaluated ? Math.round(hits / evaluated * 1000) / 10 : null };
}
