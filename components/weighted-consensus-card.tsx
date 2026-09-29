'use client';
import { useEffect } from 'react';
import { beadWinners, weightedConsensus } from '@/lib/statistical-cards';
import { evaluatePredictions } from '@/lib/prediction-performance';
import type { PredictionDecision } from '@/lib/prediction-performance';

export function WeightedConsensusCard({ beadPlate, onPredictionChange }: { beadPlate: string; onPredictionChange?: (side: '1' | '2' | undefined, history: PredictionDecision[]) => void }) {
  const winners = beadWinners(beadPlate);
  const consensus = weightedConsensus(winners);
  const prediction = consensus.answer === '莊' ? '2' as const : consensus.answer === '閒' ? '1' as const : undefined;
  const performance = evaluatePredictions(winners, history => {
    const answer = weightedConsensus(history).answer;
    return answer === '莊' ? '2' : answer === '閒' ? '1' : undefined;
  }, side => side);
  useEffect(() => { onPredictionChange?.(prediction, performance.decisions); }, [onPredictionChange, performance.decisions, prediction]);
  const answerColor = consensus.answer === '莊' ? 'text-red-400' : consensus.answer === '閒' ? 'text-blue-400' : 'text-slate-300';
  return <section aria-label="近局加權共識牌卡" className="grid h-full min-h-0 grid-rows-[auto_minmax(0,1fr)_auto] gap-2 overflow-hidden bg-slate-950 p-2 text-white">
    <div className="text-right text-xs text-cyan-100">18／24／36 局共識</div>
    <div className="grid min-h-0 grid-cols-3 gap-2">
      {consensus.windows.map(window => <div key={window.size} className="flex min-w-0 flex-col items-center justify-center gap-1 rounded border border-slate-600 bg-slate-900 px-1 text-xs">
        <strong className="text-cyan-100">{window.size} 局</strong>
        <div className="flex gap-2 font-mono font-bold tabular-nums"><span className="text-red-400" title="莊加權分數">{window.banker.toFixed(2)}</span><span className="text-blue-400" title="閒加權分數">{window.player.toFixed(2)}</span></div>
        <strong className={window.answer === '莊' ? 'text-red-400' : window.answer === '閒' ? 'text-blue-400' : 'text-slate-300'}>{window.answer}</strong>
        <span className="text-[10px] text-white">可比對 {window.sample} 局</span>
      </div>)}
    </div>
    <div className="flex flex-wrap items-center gap-x-3 border-t border-slate-700 pt-1 text-[10px] text-white"><span>下局預測：<strong className={answerColor}>{consensus.answer}</strong></span><span>上一局：<strong className={performance.lastResult === '命中' ? 'text-emerald-300' : performance.lastResult === '錯誤' ? 'text-orange-300' : 'text-slate-300'}>{performance.lastResult}</strong></span><span>目前連中：<strong className="text-emerald-300">{performance.streak}</strong>（最高 {performance.maxStreak}）</span><span>目前連錯：<strong className="text-orange-300">{performance.missStreak}</strong>（最高 {performance.maxMissStreak}）</span></div>
  </section>;
}
