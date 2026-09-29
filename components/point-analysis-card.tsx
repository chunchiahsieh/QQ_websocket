'use client';

import { useMemo } from 'react';
import { pointCounts, recentPointResults } from '@/lib/point-analysis';
import { winningPointSignal } from '@/lib/statistical-cards';
import { beadWinners } from '@/lib/statistical-cards';
import { evaluatePredictions } from '@/lib/prediction-performance';

export function PointAnalysisCard({ bigRoad, beadPlate, distributionOnly = false }: { bigRoad: string; beadPlate: string; distributionOnly?: boolean }) {
  const results = useMemo(() => recentPointResults(bigRoad), [bigRoad]);
  const allResults = useMemo(() => recentPointResults(bigRoad, Number.MAX_SAFE_INTEGER), [bigRoad]);
  const allWinners = useMemo(() => beadWinners(beadPlate), [beadPlate]);
  const banker = pointCounts(results, '2');
  const player = pointCounts(results, '1');
  const max = Math.max(1, ...banker, ...player);
  const signal = winningPointSignal(results);
  const performance = useMemo(() => evaluatePredictions(allWinners, history => {
    const pointCount = history.filter(side => side !== '3').length;
    const answer = winningPointSignal(allResults.slice(0, pointCount)).answer;
    return answer === '莊' ? '2' : answer === '閒' ? '1' : undefined;
  }, side => side), [allResults, allWinners]);
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
        <span>下局預測：<strong className={signal.answer === '莊' ? 'text-red-400' : signal.answer === '閒' ? 'text-blue-400' : 'text-slate-300'}>{signal.answer}</strong></span>
        <span>上一局：<strong className={performance.lastResult === '命中' ? 'text-emerald-300' : performance.lastResult === '錯誤' ? 'text-orange-300' : 'text-slate-300'}>{performance.lastResult}</strong></span>
        <span>目前連中：<strong className="text-emerald-300">{performance.streak}</strong>（最高 {performance.maxStreak}）</span>
        <span>目前連錯：<strong className="text-orange-300">{performance.missStreak}</strong>（最高 {performance.maxMissStreak}）</span>
      </div>}
    </div>
  </section>;
}
