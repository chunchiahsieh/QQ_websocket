export type BettingStrategy =
  | 'flat'
  | '1326'
  | 'dalembert'
  | 'martingale'
  | 'reverse-dalembert'
  | 'reverse-1326'
  | 'reverse-martingale';
export type BetSide = '1' | '2';
export type BetOutcome = '1' | '2' | '3';

export type BettingLedger = {
  step: number;
  nextStake: number;
  profit: number;
  bets: number;
  wins: number;
  losses: number;
};

export const bettingStrategyLabels: Record<BettingStrategy, string> = {
  flat: '固定注碼',
  '1326': '1－3－2－6',
  dalembert: '達朗貝爾',
  martingale: '馬丁格爾',
  'reverse-dalembert': '反達朗貝爾',
  'reverse-1326': '反1－3－2－6',
  'reverse-martingale': '反馬丁格爾',
};

export const initialBettingLedger = (): BettingLedger => ({ step: 0, nextStake: 1, profit: 0, bets: 0, wins: 0, losses: 0 });

export function settleBet(strategy: BettingStrategy, ledger: BettingLedger, prediction: BetSide | undefined, outcome: BetOutcome): BettingLedger {
  if (!prediction || outcome === '3') return ledger;
  const won = prediction === outcome;
  const sequence = [1, 3, 2, 6];
  const is1326 = strategy === '1326' || strategy === 'reverse-1326';
  const stake = is1326 ? sequence[ledger.step] ?? 1 : strategy === 'flat' ? 1 : ledger.nextStake;
  const profitDelta = won ? stake * (prediction === '2' ? 0.95 : 1) : -stake;
  let step = ledger.step;
  let nextStake = stake;
  if (strategy === 'flat') { step = 0; nextStake = 1; }
  else if (strategy === '1326') { step = won ? (ledger.step + 1) % 4 : 0; nextStake = sequence[step]; }
  else if (strategy === 'dalembert') { nextStake = won ? Math.max(1, stake - 1) : stake + 1; step = 0; }
  else if (strategy === 'martingale') { nextStake = won ? 1 : stake * 2; step = 0; }
  else if (strategy === 'reverse-dalembert') { nextStake = won ? stake + 1 : Math.max(1, stake - 1); step = 0; }
  else if (strategy === 'reverse-1326') { step = won ? 0 : (ledger.step + 1) % 4; nextStake = sequence[step]; }
  else {
    // Reverse Martingale (Paroli): limit the progression to 1 → 2 → 4.
    // Reset after the third consecutive win or immediately after a loss so a
    // single oversized wager cannot dominate the whole-shoe result.
    if (!won || ledger.step >= 2) { step = 0; nextStake = 1; }
    else { step = ledger.step + 1; nextStake = stake * 2; }
  }
  return {
    step, nextStake, profit: Math.round((ledger.profit + profitDelta) * 100) / 100,
    bets: ledger.bets + 1, wins: ledger.wins + (won ? 1 : 0), losses: ledger.losses + (won ? 0 : 1),
  };
}

export function replayBets(strategy: BettingStrategy, history: readonly { prediction?: BetSide; outcome: BetOutcome }[]): BettingLedger {
  return history.reduce((ledger, round) => settleBet(strategy, ledger, round.prediction, round.outcome), initialBettingLedger());
}
