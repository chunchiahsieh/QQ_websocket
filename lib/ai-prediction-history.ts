import type { ObservedAiLedger } from './ai-observed-predictions.ts';
import type { PredictionDecision } from './prediction-performance.ts';

type Outcome = '1' | '2' | '3';

export type AiPredictionRound = {
  position: number;
  prediction?: '1' | '2';
  outcome?: Outcome;
  origin: 'observed' | 'replayed' | 'unrecorded' | 'pending';
  result: '命中' | '錯誤' | '和局' | '無訊號' | '未記錄' | '待開獎';
};

/**
 * One entry per official round, including ties. Replay decisions only contain
 * non-ties, while saved observations use absolute whole-shoe round positions.
 * The caller supplies the ledger for the current table/shoe/source identity.
 */
export function aiPredictionHistory(
  decisions: readonly PredictionDecision[],
  outcomes: readonly Outcome[],
  ledger?: ObservedAiLedger,
  includePending = false,
): AiPredictionRound[] | undefined {
  const nonTies = outcomes.filter(outcome => outcome !== '3');
  if (decisions.length !== nonTies.length
    || decisions.some((decision, index) => decision.outcome !== nonTies[index])) return undefined;

  const snapshot = ledger?.snapshot;
  const offset = snapshot ? snapshot.total - snapshot.outcomes.length : 0;
  // Reject conflicting evidence as a whole rather than accidentally attaching
  // another shoe's last prediction merely because its last outcome matches.
  const compatible = snapshot !== undefined && Number.isSafeInteger(snapshot.total)
    && offset >= 0 && snapshot.total <= outcomes.length
    && snapshot.outcomes.every((outcome, index) => outcomes[offset + index] === outcome)
    && ledger!.decisions.every((record, index, records) => Number.isSafeInteger(record.position)
      && record.position > 0 && record.position <= snapshot.total
      && (index === 0 || record.position > records[index - 1].position)
      && outcomes[record.position - 1] === record.outcome);
  const recorded = new Map(compatible ? ledger!.decisions.map(record => [record.position, record]) : []);

  let nonTieIndex = 0;
  const history: AiPredictionRound[] = outcomes.map((outcome, index) => {
    const position = index + 1;
    const replay = outcome === '3' ? undefined : decisions[nonTieIndex++];
    const observed = recorded.get(position);
    // A saved abstention is a real decision, not a missing prediction that a
    // later replay is allowed to fill in. Never use ?? to combine these votes.
    const prediction = observed ? observed.prediction : replay?.prediction;
    const origin = observed ? 'observed' : replay ? 'replayed' : 'unrecorded';
    const result = outcome === '3' ? '和局' : prediction === undefined ? '無訊號'
      : prediction === outcome ? '命中' : '錯誤';
    return { position, prediction, outcome, origin, result };
  });

  const pending = compatible ? ledger?.pending : undefined;
  if (includePending && pending && !snapshot!.shuffling
    && snapshot!.total === outcomes.length && pending.position === outcomes.length + 1) {
    // This is the exact locked vote already shown to the user, not a fresh
    // calculation using an official result that has arrived in the meantime.
    history.push({ position: pending.position, prediction: pending.prediction,
      origin: 'pending', result: '待開獎' });
  }
  return history;
}
