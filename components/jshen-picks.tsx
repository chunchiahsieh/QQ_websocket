'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Crown } from 'lucide-react';
import { BaccaratTableCard, type FocusedTableSettings, type TableInfo } from '@/components/baccarat-table-card';
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
type Route = 'stable' | 'bold' | 'hot' | 'watch';
type SortMode = 'win-rate' | 'profit' | 'roi';
type Combination = {
  cardMode: CardMode;
  betting: BettingStrategy;
  action: ActionStrategy;
  ledger: BettingLedger;
  recentLedger: BettingLedger;
  recent10Ledger: BettingLedger;
  maxDrawdown: number;
  rankingScore: number;
};
type Pick = { key: string; platform: Platform; sourceLabel: string; table: TableInfo; combination: Combination };

const minimumQualifyingBets = 10;
const stableStrategies = new Set<BettingStrategy>(['flat', 'dalembert']);
const routeLabels: Record<Route, string> = { stable: '穩健精選', bold: '高收益精選', hot: '近期強勢', watch: '觀察名單' };
const defaultSortByRoute: Record<Route, SortMode> = { stable: 'win-rate', bold: 'profit', hot: 'profit', watch: 'win-rate' };
const sortLabels: Record<SortMode, string> = { 'win-rate': '勝率排行', profit: '收益排行', roi: 'ROI 排行' };
const routeDescriptions: Record<Route, string> = {
  stable: '低波動、長期正收益；至少實際出手 20 次。',
  bold: '依本靴淨贏注數尋找高收益組合，可接受較高波動。',
  hot: '比較最近 20 次實際出手，找出目前表現較強的組合。',
  watch: '最近 10 次出手開始轉強，但資料尚未達到正式精選門檻。',
};

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

function combinationMetric(combination: Combination, route: Route, sortMode: SortMode): number {
  const ledger = route === 'watch' ? combination.recent10Ledger : route === 'hot' ? combination.recentLedger : combination.ledger;
  if (sortMode === 'profit') return ledger.profit;
  if (sortMode === 'roi') return ledger.totalStake ? ledger.profit / ledger.totalStake : 0;
  return ledger.bets ? ledger.wins / ledger.bets : 0;
}

function isBetter(candidate: Combination, current: Combination | undefined, route: Route, sortMode: SortMode): boolean {
  if (!current) return true;
  const candidateMetric = combinationMetric(candidate, route, sortMode);
  const currentMetric = combinationMetric(current, route, sortMode);
  if (candidateMetric !== currentMetric) return candidateMetric > currentMetric;
  const candidateLedger = route === 'watch' ? candidate.recent10Ledger : route === 'hot' ? candidate.recentLedger : candidate.ledger;
  const currentLedger = route === 'watch' ? current.recent10Ledger : route === 'hot' ? current.recentLedger : current.ledger;
  if (candidateLedger.profit !== currentLedger.profit) return candidateLedger.profit > currentLedger.profit;
  if (candidateLedger.bets !== currentLedger.bets) return candidateLedger.bets > currentLedger.bets;
  return candidateLedger.wins / candidateLedger.bets > currentLedger.wins / currentLedger.bets;
}

function qualifies(combination: Combination, route: Route): boolean {
  if (route === 'stable') {
    return stableStrategies.has(combination.betting) && combination.ledger.bets >= 20 && combination.ledger.profit > 0 && combination.maxDrawdown <= 8;
  }
  if (route === 'hot') return combination.recentLedger.bets >= minimumQualifyingBets && combination.recentLedger.profit > 0;
  if (route === 'watch') {
    return combination.recent10Ledger.bets >= 5 && combination.recent10Ledger.profit > 0 &&
      (combination.ledger.profit <= 0 || combination.recentLedger.profit <= 0 || combination.recentLedger.bets < minimumQualifyingBets);
  }
  return combination.ledger.bets >= minimumQualifyingBets && combination.ledger.profit > 0;
}

function bestCombination(table: TableInfo, route: Route, sortMode: SortMode): Combination | undefined {
  let best: Combination | undefined;
  for (const prediction of predictionSets(table)) for (const action of actionStrategies) {
    const filtered = applyActionStrategy(action, prediction.decisions, defaultActionConfig, prediction.isAiConsensus);
    for (const betting of bettingStrategies) {
      const ledger = replayBets(betting, filtered);
      const recentLedger = replayBets(betting, effectiveRounds(filtered).slice(-20));
      const recent10Ledger = replayBets(betting, effectiveRounds(filtered).slice(-10));
      const maxDrawdown = maximumDrawdown(betting, filtered);
      const rankingScore = route === 'stable'
        ? ledger.profit / Math.max(maxDrawdown, 0.5)
        : route === 'hot' ? recentLedger.profit : route === 'watch' ? recent10Ledger.profit : ledger.profit;
      const combination = { cardMode: prediction.cardMode, betting, action, ledger, recentLedger, recent10Ledger, maxDrawdown, rankingScore };
      if (qualifies(combination, route) && isBetter(combination, best, route, sortMode)) best = combination;
    }
  }
  return best;
}

export function JshenPicks({ tablesByPlatform, connectedByPlatform, cardsPerRow, onCardsPerRowChange, onFocusTable }: {
  tablesByPlatform: Record<Platform, TableInfo[]>;
  connectedByPlatform: Record<Platform, boolean>;
  cardsPerRow: CardColumns;
  onCardsPerRowChange: (value: CardColumns) => void;
  onFocusTable: (table: TableInfo, settings?: FocusedTableSettings) => void;
}) {
  const [route, setRoute] = useState<Route>('stable');
  const [sortMode, setSortMode] = useState<SortMode>('win-rate');
  const rankHistory = useRef<Record<Route, Record<string, { rank: number; streak: number }>>>({ stable: {}, bold: {}, hot: {}, watch: {} });
  const [rankBadges, setRankBadges] = useState<Record<string, { movement: string; streak: number }>>({});
  const selectRoute = (nextRoute: Route) => {
    setRoute(nextRoute);
    setSortMode(defaultSortByRoute[nextRoute]);
  };
  const latestTables = useRef(tablesByPlatform);
  const [rankingTables, setRankingTables] = useState(tablesByPlatform);
  useEffect(() => {
    latestTables.current = tablesByPlatform;
  }, [tablesByPlatform]);
  useEffect(() => {
    const timer = window.setInterval(() => {
      setRankingTables(latestTables.current);
    }, 10_000);
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
        const combination = bestCombination(table, route, sortMode);
        if (combination) candidates.push({ key: `${platform}:${table.id}`, platform, sourceLabel, table, combination });
      }
    });
    return candidates.sort((left, right) => {
      const rightLedger = route === 'watch' ? right.combination.recent10Ledger : route === 'hot' ? right.combination.recentLedger : right.combination.ledger;
      const leftLedger = route === 'watch' ? left.combination.recent10Ledger : route === 'hot' ? left.combination.recentLedger : left.combination.ledger;
      const rightPrimary = sortMode === 'profit'
        ? rightLedger.profit
        : sortMode === 'roi'
          ? rightLedger.totalStake ? rightLedger.profit / rightLedger.totalStake : 0
          : rightLedger.bets ? rightLedger.wins / rightLedger.bets : 0;
      const leftPrimary = sortMode === 'profit'
        ? leftLedger.profit
        : sortMode === 'roi'
          ? leftLedger.totalStake ? leftLedger.profit / leftLedger.totalStake : 0
          : leftLedger.bets ? leftLedger.wins / leftLedger.bets : 0;
      if (rightPrimary !== leftPrimary) return rightPrimary - leftPrimary;
      const profitDifference = rightLedger.profit - leftLedger.profit;
      if (profitDifference !== 0) return profitDifference;
      const betDifference = rightLedger.bets - leftLedger.bets;
      if (betDifference !== 0) return betDifference;
      const rightRate = rightLedger.wins / rightLedger.bets;
      const leftRate = leftLedger.wins / leftLedger.bets;
      return rightRate - leftRate;
    }).slice(0, 6);
  }, [rankingTables, route, sortMode]);

  useEffect(() => {
    const previous = rankHistory.current[route];
    const next: Record<string, { rank: number; streak: number }> = {};
    const badges: Record<string, { movement: string; streak: number }> = {};
    picks.forEach((pick, index) => {
      const rank = index + 1;
      const before = previous[pick.key];
      const streak = before ? before.streak + 1 : 1;
      const difference = before ? before.rank - rank : 0;
      next[pick.key] = { rank, streak };
      badges[pick.key] = {
        movement: before ? difference > 0 ? `↑ ${difference}` : difference < 0 ? `↓ ${Math.abs(difference)}` : '持平' : '新進榜',
        streak,
      };
    });
    rankHistory.current[route] = next;
    const timer = window.setTimeout(() => setRankBadges(badges), 0);
    return () => window.clearTimeout(timer);
  }, [picks, route]);

  if (typeof window !== 'undefined') for (const pick of picks) {
    const scope = `curated:${route}:${pick.platform}:${pick.table.id}:${pick.combination.cardMode}:${pick.combination.betting}:${pick.combination.action}`;
    window.localStorage.setItem(`jshen-card-mode:${pick.sourceLabel}:${scope}`, pick.combination.cardMode);
    window.localStorage.setItem(`jshen-betting:${pick.sourceLabel}:${scope}`, JSON.stringify({ strategy: pick.combination.betting, ledger: pick.combination.ledger, lastSettledRound: beadWinners(pick.table.beadPlate).length }));
    window.localStorage.setItem(`jshen-action:${pick.sourceLabel}:${scope}`, JSON.stringify({ strategy: pick.combination.action, config: defaultActionConfig }));
  }

  return <section className="overflow-hidden rounded-2xl border border-amber-300/25 bg-[#0d111a] shadow-[0_24px_70px_rgba(0,0,0,.42)]">
    <header className="border-b border-amber-300/20 px-5 py-4"><div className="flex flex-wrap items-center justify-between gap-3"><div className="flex items-center gap-2 text-amber-200"><Crown className="h-5 w-5" /><h1 className="text-lg font-semibold">J神嚴選</h1><span className="text-xs font-normal text-slate-400">每 10 秒更新</span></div><div className="flex items-center gap-2"><label className="flex items-center gap-1 text-xs text-slate-400">排序<select value={sortMode} onChange={event => setSortMode(event.target.value as SortMode)} className="rounded-md border border-slate-600 bg-slate-900 px-2 py-1.5 font-semibold text-white"><option value="win-rate">勝率排行</option><option value="profit">收益排行</option><option value="roi">ROI 排行</option></select></label><CardLayoutSelect value={cardsPerRow} onChange={onCardsPerRowChange} /></div></div><div className="mt-3 flex gap-2 overflow-x-auto">{(Object.keys(routeLabels) as Route[]).map(value => <button key={value} type="button" onClick={() => selectRoute(value)} className={`shrink-0 rounded-lg border px-3 py-1.5 text-sm font-bold transition ${route === value ? "border-amber-300 bg-amber-300/15 font-bold text-amber-100" : "border-slate-600 bg-slate-900/60 text-slate-400 hover:border-amber-300/50"}`}>{routeLabels[value]}</button>)}</div><div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border border-white/5 bg-black/20 px-3 py-2 text-xs text-slate-300"><strong className="text-amber-100">{routeLabels[route]}</strong><span>{routeDescriptions[route]}</span><span className="rounded bg-slate-800 px-1.5 py-0.5 text-cyan-100">目前依「{sortLabels[sortMode]}」顯示前 6 名</span></div></header>
    {picks.length ? <div className={`grid gap-3 p-3 ${cardGridColumns[cardsPerRow]}`}>
      {picks.map(pick => {
        const scope = `curated:${route}:${pick.platform}:${pick.table.id}:${pick.combination.cardMode}:${pick.combination.betting}:${pick.combination.action}`;
        const metric = route === 'watch' ? pick.combination.recent10Ledger : route === 'hot' ? pick.combination.recentLedger : pick.combination.ledger;
        const winRate = metric.bets ? metric.wins / metric.bets * 100 : 0;
        const roi = metric.totalStake ? metric.profit / metric.totalStake * 100 : 0;
        const recent10 = pick.combination.recent10Ledger;
        const confidence = pick.combination.ledger.bets >= 30 ? '高' : pick.combination.ledger.bets >= 20 ? '中' : pick.combination.ledger.bets >= 10 ? '觀察中' : '資料累積中';
        const rankBadge = rankBadges[pick.key];
        const periodLabel = route === 'watch' ? '最近10注' : route === 'hot' ? '最近20注' : '本靴';
        const reason = route === 'stable'
          ? `長期正收益・樣本充足・近 10 注 ${recent10.wins} 勝`
          : route === 'bold'
            ? `本靴淨收益排名前六・近 10 注 ${recent10.wins} 勝`
            : route === 'hot'
              ? `最近 20 注表現排名前六・近 10 注 ${recent10.wins} 勝`
              : `最近 10 注轉強，尚待更多資料確認`;
        return <div key={pick.key} className="min-w-0 overflow-hidden rounded-lg border border-amber-300/20">
          <div className="border-b border-amber-300/15 bg-amber-300/5 px-3 py-2 text-xs text-slate-300">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
              <span className="font-semibold text-slate-400">{periodLabel}</span>
              <strong className="font-bold text-emerald-300">+{metric.profit.toFixed(2)} 注</strong>
              <span className="text-slate-300">實際出手 {metric.bets} 次</span>
              <span className="text-slate-400">{metric.wins}勝／{metric.losses}負</span>
              <span className="rounded-full bg-cyan-400/10 px-2 py-0.5 text-cyan-100">勝率 <b>{winRate.toFixed(1)}%</b></span>
              <span className="rounded-full bg-amber-300/10 px-2 py-0.5 text-amber-100">ROI <b>{roi.toFixed(1)}%</b></span>
            </div>
            <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-white/5 pt-1.5">
              <span className="rounded bg-slate-800 px-1.5 py-0.5">可信度：<b className="text-white">{confidence}</b></span>
              {rankBadge && <span className={rankBadge.movement.startsWith('↑') ? 'font-semibold text-emerald-300' : rankBadge.movement.startsWith('↓') ? 'font-semibold text-rose-300' : 'text-slate-300'}>{rankBadge.movement}<span className="ml-2 text-slate-400">連續入選 {rankBadge.streak} 次</span></span>}
              <span className="basis-full text-[11px] text-slate-400 sm:basis-auto sm:ml-auto"><b className="text-slate-300">入選亮點：</b>{reason}</span>
            </div>
          </div>
          <BaccaratTableCard key={scope} table={pick.table} connected={connectedByPlatform[pick.platform]} platformLabel={pick.sourceLabel} onFocusTable={onFocusTable} storageScope={scope} />
        </div>;
      })}
    </div> : <div className="grid min-h-56 place-items-center p-6 text-center text-sm text-slate-400">目前沒有符合「{routeLabels[route]}」條件的正收益組合</div>}
  </section>;
}
