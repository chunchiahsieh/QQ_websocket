'use client';

import { useMemo } from 'react';
import { pointCounts, recentPointResults } from '@/lib/point-analysis';
import { winningPointSignal } from '@/lib/statistical-cards';

export function PointAnalysisCard({ bigRoad, distributionOnly = false }: { bigRoad: string; distributionOnly?: boolean }) {
  const results = useMemo(() => recentPointResults(bigRoad), [bigRoad]);
  const banker = pointCounts(results, '2');
  const player = pointCounts(results, '1');
  const combined = banker.map((count, points) => count + player[points]);
  const max = Math.max(1, ...(distributionOnly ? combined : [...banker, ...player]));
  const signal = winningPointSignal(results);
  return <section className={`grid h-full min-h-0 grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden p-2 text-white ${distributionOnly ? 'bg-[#10232d]' : 'bg-slate-950'}`} aria-label={distributionOnly ? '數值分布牌卡' : '勝方點數分布牌卡'}>
    <div className="flex items-center justify-between gap-2 text-xs font-semibold text-cyan-100"><span>{distributionOnly ? `數值分布 · 近 ${results.length} 筆` : `勝方點數分布 · 近 ${results.length} 筆`}</span>{!distributionOnly && <span>下局參考：<strong className={signal.answer === '莊' ? 'text-red-400' : signal.answer === '閒' ? 'text-blue-400' : 'text-slate-300'}>{signal.answer}</strong></span>}</div>
    <div className="grid min-h-0 grid-cols-10 gap-1 py-2">
      {Array.from({ length: 10 }, (_, points) => <div key={points} className="flex min-w-0 flex-col items-center justify-end gap-0.5 text-[10px]">
        {distributionOnly ? <>
          <strong className="text-cyan-200">{combined[points]}</strong>
          <div className="w-full max-w-6 rounded-t bg-cyan-400" style={{ height: `${combined[points] ? Math.max(3, combined[points] / max * 70) : 0}%` }} />
        </> : <>
          <span className="text-blue-300">閒 {player[points]}</span>
          <div className="w-full max-w-5 rounded-t bg-blue-500" style={{ height: `${Math.max(2, player[points] / max * 45)}%` }} />
          <div className="w-full max-w-5 rounded-t bg-red-500" style={{ height: `${Math.max(2, banker[points] / max * 45)}%` }} />
          <span className="text-red-300">莊 {banker[points]}</span>
        </>}
        <strong>{points}</strong>
      </div>)}
    </div>
    <div className="border-t border-slate-700 pt-1 text-xs font-medium text-white">
      {distributionOnly ? '莊閒勝方點數合併統計；只看分布，不產生訊號。' : <div>
        至少 10 筆勝方點數才提供下局參考；目前 {results.length} 筆{results.length < 10 ? '，因此顯示無訊號。' : '。'}
      </div>}
    </div>
  </section>;
}
