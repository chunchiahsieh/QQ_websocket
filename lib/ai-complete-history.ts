import { completeAiConsensus, type AiSource } from './ai-consensus.ts';
import type { ObservedAiLedger } from './ai-observed-predictions.ts';
import type { AiPredictionRound } from './ai-prediction-history.ts';
import { chronologicalAiRoad, encodeAiRoad } from './ai-road-history.ts';
import { summarizeAiShoe, type AiShoePerformance } from './ai-shoe-performance.ts';
import type { PredictionDecision } from './prediction-performance.ts';

type Outcome = '1' | '2' | '3';

/** Complete settled directions from prior history, never from the result being scored. */
export function completeAiHistory(
  raw: string,
  selected: readonly AiSource[],
  outcomes: readonly Outcome[],
  ledger?: ObservedAiLedger,
  source?: AiSource,
): { history: AiPredictionRound[]; performance: AiShoePerformance } | undefined {
  if (!selected.length) return undefined;
  const marks = chronologicalAiRoad(raw, outcomes);
  if (!marks) return undefined;

  const snapshot = ledger?.snapshot;
  const offset = snapshot ? snapshot.total - snapshot.outcomes.length : 0;
  // The same whole-ledger checks as aiPredictionHistory: one contradictory or
  // misplaced record rejects all saved observations, not just that one row.
  const compatible = snapshot !== undefined && Number.isSafeInteger(snapshot.total)
    && offset >= 0 && snapshot.total <= outcomes.length
    && snapshot.outcomes.every((outcome, index) => outcomes[offset + index] === outcome)
    && ledger!.decisions.every((record, index, records) => Number.isSafeInteger(record.position)
      && record.position > 0 && record.position <= snapshot.total
      && (index === 0 || record.position > records[index - 1].position)
      && outcomes[record.position - 1] === record.outcome);
  const recorded = new Map(compatible ? ledger!.decisions.map(record => [record.position, record]) : []);
  const metadata = new Map<number, Pick<PredictionDecision, 'agreement' | 'activeVotes'>>();
  let nonTieIndex = 0;
  const history: AiPredictionRound[] = outcomes.map((outcome, index) => {
    const position = index + 1;
    // The current mark is appended only after its prediction is locked. Ties
    // do not advance the non-tie prefix. Canonical consensus ignores mutable
    // tie annotations on earlier marks, so later ties cannot leak backwards.
    const consensus = completeAiConsensus(encodeAiRoad(marks.slice(0, nonTieIndex)), selected);
    const observed = recorded.get(position);
    const savedSide = source ? observed?.votes.find(vote => vote.source === source)?.side : observed?.prediction;
    const observedDirection = savedSide === '1' || savedSide === '2';
    const prediction = observedDirection ? savedSide : consensus.side;
    metadata.set(position, observedDirection ? {
      agreement: observed!.agreement,
      activeVotes: observed!.activeVotes,
    } : {
      agreement: consensus.votes.filter(vote => vote.side === prediction).length,
      activeVotes: consensus.active,
    });
    if (outcome !== '3') nonTieIndex += 1;
    return {
      position,
      prediction,
      outcome,
      origin: observedDirection ? 'observed' : 'replayed',
      result: outcome === '3' ? '和局' : prediction === outcome ? '命中' : '錯誤',
    };
  });
  const decisions: PredictionDecision[] = history.filter(round => round.outcome !== '3').map(round => ({
    prediction: round.prediction,
    outcome: round.outcome!,
    ...metadata.get(round.position),
  }));
  // History already contains the selected saved directions. A second overlay
  // could restore an old abstention and make the counters disagree with rows.
  const performance = summarizeAiShoe(decisions, outcomes);
  return performance ? { history, performance } : undefined;
}
