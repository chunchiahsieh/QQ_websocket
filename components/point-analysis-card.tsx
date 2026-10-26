'use client';

import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { pointCounts, recentPointResults } from '@/lib/point-analysis';
import { beadWinners, winningPointSignal, type Side } from '@/lib/statistical-cards';
import { evaluatePredictions } from '@/lib/prediction-performance';
import type { PredictionDecision } from '@/lib/prediction-performance';
import { chronologicalAiRoad } from '@/lib/ai-road-history';
import { advanceObservedAi, aiObservationSnapshot, type ObservedAiLedger } from '@/lib/ai-observed-predictions';
import { useAiObservationSession } from '@/components/ai-observation-provider';

function createMountedPointLedger() {
  let value: ObservedAiLedger | undefined;
  const listeners = new Set<() => void>();
  return {
    read: () => value,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    commit: (next: ObservedAiLedger) => {
      if (value === next) return;
      value = next;
      listeners.forEach(listener => listener());
    },
  };
}

function pointCardData(bigRoad: string, beadPlate: string, fullOutcomes?: readonly Side[], completedRounds?: number) {
  const winners = beadWinners(beadPlate);
  // A complete bead history can disambiguate touching dragon tails. A clipped
  // bead window must instead be aligned with the full road's chronological tail.
  const marks = fullOutcomes !== undefined ? chronologicalAiRoad(bigRoad, fullOutcomes)
    : chronologicalAiRoad(bigRoad, winners) ?? chronologicalAiRoad(bigRoad);
  const nonTies = winners.filter(side => side !== '3');
  const offset = (marks?.length ?? 0) - nonTies.length;
  const fullHistoryMatches = fullOutcomes === undefined || (winners.length <= fullOutcomes.length
    && (winners.length === fullOutcomes.length || winners.length === 36)
    && winners.every((side, index) => fullOutcomes[fullOutcomes.length - winners.length + index] === side));
  const completeOrFixedWindow = offset === 0 || winners.length === 36;
  const counterMatches = completedRounds === undefined || (Number.isSafeInteger(completedRounds) && completedRounds >= 0
    && (fullOutcomes === undefined || completedRounds === fullOutcomes.length));
  if (!marks || !counterMatches || !fullHistoryMatches || !completeOrFixedWindow || offset < 0 || (marks.length > 0 && winners.length === 0)
    || nonTies.some((side, index) => marks[offset + index].code[3] !== side)) {
    return { results: recentPointResults(bigRoad), signal: winningPointSignal([]),
      performance: evaluatePredictions([], () => undefined, () => '1'), snapshot: undefined };
  }
  // Keep unknown point digits in their round positions, but omit them from the
  // point observations. Live and historical signals both use the last 36 known points.
  const pointHistory = marks.map(mark => recentPointResults(mark.code));
  const recentPoints = (end: number) => pointHistory.slice(0, end).flat().slice(-36);
  const results = recentPoints(marks.length);
  const performance = evaluatePredictions(winners, history => {
    const pointCount = offset + history.filter(side => side !== '3').length;
    const answer = winningPointSignal(recentPoints(pointCount)).answer;
    return answer === '莊' ? '2' : answer === '閒' ? '1' : undefined;
  }, side => side);
  const total = fullOutcomes?.length ?? completedRounds ?? (offset === 0 ? winners.length : undefined);
  const snapshot = total === undefined ? undefined : aiObservationSnapshot(beadPlate, total, false, marks.length,
    { fullOutcomes: fullOutcomes ? [...fullOutcomes] : undefined, road: bigRoad, tailWindow: 36 });
  return { results, signal: winningPointSignal(results), performance, snapshot };
}

export function PointAnalysisCard({ bigRoad, beadPlate, fullOutcomes, tableId, shoe, completedRounds, distributionOnly = false, onPredictionChange }: { bigRoad: string; beadPlate: string; fullOutcomes?: readonly Side[]; tableId: string; shoe: string; completedRounds?: number; distributionOnly?: boolean; onPredictionChange?: (side: '1' | '2' | undefined, history: PredictionDecision[]) => void }) {
  const data = useMemo(() => pointCardData(bigRoad, beadPlate, fullOutcomes, completedRounds), [bigRoad, beadPlate, fullOutcomes, completedRounds]);
  const results = distributionOnly ? recentPointResults(bigRoad) : data.results;
  const banker = pointCounts(results, '2');
  const player = pointCounts(results, '1');
  const max = Math.max(1, ...banker, ...player);
  const observationSession = useAiObservationSession(tableId);
  const storageKey = JSON.stringify([tableId, shoe, observationSession]);
  const [ledgerStore] = useState(createMountedPointLedger);
  const savedLedger = useSyncExternalStore(ledgerStore.subscribe, ledgerStore.read, ledgerStore.read);
  const candidate = data.signal.answer === '莊' ? '2' as const : data.signal.answer === '閒' ? '1' as const : undefined;
  const ledger = useMemo(() => data.snapshot && !distributionOnly
    ? advanceObservedAi(savedLedger, storageKey, data.snapshot,
      { side: candidate, votes: [], active: candidate ? 1 : 0, required: 1 }) : savedLedger,
  [candidate, data.snapshot, distributionOnly, savedLedger, storageKey]);
  // Commit the pending direction that was actually displayed; later point
  // corrections must not rewrite it or the decisions settled from it.
  useEffect(() => { if (!distributionOnly && ledger) ledgerStore.commit(ledger); }, [distributionOnly, ledger, ledgerStore]);
  const synchronized = Boolean(data.snapshot && ledger?.key === storageKey
    && ledger.snapshot.total === data.snapshot.total && ledger.snapshot.road === data.snapshot.road
    && ledger.snapshot.outcomes.join('') === data.snapshot.outcomes.join(''));
  const prediction = distributionOnly || !synchronized ? undefined : ledger?.pending?.prediction;
  const answer = prediction === '2' ? '莊' : prediction === '1' ? '閒' : '無訊號';
  const performance = useMemo(() => {
    if (!synchronized || !data.snapshot) return evaluatePredictions([], () => undefined, () => '1');
    const firstPosition = data.snapshot.total - data.performance.decisions.length + 1;
    const decisions = data.performance.decisions.map((decision, index) => {
      const observed = ledger?.decisions.find(record => record.position === firstPosition + index && record.outcome === decision.outcome);
      return observed ? { ...decision, prediction: observed.prediction } : decision;
    });
    return evaluatePredictions(decisions, history => decisions[history.length].prediction, decision => decision.outcome);
  }, [data.performance.decisions, data.snapshot, ledger, synchronized]);
  useEffect(() => { onPredictionChange?.(prediction, performance.decisions); }, [onPredictionChange, performance.decisions, prediction]);
  return <section className="grid h-full min-h-0 grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden bg-slate-950 p-2 text-white" aria-label={distributionOnly ? '數值分布牌卡' : '勝方點數分布牌卡'}>
    <div className="flex items-center justify-between gap-2 text-xs font-semibold text-cyan-100"><span>{distributionOnly ? `數值分布 · 近 ${results.length} 筆` : `勝方點數分布 · 近 ${results.length} 筆`}</span></div>
    <div className="grid min-h-0 grid-cols-10 gap-1 py-2">
      {Array.from({ length: 10 }, (_, points) => <div key={points} className="flex min-w-0 flex-col items-center justify-end gap-0.5 text-[10px]">
        <span className="text-blue-300">閒 {player[points]}</span>
        <div className="w-full max-w-5 rounded-t bg-blue-500" style={{ height: `${Math.max(2, player[points] / max * 45)}%` }} />
        <div className="w-full max-w-5 rounded-t bg-red-500" style={{ height: `${Math.max(2, banker[points] / max * 45)}%` }} />
        <span className="text-red-300">莊 {banker[points]}</span>
        <strong>{points}</strong>
      </div>)}
    </div>
    <div className="border-t border-slate-700 pt-1 text-xs font-medium text-white">
      {distributionOnly ? '莊閒勝方點數合併統計；只看分布，不產生訊號。' : <div className="flex flex-wrap items-center gap-x-3">
        <span>下局預測：<strong className={answer === '莊' ? 'text-red-400' : answer === '閒' ? 'text-blue-400' : 'text-slate-300'}>{answer}</strong>{answer === '無訊號' && <em className="ml-1 not-italic text-amber-200">（本局不出手）</em>}</span>
        <span>上次預測：<strong className={performance.lastResult === '命中' ? 'text-emerald-300' : performance.lastResult === '錯誤' ? 'text-orange-300' : 'text-slate-300'}>{performance.lastResult}</strong></span>
        <span>目前連中：<strong className="text-emerald-300">{performance.streak}</strong>（最高 {performance.maxStreak}）</span>
        <span>目前連錯：<strong className="text-orange-300">{performance.missStreak}</strong>（最高 {performance.maxMissStreak}）</span>
      </div>}
    </div>
  </section>;
}
