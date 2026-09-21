'use client';
import { beadWinners, weightedConsensus } from '@/lib/statistical-cards';

export function WeightedConsensusCard({ beadPlate }: { beadPlate: string }) {
  const consensus = weightedConsensus(beadWinners(beadPlate));
  const answerColor = consensus.answer === '莊' ? 'text-red-400' : consensus.answer === '閒' ? 'text-blue-400' : 'text-slate-300';
  return <section aria-label="近局加權共識牌卡" className="grid h-full min-h-0 grid-rows-[auto_minmax(0,1fr)_auto] gap-2 overflow-hidden bg-slate-950 p-2 text-white">
    <div className="text-right text-xs">下局參考：<strong className={answerColor}>{consensus.answer}</strong></div>
    <div className="grid min-h-0 grid-cols-3 gap-2">
      {consensus.windows.map(window => <div key={window.size} className="flex min-w-0 flex-col items-center justify-center gap-1 rounded border border-slate-600 bg-slate-900 px-1 text-xs">
        <strong className="text-cyan-100">{window.size} 局</strong>
        <div className="flex gap-2 font-mono font-bold tabular-nums"><span className="text-red-400" title="莊加權分數">{window.banker.toFixed(2)}</span><span className="text-blue-400" title="閒加權分數">{window.player.toFixed(2)}</span></div>
        <strong className={window.answer === '莊' ? 'text-red-400' : window.answer === '閒' ? 'text-blue-400' : 'text-slate-300'}>{window.answer}</strong>
        <span className="text-[10px] text-white">可比對 {window.sample} 局</span>
      </div>)}
    </div>
    <div className="border-t border-slate-700 pt-1 text-[10px] text-white">18／24／36 局中，至少兩組同向才形成共識；資料不足或意見分歧時顯示無訊號。</div>
  </section>;
}
