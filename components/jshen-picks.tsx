'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Crown } from 'lucide-react';
import { Bar, BarChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { BaccaratTableCard, type FocusedTableSettings, type TableInfo } from '@/components/baccarat-table-card';
import { CardLayoutSelect, cardGridColumns, type CardColumns } from '@/components/card-layout';
import { cardNames, type CardMode } from '@/components/card-picker';
import { graphicalPrediction } from '@/components/graphical-card';
import { completeAiHistory } from '@/lib/ai-complete-history';
import { aiSources, type AiSource } from '@/lib/ai-consensus';
import { applyActionStrategy, actionStrategyLabels, defaultActionConfig, type ActionStrategy } from '@/lib/action-strategy';
import { bettingStrategyLabels, initialBettingLedger, replayBets, settleBet, type BettingLedger, type BettingStrategy } from '@/lib/betting-strategy';
import { recentPointResults } from '@/lib/point-analysis';
import { evaluatePredictions, type PredictionDecision } from '@/lib/prediction-performance';
import { followRoad, markovRoad, reverseRoad, sequenceRoad, streakRoad } from '@/lib/road-strategies';
import { beadWinners, weightedConsensus, weightedSignal, winningPointSignal } from '@/lib/statistical-cards';
import { parsePickPlatforms, pickPlatforms, pickPlatformStorageKey, selectedPlatformTables, togglePickPlatform, type PickPlatform } from '@/lib/jshen-platform-filter';
import { findLivePickTable } from '@/lib/jshen-live-table';

type Platform = PickPlatform;
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
type SimulationEventType = 'system' | 'load' | 'bet' | 'settle-win' | 'settle-loss' | 'settle-tie' | 'switch';
type SimulationEvent = { id: string; type: SimulationEventType; text: string; createdAt?: string };
type SimulationSummary = { sessionId: string; day: string; rounds: number; bets: number; wins: number; losses: number; totalStake: number; profit: number; switches: number; endReason: string };
type SimulationControl = { running: boolean; isRunner?: boolean; sessionId: string; unitAmount: number; summary?: SimulationSummary | null; lines?: SimulationEvent[];
  status?: { tableCount: number; pendingCount: number; profitSeries: Array<{ at: string; profit: number }>; tables: Array<{ table: string; card: string; betting: string; action: string; score: number; bets: number; wins: number; losses: number; profit: number; prediction: '莊' | '閒' | null; stake: number; state: string }> } };

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
  const aiOutcomes = table.aiOutcomes
    ?? (outcomes.length === Number(table.banker) + Number(table.player) + Number(table.tie) ? outcomes : undefined);
  for (const [cardMode, sources] of aiCards) sets.push({
    cardMode,
    decisions: aiOutcomes ? completeAiHistory(table.bigRoad, sources, aiOutcomes)?.performance.decisions ?? [] : [],
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

function renderSimulationEventText(value: string) {
  return value.split(/(押莊|押閒|下注 \d+(?:\.\d+)?單位)/g).map((part, index) =>
    <span key={index} className={part === '押莊' ? 'font-bold text-rose-400' : part === '押閒' ? 'font-bold text-sky-400' : /^下注 \d+(?:\.\d+)?單位$/.test(part) ? 'font-bold text-amber-200' : undefined}>{part}</span>);
}
function SimulationDashboard() {
  const [control, setControl] = useState<SimulationControl>();
  const terminalRef = useRef<HTMLDivElement>(null);
  const followLatest = useRef(true);
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const response = await fetch('/api/simulation', { cache: 'no-store' });
        if (!response.ok) return;
        const data = await response.json() as SimulationControl;
        if (!cancelled) setControl(data);
      } catch { /* Keep the last snapshot during a brief connection interruption. */ }
    };
    void load();
    const timer = window.setInterval(load, 3000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, []);
  const summary = control?.summary;
  const status = control?.status;
  const events = (control?.lines ?? []).filter(event => event.type === 'bet' || event.type.startsWith('settle-'));
  const profitChart = (status?.profitSeries ?? []).map((point, index) => ({ index: index + 1, profit: point.profit / 100, time: new Date(point.at).toLocaleTimeString('zh-TW', { hour12: false }) }));
  const tableChart = (status?.tables ?? []).map(table => ({ name: table.table, profit: table.profit / 100, winRate: table.bets ? Math.round(table.wins / table.bets * 1000) / 10 : 0 }));
  useEffect(() => { if (terminalRef.current && followLatest.current) terminalRef.current.scrollTop = terminalRef.current.scrollHeight; }, [control?.lines]);
  const rate = (count: number) => summary?.bets ? `${(count / summary.bets * 100).toFixed(1)}%` : '0.0%';
  return <section className="overflow-hidden rounded-2xl border border-emerald-400/25 bg-[#0d111a] shadow-[0_24px_70px_rgba(0,0,0,.42)]">
    <div className="border-b border-emerald-400/20 p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="font-mono text-lg font-bold text-emerald-200">AI下單 -測試中</h2><span className={`rounded px-2 py-1 font-mono text-xs ${control?.running ? 'bg-emerald-400/15 text-emerald-300' : 'bg-slate-800 text-slate-400'}`}>{control?.running ? '● RUNNING' : '■ STOPPED'}</span></div>
      {control?.running && !status?.tableCount && <p className="mt-2 text-xs text-amber-200">等待採集端提供即時牌桌資料。</p>}
      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 font-mono text-xs text-emerald-100"><span>桌數 {status?.tableCount ?? 0}</span><span>已驗證 {summary?.rounds ?? 0} 局</span><span>已結算 {summary?.bets ?? 0} 注</span><span>待結算 {status?.pendingCount ?? 0} 注</span><span>勝率 {rate(summary?.wins ?? 0)}</span><span>錯誤率 {rate(summary?.losses ?? 0)}</span><span>AI 換桌 {summary?.switches ?? 0}</span><span>累計下注 {((summary?.totalStake ?? 0) / 100).toFixed(2)} 注</span><strong className={(summary?.profit ?? 0) >= 0 ? 'text-emerald-300' : 'text-rose-300'}>最後損益 {(summary?.profit ?? 0) >= 0 ? '+' : '-'}{Math.abs((summary?.profit ?? 0) / 100).toFixed(2)} 注</strong></div>
    </div>
    <div className="grid gap-3 p-4 lg:grid-cols-2">
      <div className="rounded-xl border border-slate-700 bg-slate-950/60 p-3"><h3 className="mb-2 text-sm font-semibold text-slate-200">累計損益（注）</h3><div className="h-48">{profitChart.length ? <ResponsiveContainer width="100%" height="100%"><LineChart data={profitChart}><CartesianGrid stroke="#263343" strokeDasharray="3 3" /><XAxis dataKey="index" stroke="#94a3b8" fontSize={10} /><YAxis stroke="#94a3b8" fontSize={10} width={50} /><Tooltip contentStyle={{ background: '#0f172a', borderColor: '#334155' }} /><Line type="monotone" dataKey="profit" name="損益（注）" stroke="#34d399" strokeWidth={2} dot={false} /></LineChart></ResponsiveContainer> : <div className="flex h-full items-center justify-center text-xs text-slate-500">等待已結算資料</div>}</div></div>
      <div className="rounded-xl border border-slate-700 bg-slate-950/60 p-3"><h3 className="mb-2 text-sm font-semibold text-slate-200">目前六桌損益（注）</h3><div className="h-48">{tableChart.length ? <ResponsiveContainer width="100%" height="100%"><BarChart data={tableChart}><CartesianGrid stroke="#263343" strokeDasharray="3 3" /><XAxis dataKey="name" stroke="#94a3b8" fontSize={10} /><YAxis stroke="#94a3b8" fontSize={10} width={50} /><Tooltip contentStyle={{ background: '#0f172a', borderColor: '#334155' }} /><Bar dataKey="profit" name="損益（注）" fill="#38bdf8" /></BarChart></ResponsiveContainer> : <div className="flex h-full items-center justify-center text-xs text-slate-500">等待選桌資料</div>}</div></div>
    </div>
    {!!status?.tables.length && <div className="grid gap-2 px-4 pb-4 sm:grid-cols-2 xl:grid-cols-3">{status.tables.map((table, index) => <div key={`${index}-${table.table}`} className="rounded-lg border border-slate-700 bg-slate-950/50 p-3 text-xs text-slate-300"><div className="font-semibold text-sky-200">{table.table} · {table.card}</div><div className="mt-1 text-slate-400">{table.betting}｜{table.action}｜歷史評分 {table.score.toFixed(1)}</div><div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1"><span>下局預測：<strong className={table.prediction === '莊' ? 'text-rose-400' : table.prediction === '閒' ? 'text-sky-400' : 'text-slate-400'}>{table.prediction ?? '無訊號'}</strong></span><span>{table.state === '已模擬下單・待結算' ? '已下注' : '預計注碼'}：<strong className="text-amber-200">{table.stake} 單位</strong></span><span className={table.state === '已模擬下單・待結算' ? 'text-emerald-300' : 'text-slate-400'}>{table.state}</span></div><div className="mt-2">執行後 {table.bets} 注 · 勝率 {table.bets ? (table.wins / table.bets * 100).toFixed(1) : '—'}% · <strong className={table.profit >= 0 ? 'text-emerald-300' : 'text-rose-300'}>{table.profit >= 0 ? '+' : '-'}{Math.abs(table.profit / 100).toFixed(2)} 注</strong></div></div>)}</div>}
    <div className="px-4 pb-4"><div ref={terminalRef} onScroll={event => { const element = event.currentTarget; followLatest.current = element.scrollHeight - element.scrollTop - element.clientHeight <= 24; }} className="h-64 overflow-y-auto border border-emerald-500/30 bg-black p-3 font-mono text-[11px] leading-5 sm:text-xs" role="log" aria-live="polite">{events.length ? events.map(event => <div key={event.id} className={event.type === 'settle-loss' ? 'text-rose-300' : event.type === 'settle-win' ? 'text-emerald-300' : event.type === 'settle-tie' ? 'text-slate-300' : 'text-amber-300'}>[{new Date(event.createdAt!).toLocaleTimeString('zh-TW', { hour12: false })}] {renderSimulationEventText(event.text)}</div>) : <span className="text-slate-500">等待模擬下注事件…</span>}</div></div>
  </section>;
}

export function JshenPicks({ tablesByPlatform, connectedByPlatform, cardsPerRow, onCardsPerRowChange, onFocusTable, simulationOnly = false }: {
  tablesByPlatform: Record<Platform, TableInfo[]>;
  connectedByPlatform: Record<Platform, boolean>;
  cardsPerRow: CardColumns;
  onCardsPerRowChange: (value: CardColumns) => void;
  onFocusTable: (table: TableInfo, settings?: FocusedTableSettings) => void;
  simulationOnly?: boolean;
}) {
  const [route, setRoute] = useState<Route>('stable');
  const [sortMode, setSortMode] = useState<SortMode>('win-rate');
  const [selectedPlatforms, setSelectedPlatforms] = useState<Platform[]>([...pickPlatforms]);
  const [platformsReady, setPlatformsReady] = useState(false);
  const [platformMessage, setPlatformMessage] = useState('');
  const rankingScope = `${route}:${sortMode}:${selectedPlatforms.join(',')}`;
  const rankHistory = useRef<{ scope: string; entries: Record<string, { rank: number; streak: number }> }>({ scope: '', entries: {} });
  const [rankBadges, setRankBadges] = useState<{ scope: string; entries: Record<string, { movement: string; streak: number }> }>({ scope: '', entries: {} });
  const selectRoute = (nextRoute: Route) => {
    setRoute(nextRoute);
    setSortMode(defaultSortByRoute[nextRoute]);
  };
  const latestTables = useRef(tablesByPlatform);
  const [rankingTables, setRankingTables] = useState(tablesByPlatform);
  useEffect(() => {
    try {
      setSelectedPlatforms(parsePickPlatforms(window.localStorage.getItem(pickPlatformStorageKey)));
    } catch { /* Keep the default when browser storage is unavailable. */ }
    setPlatformsReady(true);
  }, []);
  const selectPlatforms = (next: Platform[]) => {
    if (next.join(',') === selectedPlatforms.join(',')) return;
    setSelectedPlatforms(next);
    setPlatformMessage('');
    setRankingTables(latestTables.current);
    try {
      window.localStorage.setItem(pickPlatformStorageKey, JSON.stringify(next));
    } catch { /* Filtering still works without persisted preferences. */ }
  };
  const togglePlatform = (value: Platform) => {
    if (selectedPlatforms.length === 1 && selectedPlatforms.includes(value)) {
      setPlatformMessage('請至少保留一個平台。');
      return;
    }
    selectPlatforms(togglePickPlatform(selectedPlatforms, value));
  };
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
    if (!platformsReady) return [];
    const candidates: Pick[] = [];
    selectedPlatformTables(rankingTables, selectedPlatforms).forEach(([platform, tables]) => {
      const sourceLabel = platformLabel(platform);
      const uniqueTables = new Map<string, TableInfo>();
      for (const table of tables) {
        const tableKey = table.id.trim().toUpperCase();
        const current = uniqueTables.get(tableKey);
        const currentFreshness = current?.countdownReceivedAt ?? 0;
        const nextFreshness = table.countdownReceivedAt ?? 0;
        if (!current || nextFreshness > currentFreshness ||
          (nextFreshness === currentFreshness && table.beadPlate.length > current.beadPlate.length)) {
          uniqueTables.set(tableKey, table);
        }
      }
      for (const table of uniqueTables.values()) {
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
  }, [rankingTables, route, sortMode, selectedPlatforms, platformsReady]);


  useEffect(() => {
    const previous = rankHistory.current.scope === rankingScope ? rankHistory.current.entries : {};
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
    rankHistory.current = { scope: rankingScope, entries: next };
    const timer = window.setTimeout(() => setRankBadges({ scope: rankingScope, entries: badges }), 0);
    return () => window.clearTimeout(timer);
  }, [picks, rankingScope]);

  if (typeof window !== 'undefined') for (const pick of picks) {
    const scope = `curated:${route}:${pick.platform}:${pick.table.id}:${pick.combination.cardMode}:${pick.combination.betting}:${pick.combination.action}`;
    try {
      window.localStorage.setItem(`jshen-card-mode:${pick.sourceLabel}:${scope}`, pick.combination.cardMode);
      window.localStorage.setItem(`jshen-betting:${pick.sourceLabel}:${scope}`, JSON.stringify({ strategy: pick.combination.betting, ledger: pick.combination.ledger, lastSettledRound: Number(pick.table.banker) + Number(pick.table.player) + Number(pick.table.tie), shoe: pick.table.shoe, roundPositionVersion: 2 }));
      window.localStorage.setItem(`jshen-action:${pick.sourceLabel}:${scope}`, JSON.stringify({ strategy: pick.combination.action, config: defaultActionConfig }));
    } catch { /* Keep displaying rankings if browser storage is full or unavailable. */ }
  }

  if (simulationOnly) return <SimulationDashboard />;

  return <section className="overflow-hidden rounded-2xl border border-amber-300/25 bg-[#0d111a] shadow-[0_24px_70px_rgba(0,0,0,.42)]">
    <header className="border-b border-amber-300/20 px-5 py-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-amber-200"><Crown className="h-5 w-5" /><h1 className="text-lg font-semibold">J神嚴選</h1><span className="text-xs font-normal text-slate-400">每 10 秒更新</span></div>
        <div className="flex flex-wrap items-center gap-2"><label className="flex items-center gap-1 text-xs text-slate-400">排序<select value={sortMode} onChange={event => setSortMode(event.target.value as SortMode)} className="rounded-md border border-slate-600 bg-slate-900 px-2 py-1.5 font-semibold text-white"><option value="win-rate">勝率排行</option><option value="profit">收益排行</option><option value="roi">ROI 排行</option></select></label><CardLayoutSelect value={cardsPerRow} onChange={onCardsPerRowChange} /></div>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2" role="group" aria-label="平台篩選">
        <span className="text-xs text-slate-400">平台</span>
        {pickPlatforms.map(value => <label key={value} className={`flex min-h-8 cursor-pointer items-center gap-1.5 rounded-md border px-2.5 text-xs font-semibold transition ${selectedPlatforms.includes(value) ? 'border-cyan-300/60 bg-cyan-400/10 text-cyan-100' : 'border-slate-600 text-slate-400'}`}>
          <input type="checkbox" checked={selectedPlatforms.includes(value)} disabled={!platformsReady} onChange={() => togglePlatform(value)} className="h-3.5 w-3.5 accent-cyan-400" />
          {platformLabel(value)}
        </label>)}
        <button type="button" onClick={() => selectPlatforms([...pickPlatforms])} disabled={!platformsReady || selectedPlatforms.length === pickPlatforms.length} className="min-h-8 px-1 text-xs text-cyan-200 underline-offset-4 hover:underline disabled:cursor-default disabled:text-slate-500 disabled:no-underline">全選</button>
        {platformMessage && <span role="status" className="text-xs text-amber-200">{platformMessage}</span>}
      </div>
      <div className="mt-3 flex gap-2 overflow-x-auto">{(Object.keys(routeLabels) as Route[]).map(value => <button key={value} type="button" onClick={() => selectRoute(value)} className={`shrink-0 rounded-lg border px-3 py-1.5 text-sm font-bold transition ${route === value ? "border-amber-300 bg-amber-300/15 font-bold text-amber-100" : "border-slate-600 bg-slate-900/60 text-slate-400 hover:border-amber-300/50"}`}>{routeLabels[value]}</button>)}</div>
      <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border border-white/5 bg-black/20 px-3 py-2 text-xs text-slate-300"><strong className="text-amber-100">{routeLabels[route]}</strong><span>{routeDescriptions[route]}</span><span className="rounded bg-slate-800 px-1.5 py-0.5 text-cyan-100">{selectedPlatforms.map(platformLabel).join('／')} · 依「{sortLabels[sortMode]}」顯示前 6 名</span></div>
    </header>
    {picks.length ? <div className={`grid gap-3 p-3 ${cardGridColumns[cardsPerRow]}`}>
      {picks.map(pick => {
        const scope = `curated:${route}:${pick.platform}:${pick.table.id}:${pick.combination.cardMode}:${pick.combination.betting}:${pick.combination.action}`;
        const liveTable = findLivePickTable(tablesByPlatform, pick.platform, pick.table.id);
        const metric = route === 'watch' ? pick.combination.recent10Ledger : route === 'hot' ? pick.combination.recentLedger : pick.combination.ledger;
        const winRate = metric.bets ? metric.wins / metric.bets * 100 : 0;
        const roi = metric.totalStake ? metric.profit / metric.totalStake * 100 : 0;
        const recent10 = pick.combination.recent10Ledger;
        const confidence = pick.combination.ledger.bets >= 30 ? '高' : pick.combination.ledger.bets >= 20 ? '中' : pick.combination.ledger.bets >= 10 ? '觀察中' : '資料累積中';
        const rankBadge = rankBadges.scope === rankingScope ? rankBadges.entries[pick.key] : undefined;
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
          {liveTable
            ? <BaccaratTableCard key={scope} table={liveTable} connected={connectedByPlatform[pick.platform]} platformLabel={pick.sourceLabel} onFocusTable={onFocusTable} storageScope={scope} />
            : <div role="status" className="p-4 text-sm text-slate-400">{pick.sourceLabel} · {pick.table.name || pick.table.id}：等待最新桌況，暫停顯示預測。</div>}
        </div>;
      })}
    </div> : <div className="grid min-h-56 place-items-center p-6 text-center text-sm text-slate-400">{platformsReady ? `所選平台（${selectedPlatforms.map(platformLabel).join('／')}）目前沒有符合「${routeLabels[route]}」條件的正收益組合` : '正在載入平台設定…'}</div>}
  </section>;
}
