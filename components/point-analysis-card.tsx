'use client';

import { useMemo } from 'react';
import { pointCounts, recentPointResults } from '@/lib/point-analysis';

export function PointAnalysisCard({ bigRoad }: { bigRoad: string }) {
  const results = useMemo(() => recentPointResults(bigRoad), [bigRoad]);
  const banker = pointCounts(results, '2');
  const player = pointCounts(results, '1');
  const max = Math.max(1, ...banker, ...player);
  return <section className="grid h-full min-h-0 grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden bg-slate-950 p-2 text-white" aria-label="點數分析牌卡">
    <div className="text-xs font-semibold text-cyan-100">近 {results.length} 筆大路點數分布</div>
    <div className="grid min-h-0 grid-cols-10 gap-1 py-2">
      {Array.from({ length: 10 }, (_, points) => <div key={points} className="flex min-w-0 flex-col items-center justify-end gap-0.5 text-[10px]">
        <span className="text-blue-300">閒 {player[points]}</span>
        <div className="w-full max-w-5 rounded-t bg-blue-500" style={{ height: `${Math.max(2, player[points] / max * 45)}%` }} />
        <div className="w-full max-w-5 rounded-t bg-red-500" style={{ height: `${Math.max(2, banker[points] / max * 45)}%` }} />
        <span className="text-red-300">莊 {banker[points]}</span>
        <strong>{points}</strong>
      </div>)}
    </div>
    <div className="border-t border-slate-700 pt-1 text-[10px] text-slate-300">
      {results.length ? '僅統計大路已記錄的勝方點數；不含和局，不能推算另一方點數。' : '目前沒有可驗證的點數資料。'}
    </div>
  </section>;
}
