import { aiObservationSnapshot, type AiObservationSnapshot } from './ai-observed-predictions.ts';
import { settleBet, type BetSide, type BettingLedger, type BettingStrategy } from './betting-strategy.ts';

export type LiveBettingState = {
  shoe: string;
  lastSettledRound: number;
  pendingPrediction: { round: number; side?: BetSide };
  ledger: BettingLedger;
};

export function liveBettingSnapshot(table: {
  banker: string; player: string; tie: string; beadPlate: string; bigRoad: string;
  aiOutcomes?: ('1' | '2' | '3')[];
}): AiObservationSnapshot | undefined {
  return aiObservationSnapshot(table.beadPlate,
    Number(table.banker) + Number(table.player) + Number(table.tie), false,
    Number(table.banker) + Number(table.player), {
      fullOutcomes: table.aiOutcomes, road: table.bigRoad,
      bankerTotal: Number(table.banker), tailWindow: 36,
    });
}

/** Settle the captured next-round bet once, before capturing another prediction. */
export function advanceLiveBetting(
  previous: LiveBettingState, strategy: BettingStrategy, shoe: string,
  snapshot: AiObservationSnapshot | undefined,
): LiveBettingState {
  if (!snapshot) return previous;
  if (shoe !== previous.shoe) return {
    ...previous, shoe, lastSettledRound: snapshot.total,
    pendingPrediction: { round: snapshot.total },
  };
  if (snapshot.total <= previous.lastSettledRound) return previous;
  const pending = previous.pendingPrediction;
  const offset = snapshot.total - snapshot.outcomes.length;
  const outcome = pending.round >= previous.lastSettledRound && pending.round < snapshot.total
    ? snapshot.outcomes[pending.round - offset] : undefined;
  return {
    ...previous, lastSettledRound: snapshot.total,
    ledger: outcome ? settleBet(strategy, previous.ledger, pending.side, outcome) : previous.ledger,
  };
}
