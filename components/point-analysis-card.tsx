'use client';

import { useMemo } from 'react';
import { pointCounts, recentPointResults } from '@/lib/point-analysis';
import { winningPointSignal } from '@/lib/statistical-cards';

export function PointAnalysisCard({ bigRoad, distributionOnly = false }: { bigRoad: string; distributionOnly?: boolean }) {
  const results = useMemo(() => recentPointResults(bigRoad), [bigRoad]);
  const banker = pointCounts(results, '2');
  const player = pointCounts(results, '1');
  const max = Math.max(1, ...banker, ...player);
  const signal = winningPointSignal(results);
  return <section className="grid h-full min-h-0 grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden bg-slate-950 p-2 text-white" aria-label={distributionOnly ? '數值分布牌卡' : '勝方點數分布牌卡'}>
    <div className="flex items-center justify-between gap-2 text-xs font-semibold text-cyan-100"><span>近 {results.length} 筆勝方點數</span>{!distributionOnly && <span>下局參考：<strong className={signal.answer === '莊' ? 'text-red-400' : signal.answer === '閒' ? 'text-blue-400' : 'text-slate-300'}>{signal.answer}</strong></span>}</div>
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
      {distributionOnly ? '僅顯示已開出的勝方點數分布，不提供下局預測。' : <div>
        至少 10 筆勝方點數才提供下局參考；目前 {results.length} 筆{results.length < 10 ? '，因此顯示無訊號。' : '。'}
      </div>}
    </div>
  </section>;
}
