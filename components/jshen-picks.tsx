'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Crown } from 'lucide-react';
import { BaccaratTableCard, type TableInfo } from '@/components/baccarat-table-card';
import { CardLayoutSelect, cardGridColumns, type CardColumns } from '@/components/card-layout';
import type { CardMode } from '@/components/card-picker';
import { graphicalPrediction } from '@/components/graphical-card';
import { predictionPerformance } from '@/components/ai-prediction-card';
import { aiSources, type AiSource } from '@/lib/ai-consensus';
import { applyActionStrategy, actionStrategyLabels, defaultActionConfig, type ActionStrategy } from '@/lib/action-strategy';
import { bettingStrategyLabels, initialBettingLedger, replayBets, settleBet, type BettingLedger, type BettingStrategy } from '@/lib/betting-strategy';
import { recentPointResults } from '@/lib/point-analysis';
import { evaluatePredictions, type PredictionDecision } from '@/lib/prediction-performance';
import { followRoad, markovRoad, reverseRoad, sequenceRoad, streakRoad } from '@/lib/road-strategies';
import { beadWinners, weightedConsensus, weightedSignal, winningPointSignal } from '@/lib/statistical-cards';

type Platform = 'MT' | 'DG' | 'AB';
type Route = 'stable' | 'bold' | 'hot';
type Combination = {
  cardMode: CardMode;
  betting: BettingStrategy;
  action: ActionStrategy;
  ledger: BettingLedger;
  recentLedger: BettingLedger;
  maxDrawdown: number;
  rankingScore: number;
};
type Pick = { key: string; platform: Platform; sourceLabel: string; table: TableInfo; combination: Combination };

const minimumQualifyingBets = 10;
const stableStrategies = new Set<BettingStrategy>(['flat', 'dalembert']);
const routeLabels: Record<Route, string> = { stable: '穩健精選', bold: '高收益精選', hot: '近期強勢' };

const bettingStrategies = Object.keys(bettingStrategyLabels) as BettingStrategy[];
const actionStrategies = Object.keys(actionStrategyLabels) as ActionStrategy[];
const platformLabel = (platform: Platform) => platform === 'AB' ? '歐博' : platform;

function predictionSets(table: TableInfo): Array<{ cardMode: CardMode; decisions: PredictionDecision[]; isAiConsensus: boolean }> {
  const outcomes = beadWinners(table.beadPlate);
  const points = recentPointResults(table.bigRoad, 10_000);
  const evaluated = (cardMode: CardMode, predict: (history: readonly ('1' | '2' | '3')[]) => '1' | '2' | undefined) => ({
    cardMode, decisions: evaluatePredictions(outcomes, predict, side => side).decisions, isAiConsensus: false,
  });
  const sets: Array<{ cardMode: CardMode; decisions: PredictionDecision[]; isAiConsensus: boolean }> = [
    evaluated('v', history => graphicalPrediction(history, 'v3')),
    evaluated('cross', history => graphicalPrediction(history, 'cross')),
    {
      cardMode: 'points',
      decisions: evaluatePredictions(outcomes, history => {
        const pointCount = history.filter(side => side !== '3').length;
        const answer = winningPointSignal(points.slice(0, pointCount).slice(-36)).answer;
        return answer === '莊' ? '2' : answer === '閒' ? '1' : undefined;
      }, side => side).decisions,
      isAiConsensus: false,
    },
    evaluated('weighted', history => {
      const answer = weightedSignal(history.slice(-36), 36).answer;
      return answer === '莊' ? '2' : answer === '閒' ? '1' : undefined;
    }),
    evaluated('weighted-consensus', history => {
      const answer = weightedConsensus(history.slice(-36)).answer;
      return answer === '莊' ? '2' : answer === '閒' ? '1' : undefined;
    }),
    evaluated('road-follow', history => followRoad(history).side),
    evaluated('road-reverse', history => reverseRoad(history).side),
    evaluated('road-streak', history => streakRoad(history, 3, true).side),
    evaluated('road-sequence', history => sequenceRoad(history, 3).side),
    evaluated('road-markov', history => markovRoad(history, 3).side),
  ];
  const aiCards: Array<[CardMode, readonly AiSource[]]> = [
    ['chartgpt', ['chartgpt']], ['gemini', ['gemini']], ['deepseek', ['deepseek']], ['claude', ['claude']], ['ai-consensus', aiSources],
  ];
  for (const [cardMode, sources] of aiCards) sets.push({
    cardMode,
    decisions: predictionPerformance(table.bigRoad, sources).decisions,
    isAiConsensus: cardMode === 'ai-consensus',
  });
  return sets;
}

function maximumDrawdown(strategy: BettingStrategy, history: readonly PredictionDecision[]): number {
  let ledger = initialBettingLedger();
  let peak = 0;
  let drawdown = 0;
  for (const round of history) {
    ledger = settleBet(strategy, ledger, round.prediction, round.outcome);
    peak = Math.max(peak, ledger.profit);
    drawdown = Math.max(drawdown, peak - ledger.profit);
  }
  return Math.round(drawdown * 100) / 100;
}

function effectiveRounds(history: readonly PredictionDecision[]) {
  return history.filter(round => round.prediction && round.outcome !== '3');
}

function isBetter(candidate: Combination, current: Combination | undefined, route: Route): boolean {
  if (!current) return true;
  if (candidate.rankingScore !== current.rankingScore) return candidate.rankingScore > current.rankingScore;
  const candidateLedger = route === 'hot' ? candidate.recentLedger : candidate.ledger;
  const currentLedger = route === 'hot' ? current.recentLedger : current.ledger;
  if (candidateLedger.profit !== currentLedger.profit) return candidateLedger.profit > currentLedger.profit;
  if (candidateLedger.bets !== currentLedger.bets) return candidateLedger.bets > currentLedger.bets;
  return candidateLedger.wins / candidateLedger.bets > currentLedger.wins / currentLedger.bets;
}

function qualifies(combination: Combination, route: Route): boolean {
  if (route === 'stable') {
    return stableStrategies.has(combination.betting) && combination.ledger.bets >= 20 && combination.ledger.profit > 0 && combination.maxDrawdown <= 8;
  }
  if (route === 'hot') return combination.recentLedger.bets >= minimumQualifyingBets && combination.recentLedger.profit > 0;
  return combination.ledger.bets >= minimumQualifyingBets && combination.ledger.profit > 0;
}

function bestCombination(table: TableInfo, route: Route): Combination | undefined {
  let best: Combination | undefined;
  for (const prediction of predictionSets(table)) for (const action of actionStrategies) {
    const filtered = applyActionStrategy(action, prediction.decisions, defaultActionConfig, prediction.isAiConsensus);
    for (const betting of bettingStrategies) {
      const ledger = replayBets(betting, filtered);
      const recentLedger = replayBets(betting, effectiveRounds(filtered).slice(-20));
      const maxDrawdown = maximumDrawdown(betting, filtered);
      const rankingScore = route === 'stable'
        ? ledger.profit / Math.max(maxDrawdown, 0.5)
        : route === 'hot' ? recentLedger.profit : ledger.profit;
      const combination = { cardMode: prediction.cardMode, betting, action, ledger, recentLedger, maxDrawdown, rankingScore };
      if (qualifies(combination, route) && isBetter(combination, best, route)) best = combination;
    }
  }
  return best;
}

export function JshenPicks({ tablesByPlatform, connectedByPlatform, cardsPerRow, onCardsPerRowChange, onFocusTable }: {
  tablesByPlatform: Record<Platform, TableInfo[]>;
  connectedByPlatform: Record<Platform, boolean>;
  cardsPerRow: CardColumns;
  onCardsPerRowChange: (value: CardColumns) => void;
  onFocusTable: (table: TableInfo) => void;
}) {
  const [route, setRoute] = useState<Route>('stable');
  const latestTables = useRef(tablesByPlatform);
  const [rankingTables, setRankingTables] = useState(tablesByPlatform);
  useEffect(() => {
    latestTables.current = tablesByPlatform;
  }, [tablesByPlatform]);
  useEffect(() => {
    const timer = window.setInterval(() => {
      setRankingTables(latestTables.current);
    }, 15_000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    const rankedCount = Object.values(rankingTables).reduce((total, tables) => total + tables.length, 0);
    const liveCount = Object.values(tablesByPlatform).reduce((total, tables) => total + tables.length, 0);
    if (rankedCount !== 0 || liveCount === 0) return;
    const timer = window.setTimeout(() => setRankingTables(tablesByPlatform), 0);
    return () => window.clearTimeout(timer);
  }, [rankingTables, tablesByPlatform]);
  const picks = useMemo(() => {
    const candidates: Pick[] = [];
    (Object.entries(rankingTables) as Array<[Platform, TableInfo[]]>).forEach(([platform, tables]) => {
      const sourceLabel = platformLabel(platform);
      for (const table of tables) {
        const combination = bestCombination(table, route);
        if (combination) candidates.push({ key: `${platform}:${table.id}`, platform, sourceLabel, table, combination });
      }
    });
    return candidates.sort((left, right) => {
      const scoreDifference = right.combination.rankingScore - left.combination.rankingScore;
      if (scoreDifference !== 0) return scoreDifference;
      const rightLedger = route === 'hot' ? right.combination.recentLedger : right.combination.ledger;
      const leftLedger = route === 'hot' ? left.combination.recentLedger : left.combination.ledger;
      const profitDifference = rightLedger.profit - leftLedger.profit;
      if (profitDifference !== 0) return profitDifference;
      const betDifference = rightLedger.bets - leftLedger.bets;
      if (betDifference !== 0) return betDifference;
      const rightRate = rightLedger.wins / rightLedger.bets;
      const leftRate = leftLedger.wins / leftLedger.bets;
      return rightRate - leftRate;
    }).slice(0, 6);
  }, [rankingTables, route]);

  if (typeof window !== 'undefined') for (const pick of picks) {
    const scope = `curated:${route}:${pick.platform}:${pick.table.id}:${pick.combination.cardMode}:${pick.combination.betting}:${pick.combination.action}`;
    window.localStorage.setItem(`jshen-card-mode:${pick.sourceLabel}:${scope}`, pick.combination.cardMode);
    window.localStorage.setItem(`jshen-betting:${pick.sourceLabel}:${scope}`, JSON.stringify({ strategy: pick.combination.betting, ledger: pick.combination.ledger, lastSettledRound: beadWinners(pick.table.beadPlate).length }));
    window.localStorage.setItem(`jshen-action:${pick.sourceLabel}:${scope}`, JSON.stringify({ strategy: pick.combination.action, config: defaultActionConfig }));
  }

  return <section className="overflow-hidden rounded-2xl border border-amber-300/25 bg-[#0d111a] shadow-[0_24px_70px_rgba(0,0,0,.42)]">
    <header className="border-b border-amber-300/20 px-5 py-4"><div className="flex flex-wrap items-center justify-between gap-3"><div className="flex items-center gap-2 text-amber-200"><Crown className="h-5 w-5" /><h1 className="text-lg font-semibold">J神嚴選</h1><span className="text-xs font-normal text-slate-400">每 15 秒更新</span></div><CardLayoutSelect value={cardsPerRow} onChange={onCardsPerRowChange} /></div><div className="mt-3 flex gap-2 overflow-x-auto">{(Object.keys(routeLabels) as Route[]).map(value => <button key={value} type="button" onClick={() => setRoute(value)} className={`shrink-0 rounded-lg border px-3 py-1.5 text-sm font-bold transition ${route === value ? "border-amber-300 bg-amber-300/15 text-amber-100" : "border-slate-600 bg-slate-900/60 text-slate-400 hover:border-amber-300/50"}`}>{routeLabels[value]}</button>)}</div></header>
    {picks.length ? <div className={`grid gap-3 p-3 ${cardGridColumns[cardsPerRow]}`}>
      {picks.map(pick => {
        const scope = `curated:${route}:${pick.platform}:${pick.table.id}:${pick.combination.cardMode}:${pick.combination.betting}:${pick.combination.action}`;
        const metric = route === 'hot' ? pick.combination.recentLedger : pick.combination.ledger;
        return <div key={pick.key} className="min-w-0 overflow-hidden rounded-lg border border-amber-300/20"><div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-amber-300/15 bg-amber-300/5 px-3 py-1.5 text-xs text-slate-300"><strong className="text-amber-100">{routeLabels[route]}</strong><span>{route === 'hot' ? '最近20注' : '本靴'}：<b className="text-base text-emerald-300">+{metric.profit.toFixed(2)} 注</b></span><span>{metric.bets} 注（{metric.wins}勝／{metric.losses}負）</span></div><BaccaratTableCard key={scope} table={pick.table} connected={connectedByPlatform[pick.platform]} platformLabel={pick.sourceLabel} onFocusTable={onFocusTable} storageScope={scope} /></div>;
      })}
    </div> : <div className="grid min-h-56 place-items-center p-6 text-center text-sm text-slate-400">目前沒有符合「{routeLabels[route]}」條件的正收益組合</div>}
  </section>;
}
