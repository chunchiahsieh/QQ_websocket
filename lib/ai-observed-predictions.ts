import { aiSources, type AiSource, type aiConsensus } from './ai-consensus.ts';
import type { PredictionDecision, PredictionPerformance } from './prediction-performance.ts';
import { isAiRoadCode, parseAiRoad } from './ai-road-history.ts';

type Outcome = '1' | '2' | '3';
type Vote = { source: AiSource; side?: '1' | '2' };
export type AiObservationSnapshot = { total: number; nonTieTotal?: number; bankerTotal?: number; outcomes: Outcome[]; shuffling: boolean; road?: string };
type ObservationEvidence = { fullOutcomes?: Outcome[]; road?: string; bankerTotal?: number; tailWindow?: 36 };
type LockedPrediction = { position: number; nonTiePosition?: number; prediction?: '1' | '2'; agreement: number; activeVotes: number; votes: Vote[] };
export type ObservedAiDecision = PredictionDecision & LockedPrediction;
export type ObservedAiLedger = {
  version: 2;
  key: string;
  snapshot: AiObservationSnapshot;
  pending?: LockedPrediction;
  decisions: ObservedAiDecision[];
};

export function aiObservationKey(tableId: string, shoe: string, card: string, selected: readonly AiSource[]) {
  return `ai-observed-v2:${JSON.stringify([tableId, shoe, card, aiSources.filter(source => selected.includes(source))])}`;
}

export function aiObservationIdentity(tableId: string, shoe: string, card: string, selected: readonly AiSource[], mountScope: string) {
  const value = shoe.trim();
  const persistent = Boolean(value) && !/^(?:[-—–?]+|unknown|undefined|null|n\/a|0)$/i.test(value);
  const key = aiObservationKey(tableId, shoe, card, selected);
  // A placeholder is not a shoe identity. Use the continuously observed feed
  // session when available; isolated cards fall back to their own mount scope.
  return { key: persistent ? key : `${key}:mount:${mountScope}`, persistent };
}

export function aiObservationSnapshot(beadPlate: string, total: number, shuffling: boolean, nonTieTotal?: number, evidence: ObservationEvidence = {}): AiObservationSnapshot | undefined {
  if (evidence.fullOutcomes !== undefined && evidence.fullOutcomes.length !== total) return undefined;
  if (evidence.fullOutcomes) beadPlate = evidence.fullOutcomes.map(side => `0${side}`).join('');
  const columns = beadPlate.split('#');
  if (columns.some(column => !column.includes(',') && !/^(?:[0-3][123])*$/.test(column))) return undefined;
  const cells = columns.flatMap(column => column.includes(',') ? column.split(',').filter(Boolean) : column.match(/.{2}/g) ?? []);
  if (cells.some(code => !/^[0-3][123]$/.test(code)) || !Number.isSafeInteger(total) || total < cells.length || total < 0) return undefined;
  // A count without its corresponding official outcome cannot settle a vote.
  if (total > 0 && !cells.length) return undefined;
  const outcomes = cells.map(code => code[1] as Outcome);
  // The supported truncated feed is a fixed last-36 window. A shorter bead
  // with a larger count is a partial update, not a shifted history window.
  if (total > outcomes.length && (evidence.tailWindow !== 36 || outcomes.length !== 36)) return undefined;
  const ties = outcomes.filter(side => side === '3').length;
  if (nonTieTotal !== undefined && (!Number.isSafeInteger(nonTieTotal) || nonTieTotal > total - ties || nonTieTotal < outcomes.length - ties
    || (outcomes.length === total && nonTieTotal !== total - ties))) return undefined;
  const bankerTotal = evidence.bankerTotal;
  if (bankerTotal !== undefined) {
    const visibleBanker = outcomes.filter(side => side === '2').length;
    const visiblePlayer = outcomes.filter(side => side === '1').length;
    if (!Number.isSafeInteger(bankerTotal) || nonTieTotal === undefined || bankerTotal < visibleBanker || bankerTotal > nonTieTotal - visiblePlayer
      || (outcomes.length === total && bankerTotal !== visibleBanker)) return undefined;
  }
  if (evidence.road !== undefined && nonTieTotal !== undefined
    && parseAiRoad(evidence.road).flat().filter(isAiRoadCode).length !== nonTieTotal) return undefined;
  return { total, nonTieTotal, bankerTotal, outcomes, shuffling, road: evidence.road };
}

function atPosition(snapshot: AiObservationSnapshot, position: number) {
  return snapshot.outcomes[position - (snapshot.total - snapshot.outcomes.length) - 1];
}

function contradicts(previous: AiObservationSnapshot, next: AiObservationSnapshot) {
  const first = Math.max(previous.total - previous.outcomes.length, next.total - next.outcomes.length) + 1;
  for (let position = first; position <= Math.min(previous.total, next.total); position += 1)
    if (atPosition(previous, position) !== atPosition(next, position)) return true;
  return false;
}

// Pure transition: the caller renders this pending prediction and commits the
// ledger only after that render. A refresh can therefore settle a saved vote,
// but cannot manufacture predictions for rounds missed while the card was away.
export function advanceObservedAi(
  previous: ObservedAiLedger | undefined,
  key: string,
  snapshot: AiObservationSnapshot,
  consensus: ReturnType<typeof aiConsensus>,
): ObservedAiLedger {
  let current = previous?.key === key ? previous : undefined;
  // The same identity must move forward only. New shoes/unknown-shoe segments
  // have a new key. A stale card copy must not delete a newer shared ledger.
  if (current && (snapshot.total < current.snapshot.total || contradicts(current.snapshot, snapshot))) return current;
  if (current && snapshot.total > current.snapshot.total) {
    const previousSnapshot = current.snapshot;
    // Stale bead data can arrive alongside new counters. Wait for a coherent
    // result instead of settling the old last bead or deleting the locked vote.
    if (contradicts(previousSnapshot, snapshot)) return current;
    const added = snapshot.outcomes.slice(-(snapshot.total - previousSnapshot.total));
    if (snapshot.total - previousSnapshot.total <= snapshot.outcomes.length) {
      if (previousSnapshot.nonTieTotal !== undefined && snapshot.nonTieTotal !== undefined
        && snapshot.nonTieTotal - previousSnapshot.nonTieTotal !== added.filter(side => side !== '3').length) return current;
      if (previousSnapshot.bankerTotal !== undefined && snapshot.bankerTotal !== undefined
        && snapshot.bankerTotal - previousSnapshot.bankerTotal !== added.filter(side => side === '2').length) return current;
    }
    if (snapshot.outcomes.length < snapshot.total && snapshot.outcomes.join('') === previousSnapshot.outcomes.join('')
      && (snapshot.road === undefined || snapshot.road === previousSnapshot.road)) return current;
  }
  const decisions = [...(current?.decisions ?? [])];
  if (current?.pending && snapshot.total >= current.pending.position) {
    const outcome = atPosition(snapshot, current.pending.position);
    if (outcome) decisions.push({ ...current.pending, outcome });
  }
  const pending = snapshot.shuffling ? undefined
    : current?.pending?.position === snapshot.total + 1 ? current.pending
      : {
        position: snapshot.total + 1,
        nonTiePosition: snapshot.nonTieTotal === undefined ? undefined : snapshot.nonTieTotal + 1,
        prediction: consensus.side,
        agreement: consensus.side ? consensus.votes.filter(vote => vote.side === consensus.side).length : 0,
        activeVotes: consensus.active,
        votes: consensus.votes,
      };
  if (current && current.pending === pending && decisions.length === current.decisions.length
    && snapshot.total === current.snapshot.total && snapshot.nonTieTotal === current.snapshot.nonTieTotal && snapshot.bankerTotal === current.snapshot.bankerTotal
    && snapshot.road === current.snapshot.road && snapshot.shuffling === current.snapshot.shuffling
    && snapshot.outcomes.join('') === current.snapshot.outcomes.join('')) return current;
  return { version: 2, key, snapshot, pending, decisions };
}

export type ObservedAiPerformance = Omit<PredictionPerformance, 'lastResult'> & { lastResult: PredictionPerformance['lastResult'] | '和局'; ties: number };

// Keep the full retrospective comparison, but never overwrite a witnessed
// prediction with a newly replayed vote when the whole-shoe positions align.
export function withObservedAiDecisions(simulated: PredictionDecision[], ledger?: ObservedAiLedger): PredictionDecision[] {
  if (!ledger || simulated.length !== ledger.snapshot.nonTieTotal) return simulated;
  const decisions = [...simulated];
  for (const record of ledger.decisions) {
    if (record.outcome === '3' || record.nonTiePosition === undefined) continue;
    const index = record.nonTiePosition - 1;
    if (decisions[index]?.outcome === record.outcome)
      decisions[index] = { prediction: record.prediction, outcome: record.outcome, agreement: record.agreement, activeVotes: record.activeVotes };
  }
  return decisions;
}

export function observedAiPerformance(ledger?: ObservedAiLedger, source?: AiSource): ObservedAiPerformance {
  let correct = 0, noSignal = 0, streak = 0, missStreak = 0, maxStreak = 0, maxMissStreak = 0, ties = 0;
  let lastResult: ObservedAiPerformance['lastResult'] = '等待';
  let previousPosition: number | undefined;
  const decisions: PredictionDecision[] = [];
  for (const record of ledger?.decisions ?? []) {
    if (previousPosition !== undefined && record.position !== previousPosition + 1) { streak = 0; missStreak = 0; }
    previousPosition = record.position;
    const prediction = source ? record.votes.find(vote => vote.source === source)?.side : record.prediction;
    decisions.push({ prediction, outcome: record.outcome, agreement: record.agreement, activeVotes: record.activeVotes });
    if (record.outcome === '3') { ties += 1; lastResult = '和局'; }
    else if (!prediction) { noSignal += 1; lastResult = '無訊號'; }
    else if (prediction === record.outcome) { correct += 1; streak += 1; missStreak = 0; maxStreak = Math.max(maxStreak, streak); lastResult = '命中'; }
    else { streak = 0; missStreak += 1; maxMissStreak = Math.max(maxMissStreak, missStreak); lastResult = '錯誤'; }
  }
  // Unknown intervening rounds cannot extend a claim of consecutive hits.
  if (previousPosition !== undefined && previousPosition < (ledger?.snapshot.total ?? 0)) { streak = 0; missStreak = 0; lastResult = '等待'; }
  const total = decisions.length - ties;
  const signaled = total - noSignal;
  return { total, correct, noSignal, accuracy: signaled > 0 ? correct / signaled * 100 : null, streak, missStreak, maxStreak, maxMissStreak, lastResult, ties, decisions };
}

export function restoreObservedAi(raw: string | null, key: string): ObservedAiLedger | undefined {
  if (!raw) return undefined;
  try {
    const value = JSON.parse(raw) as ObservedAiLedger;
    const isSide = (side: unknown) => side === undefined || side === '1' || side === '2';
    const isPrediction = (prediction: LockedPrediction) => prediction && Number.isSafeInteger(prediction.position) && prediction.position > 0
      && (prediction.nonTiePosition === undefined || (Number.isSafeInteger(prediction.nonTiePosition) && prediction.nonTiePosition > 0))
      && isSide(prediction.prediction) && Number.isInteger(prediction.agreement) && prediction.agreement >= 0 && prediction.agreement <= 4
      && Number.isInteger(prediction.activeVotes) && prediction.activeVotes >= 0 && prediction.activeVotes <= 4
      && Array.isArray(prediction.votes) && prediction.votes.length <= 4
      && prediction.votes.every(vote => aiSources.includes(vote.source) && isSide(vote.side));
    if (value?.version !== 2 || value.key !== key || !Array.isArray(value.snapshot?.outcomes)
      || !Number.isSafeInteger(value.snapshot.total) || value.snapshot.total < value.snapshot.outcomes.length
      || (value.snapshot.nonTieTotal !== undefined && (!Number.isSafeInteger(value.snapshot.nonTieTotal) || value.snapshot.nonTieTotal < 0 || value.snapshot.nonTieTotal > value.snapshot.total))
      || (value.snapshot.bankerTotal !== undefined && (!Number.isSafeInteger(value.snapshot.bankerTotal) || value.snapshot.bankerTotal < 0 || value.snapshot.bankerTotal > (value.snapshot.nonTieTotal ?? 0)))
      || (value.snapshot.road !== undefined && typeof value.snapshot.road !== 'string')
      || typeof value.snapshot.shuffling !== 'boolean' || value.snapshot.outcomes.some(side => !['1', '2', '3'].includes(side))
      || !Array.isArray(value.decisions) || value.decisions.length > 2000
      || value.decisions.some((record, index) => !isPrediction(record) || !['1', '2', '3'].includes(record.outcome)
        || record.position > value.snapshot.total || (index > 0 && record.position <= value.decisions[index - 1].position))
      || (value.pending && (!isPrediction(value.pending) || value.pending.position !== value.snapshot.total + 1))) return undefined;
    return value;
  } catch { return undefined; }
}
