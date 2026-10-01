import type { AiSource } from './ai-consensus.ts';
import type { ObservedAiLedger } from './ai-observed-predictions.ts';
import type { PredictionDecision, PredictionPerformance } from './prediction-performance.ts';

type Outcome = '1' | '2' | '3';
export type AiShoePerformance = Omit<PredictionPerformance, 'lastResult'> & {
  lastResult: PredictionPerformance['lastResult'] | '和局';
  ties: number;
};

/** Replay covers the whole shoe; witnessed votes take precedence at exact positions. */
export function summarizeAiShoe(
  simulated: readonly PredictionDecision[],
  outcomes: readonly Outcome[],
  ledger?: ObservedAiLedger,
  source?: AiSource,
): AiShoePerformance | undefined {
  const nonTies = outcomes.filter(side => side !== '3');
  if (simulated.length !== nonTies.length || simulated.some((decision, index) => decision.outcome !== nonTies[index])) return undefined;
  const decisions = simulated.map(decision => ({ ...decision }));
  const positions = new Map<number, number>();
  let nonTieIndex = 0;
  outcomes.forEach((outcome, index) => { if (outcome !== '3') positions.set(index + 1, nonTieIndex++); });
  const savedSnapshot = ledger?.snapshot;
  const savedOffset = savedSnapshot ? savedSnapshot.total - savedSnapshot.outcomes.length : 0;
  const compatible = savedSnapshot && savedSnapshot.total <= outcomes.length
    && savedSnapshot.outcomes.every((side, index) => outcomes[savedOffset + index] === side);
  if (compatible) for (const record of ledger!.decisions) {
    const index = positions.get(record.position);
    if (index === undefined || outcomes[record.position - 1] !== record.outcome) continue;
    const vote = source ? record.votes.find(vote => vote.source === source) : undefined;
    if (source && !vote) continue; // An unselected source was not witnessed.
    decisions[index] = {
      prediction: source ? index === 0 ? undefined : vote?.side : record.prediction,
      outcome: record.outcome,
      agreement: record.agreement,
      activeVotes: record.activeVotes,
    };
  }
  let correct = 0, noSignal = 0, streak = 0, missStreak = 0, maxStreak = 0, maxMissStreak = 0, ties = 0;
  let lastResult: AiShoePerformance['lastResult'] = '等待';
  nonTieIndex = 0;
  for (const outcome of outcomes) {
    if (outcome === '3') { ties++; lastResult = '和局'; continue; }
    const prediction = decisions[nonTieIndex++].prediction;
    if (!prediction) { noSignal++; lastResult = '無訊號'; }
    else if (prediction === outcome) {
      correct++; streak++; missStreak = 0; maxStreak = Math.max(maxStreak, streak); lastResult = '命中';
    } else {
      streak = 0; missStreak++; maxMissStreak = Math.max(maxMissStreak, missStreak); lastResult = '錯誤';
    }
  }
  // Match the displayed correct/whole-shoe denominator, including ties and abstentions.
  const total = outcomes.length;
  return { total, ties, correct, noSignal, accuracy: total ? correct / total * 100 : null,
    streak, missStreak, maxStreak, maxMissStreak, lastResult, decisions };
}
