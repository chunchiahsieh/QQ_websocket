import { aiConsensus, type AiSource } from './ai-consensus.ts';
import { chronologicalAiRoad, encodeAiRoad } from './ai-road-history.ts';
import type { PredictionDecision } from './prediction-performance.ts';

// Chronological whole-shoe replay for ranking/betting comparisons. Card counters
// overlay separately saved predictions before calculating current/max streaks.
export function predictionPerformance(raw: string, selected: readonly AiSource[], outcomes?: readonly ('1' | '2' | '3')[]) {
  const rounds = chronologicalAiRoad(raw, outcomes) ?? [];
  let correct = 0;
  let noSignal = 0;
  let streak = 0;
  let missStreak = 0;
  let maxStreak = 0;
  let maxMissStreak = 0;
  let lastResult: '命中' | '錯誤' | '無訊號' | '等待' = '等待';
  const decisions: PredictionDecision[] = [];
  for (const [index, round] of rounds.entries()) {
    const prefix = encodeAiRoad(rounds.slice(0, index));
    const roundConsensus = aiConsensus(prefix, selected);
    const predicted = roundConsensus.side;
    const actual = round.code.at(-1) as '1' | '2';
    const agreement = predicted ? roundConsensus.votes.filter(vote => vote.side === predicted).length : 0;
    decisions.push({ prediction: predicted, outcome: actual, agreement, activeVotes: roundConsensus.active });
    if (!predicted) { noSignal += 1; lastResult = '無訊號'; }
    else if (predicted === actual) { correct += 1; streak += 1; missStreak = 0; maxStreak = Math.max(maxStreak, streak); lastResult = '命中'; }
    else { streak = 0; missStreak += 1; maxMissStreak = Math.max(maxMissStreak, missStreak); lastResult = '錯誤'; }
  }
  const signaled = rounds.length - noSignal;
  return { total: rounds.length, correct, noSignal, accuracy: signaled > 0 ? correct / signaled * 100 : null, streak, missStreak, maxStreak, maxMissStreak, lastResult, decisions };
}
