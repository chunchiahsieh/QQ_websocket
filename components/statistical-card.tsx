'use client';
import { useState } from 'react';
import { beadWinners, weightedSignal } from '@/lib/statistical-cards';

export function StatisticalCard({ beadPlate }: { beadPlate: string }) {
  const [windowSize, setWindowSize] = useState<18 | 24 | 36>(36);
  const winners = beadWinners(beadPlate).slice(-windowSize);
  const signal = weightedSignal(winners, windowSize);
  const color = signal.answer === '莊' ? 'text-red-400' : signal.answer === '閒' ? 'text-blue-400' : 'text-slate-300';
  return <section aria-label="近局加權牌卡" className="grid h-full min-h-0 grid-rows-[auto_minmax(0,1fr)_auto] gap-1 overflow-hidden bg-slate-950 p-2 text-white">
    <div className="flex items-center justify-between gap-2 whitespace-nowrap text-xs">
      <span className="inline-flex gap-3 font-bold tabular-nums" aria-label="莊閒加權分數">
        <span className="text-red-400" title="莊加權分數" aria-label={`莊加權分數 ${signal.banker.toFixed(2)}`}>{signal.banker.toFixed(2)}</span>
        <span className="text-blue-400" title="閒加權分數" aria-label={`閒加權分數 ${signal.player.toFixed(2)}`}>{signal.player.toFixed(2)}</span>
      </span>
      <select value={windowSize} onChange={event => setWindowSize(Number(event.target.value) as 18 | 24 | 36)}
        aria-label="近局加權局數" className="rounded border border-slate-600 bg-slate-800 px-1 py-0.5 text-xs text-white">
        <option value={18}>18 局</option><option value={24}>24 局</option><option value={36}>36 局</option>
      </select>
      <span>下局參考：<strong className={color}>{signal.answer}</strong></span>
    </div>
    <div className="min-h-0 overflow-hidden rounded border border-slate-300 bg-slate-50">
      <table className="h-full w-full table-fixed border-collapse text-center font-mono text-xs font-semibold tabular-nums" aria-label={`最近 ${windowSize} 局逐局加權數值，紅字莊、藍字閒、綠字和，由左上到右下依時間排列`}>
        <tbody>{Array.from({ length: windowSize / 6 }, (_, row) => <tr key={row}>{Array.from({ length: 6 }, (_, col) => {
          const index = row * 6 + col;
          const side = winners[index];
          const weight = side === '3' ? 0 : Math.pow(0.94, winners.length - 1 - index);
          return <td key={col} className={`border border-slate-200 ${side === '2' ? 'text-red-600' : side === '1' ? 'text-blue-600' : side === '3' ? 'text-emerald-600' : 'text-slate-400'}`}
            title={side === '2' ? `莊：${weight.toFixed(2)}` : side === '1' ? `閒：${weight.toFixed(2)}` : side === '3' ? '和局：不計分' : undefined}>
            {side ? weight.toFixed(2) : ''}
          </td>;
        })}</tr>)}</tbody>
      </table>
    </div>
    <div className="flex items-center justify-between gap-2 border-t border-slate-700 pt-1 text-[10px] text-white">
      <span>{signal.reason}</span>
      <span className="shrink-0">可比對 {signal.sample} 局</span>
    </div>
  </section>;
}
