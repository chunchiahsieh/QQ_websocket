'use client';

import { useEffect, useState } from 'react';
import { BaccaratRoad } from '@/components/baccarat-road';
import { beadWinners } from '@/lib/statistical-cards';
import { followRoad, markovRoad, reverseRoad, sequenceRoad, streakRoad, type RoadSide } from '@/lib/road-strategies';
import type { CardMode } from '@/components/card-picker';

const sideName = (side?: RoadSide) => side === '2' ? '莊' : side === '1' ? '閒' : '無訊號';
type RoadView = 'bead' | 'big' | 'eye' | 'small' | 'cockroach';
type Roads = Record<RoadView, string>;

export function RoadStrategyCard({ mode, platform, tableId, roads }: {
  mode: CardMode; platform: 'MT' | 'DG' | 'AB'; tableId: string; roads: Roads;
}) {
  const [history, setHistory] = useState<RoadSide[]>([]);
  const [historyReady, setHistoryReady] = useState(false);
  const [order, setOrder] = useState(3);
  const [streakLength, setStreakLength] = useState(3);
  const [continuation, setContinuation] = useState(true);
  const [roadView, setRoadView] = useState<RoadView>('big');

  useEffect(() => {
    let active = true;
    setHistory([]); setHistoryReady(false);
    const load = async () => {
      try {
        const response = await fetch(`/api/road-history/${platform}?tableId=${encodeURIComponent(tableId)}`, { cache: 'no-store' });
        if (!response.ok) throw new Error('history unavailable');
        const data = await response.json() as { outcomes?: { winner: RoadSide }[] };
        if (!active) return;
        setHistory((data.outcomes ?? []).map(round => round.winner).filter(side => side === '1' || side === '2' || side === '3'));
        setHistoryReady(true);
      } catch { if (active) setHistoryReady(false); }
    };
    void load();
    const timer = window.setInterval(() => void load(), 10_000);
    return () => { active = false; window.clearInterval(timer); };
  }, [platform, tableId]);

  const rounds = historyReady && history.length ? history : beadWinners(roads.bead);
  const signal = mode === 'road-follow' ? followRoad(rounds)
    : mode === 'road-reverse' ? reverseRoad(rounds)
    : mode === 'road-streak' ? streakRoad(rounds, streakLength, continuation)
    : mode === 'road-sequence' ? sequenceRoad(rounds, order)
    : markovRoad(rounds, order);
  const label = mode === 'road-follow' ? '跟路策略牌卡' : mode === 'road-reverse' ? '反路策略牌卡'
    : mode === 'road-streak' ? '連莊／連閒策略牌卡' : mode === 'road-sequence' ? '序列比對牌卡' : '馬可夫轉移牌卡';
  const answer = sideName(signal.side);
  const total = signal.banker + signal.player;
  const bankerPercent = signal.bankerProbability !== undefined ? Math.round(signal.bankerProbability * 100) : total ? Math.round(signal.banker / total * 100) : 0;
  const playerPercent = total ? 100 - bankerPercent : 0;
  const recent = [...rounds].reverse().find(side => side !== '3');
  return <section aria-label={label} className="grid h-full min-h-0 grid-rows-[auto_minmax(0,1fr)_auto] gap-1 overflow-hidden bg-slate-950 p-1.5 text-white">
    <div className="flex min-w-0 items-center justify-between gap-2 text-[11px] font-semibold">
      <strong className="truncate text-cyan-100">{label}</strong>
      <div className="flex shrink-0 items-center gap-1">
        <select aria-label="牌卡路單顯示方式" value={roadView} onChange={event => setRoadView(event.target.value as RoadView)} className="rounded border border-cyan-700 bg-cyan-950 px-1 py-0.5 text-cyan-100"><option value="bead">202 珠盤</option><option value="big">203 大路</option><option value="eye">204 大眼</option><option value="small">205 小路</option><option value="cockroach">206 蟑螂</option></select>
        {mode === 'road-streak' && <><select aria-label="連續局數" value={streakLength} onChange={event => setStreakLength(Number(event.target.value))} className="rounded border border-slate-600 bg-slate-800 px-1 py-0.5">{[2, 3, 4, 5].map(n => <option key={n} value={n}>{n} 局</option>)}</select><select aria-label="延續或中斷" value={continuation ? 'continue' : 'break'} onChange={event => setContinuation(event.target.value === 'continue')} className="rounded border border-slate-600 bg-slate-800 px-1 py-0.5"><option value="continue">延續</option><option value="break">中斷</option></select></>}
        {(mode === 'road-sequence' || mode === 'road-markov') && <select aria-label="比對局數" value={order} onChange={event => setOrder(Number(event.target.value))} className="rounded border border-slate-600 bg-slate-800 px-1 py-0.5">{[1, 2, 3, 4].map(n => <option key={n} value={n}>近 {n} 局</option>)}</select>}
        <span className="whitespace-nowrap">下局預測：<strong className={signal.side === '2' ? 'text-red-400' : signal.side === '1' ? 'text-blue-400' : 'text-slate-300'}>{answer}</strong></span>
      </div>
    </div>
    <div className="grid min-h-0 grid-cols-[minmax(0,1fr)_34%] gap-1">
      <div className="min-h-0 overflow-hidden rounded border border-slate-300 bg-white" aria-label="目前路單"><BaccaratRoad raw={roads[roadView]} kind={roadView} columnLimit={roadView === 'bead' ? 9 : 12} /></div>
      <div className="flex min-h-0 flex-col justify-center gap-1 overflow-hidden rounded border border-slate-700 bg-slate-900 px-2 text-[10px] leading-tight">
        {mode === 'road-follow' || mode === 'road-reverse' ? <><span className="text-slate-300">最近非和局</span><strong className={recent === '2' ? 'text-red-400' : recent === '1' ? 'text-blue-400' : 'text-slate-300'}>{sideName(recent)}</strong><span>{mode === 'road-follow' ? '預測延續同方向' : '預測轉向另一方'}</span></> : null}
        {mode === 'road-streak' ? <><span className="text-slate-300">設定條件</span><strong>連續 {streakLength} 局 · {continuation ? '延續' : '中斷'}</strong><span>未達條件：無訊號</span></> : null}
        {mode === 'road-sequence' || mode === 'road-markov' ? <>
          <strong className="text-white">{mode === 'road-sequence' ? '找歷史相同排列後的結果' : '轉移機率'}</strong>
          <span className="text-slate-300">{mode === 'road-sequence' ? '目前序列' : '目前狀態'}：{signal.context || '資料不足'}</span>
          <div className="flex gap-2 font-semibold"><span className="text-red-400">莊 {signal.banker}{mode === 'road-markov' ? ` · ${bankerPercent}%` : ''}</span><span className="text-blue-400">閒 {signal.player}{mode === 'road-markov' ? ` · ${playerPercent}%` : ''}</span></div>
          <div className="flex h-1.5 overflow-hidden rounded bg-slate-700"><span className="bg-red-500" style={{ width: `${bankerPercent}%` }} /><span className="bg-blue-500" style={{ width: `${playerPercent}%` }} /></div>
          <span>{mode === 'road-sequence' ? `相同排列 ${signal.sample} 筆／至少 5 筆` : signal.usedOrder ? `樣本 ${signal.sample} 筆 · 依近 ${signal.usedOrder} 局` : '樣本不足（需 10 筆）'}</span>
        </> : null}
      </div>
    </div>
    <div className="truncate border-t border-slate-700 pt-0.5 text-[10px] text-white" title={signal.reason}>{signal.reason} {historyReady ? `本靴累計 ${history.length} 局` : `目前桌面 ${rounds.length} 局`}</div>
  </section>;
}
