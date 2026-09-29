export type PredictionDecision = { prediction?: '1' | '2'; outcome: '1' | '2' | '3'; agreement?: number; activeVotes?: number };
export type PredictionPerformance = { total: number; correct: number; noSignal: number; accuracy: number | null; streak: number; missStreak: number; maxStreak: number; maxMissStreak: number; lastResult: '命中' | '錯誤' | '無訊號' | '等待'; decisions: PredictionDecision[] };

export function evaluatePredictions<T>(rounds: readonly T[], predict: (history: readonly T[]) => '1' | '2' | undefined, outcome: (round: T) => '1' | '2' | '3'): PredictionPerformance {
  let correct = 0;
  let noSignal = 0;
  let streak = 0;
  let missStreak = 0;
  let maxStreak = 0;
  let maxMissStreak = 0;
  let lastResult: PredictionPerformance['lastResult'] = '等待';
  const decisions: PredictionDecision[] = [];
  for (let index = 0; index < rounds.length; index += 1) {
    const prediction = predict(rounds.slice(0, index));
    const actual = outcome(rounds[index]);
    decisions.push({ prediction, outcome: actual });
    if (!prediction) { noSignal += 1; lastResult = '無訊號'; }
    else if (prediction === actual) { correct += 1; streak += 1; missStreak = 0; maxStreak = Math.max(maxStreak, streak); lastResult = '命中'; }
    else { streak = 0; missStreak += 1; maxMissStreak = Math.max(maxMissStreak, missStreak); lastResult = '錯誤'; }
  }
  const signaled = rounds.length - noSignal;
  return { total: rounds.length, correct, noSignal, accuracy: signaled ? correct / signaled * 100 : null, streak, missStreak, maxStreak, maxMissStreak, lastResult, decisions };
}

export const performanceText = (performance: PredictionPerformance) =>
  `${performance.accuracy === null ? '—' : `${performance.accuracy.toFixed(1)}%`}（${performance.correct}/${performance.total}）`;
