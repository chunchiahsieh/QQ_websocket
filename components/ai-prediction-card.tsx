'use client';

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { BaccaratRoad, type RoadMarker } from '@/components/baccarat-road';
import { aiConsensus, aiSources, type AiSource } from '@/lib/ai-consensus';
import { predictionPerformance } from '@/lib/ai-prediction-performance';
import { appendAiPrediction } from '@/lib/ai-road-history';
import { advanceObservedAi, aiObservationIdentity, aiObservationSnapshot, restoreObservedAi, type ObservedAiLedger } from '@/lib/ai-observed-predictions';
import { summarizeAiShoe } from '@/lib/ai-shoe-performance';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import type { PredictionDecision } from '@/lib/prediction-performance';
import { useAiObservationSession } from '@/components/ai-observation-provider';
export { predictionPerformance } from '@/lib/ai-prediction-performance';

const sourceLabels: Record<AiSource, string> = {
  chartgpt: 'ChartGPT', gemini: 'Google Gemini', deepseek: 'DeepSeek', claude: 'Claude',
};
const sourceAbbreviations: Record<AiSource, string> = {
  chartgpt: 'GPT', gemini: 'GM', deepseek: 'DS', claude: 'CL',
};

type SavedLedger = { ledger?: ObservedAiLedger };
const savedLedgers = new Map<string, SavedLedger>();
const ledgerListeners = new Map<string, Set<() => void>>();
let observationMountSequence = 0;
function readSavedLedger(key: string, persistent: boolean): SavedLedger {
  let saved = savedLedgers.get(key);
  if (!saved) {
    let ledger: ObservedAiLedger | undefined;
    try { if (persistent) ledger = restoreObservedAi(window.localStorage.getItem(key), key); } catch { /* Recording remains available in memory. */ }
    saved = { ledger };
    savedLedgers.set(key, saved);
  }
  return saved;
}
function subscribeToLedger(key: string, listener: () => void) {
  const listeners = ledgerListeners.get(key) ?? new Set<() => void>();
  listeners.add(listener);
  ledgerListeners.set(key, listeners);
  return () => { listeners.delete(listener); };
}
function commitLedger(key: string, ledger: ObservedAiLedger, persistent: boolean) {
  if (savedLedgers.get(key)?.ledger === ledger) return;
  savedLedgers.set(key, { ledger });
  try { if (persistent) window.localStorage.setItem(key, JSON.stringify(ledger)); } catch { /* Keep the observed ledger in memory. */ }
  ledgerListeners.get(key)?.forEach(listener => listener());
}
const serverLedger = () => undefined;

function outcomeLabel(outcome?: string) {
  return outcome === '1' ? '閒' : outcome === '2' ? '莊' : '無訊號';
}

function RoadGrid({ raw, prediction, outcomes, surfaceColor, source }: { raw: string; prediction?: '1' | '2'; outcomes?: readonly ('1' | '2' | '3')[]; surfaceColor: string; source?: AiSource }) {
  const appended = appendAiPrediction(raw, prediction, outcomes);
  const marker: RoadMarker | undefined = prediction ? {
    text: source ? sourceAbbreviations[source] : '共',
    color: prediction === '2' ? '#ef3535' : '#2864e8',
    label: `${source ? sourceLabels[source] : '共識'}訊號${outcomeLabel(prediction)}`,
    position: appended.position,
  } : undefined;
  return <div className="ai-road-grid min-h-0 min-w-0 overflow-hidden">
    <BaccaratRoad raw={appended.raw} kind="big" columnLimit={10} surfaceColor={surfaceColor} marker={appended.position ? marker : undefined} />
  </div>;
}

export function AiPredictionCard({ raw, beadPlate, fullOutcomes, tableId, shoe, completedRounds, completedNonTies, completedBankers, tableState, shuffling, initialSource, onPredictionChange }: { raw: string; beadPlate: string; fullOutcomes?: ('1' | '2' | '3')[]; tableId: string; shoe: string; completedRounds: number; completedNonTies: number; completedBankers: number; tableState?: string; shuffling?: boolean; initialSource?: AiSource; onPredictionChange?: (side: '1' | '2' | undefined, history: PredictionDecision[], agreement?: number) => void }) {
  const [selected, setSelected] = useState<AiSource[]>(initialSource ? [initialSource] : [...aiSources]);
  const [selectionNotice, setSelectionNotice] = useState(false);
  const [mountScope] = useState(() => String(++observationMountSequence));
  const observationSession = useAiObservationSession(tableId);
  const isShuffling = shuffling || tableState === '2';
  const consensus = useMemo(() => aiConsensus(raw, selected), [raw, selected]);
  const { key: storageKey, persistent } = aiObservationIdentity(tableId, shoe, initialSource ?? 'ai-consensus', selected, observationSession ?? mountScope);
  const snapshot = useMemo(() => aiObservationSnapshot(beadPlate, completedRounds, isShuffling, completedNonTies,
    { fullOutcomes, road: raw, bankerTotal: completedBankers }), [beadPlate, completedRounds, completedNonTies, completedBankers, isShuffling, fullOutcomes, raw]);
  const chronologicalOutcomes = fullOutcomes?.length === completedRounds ? fullOutcomes
    : snapshot?.outcomes.length === completedRounds ? snapshot.outcomes : undefined;
  const saved = useSyncExternalStore(
    useCallback(listener => subscribeToLedger(storageKey, listener), [storageKey]),
    useCallback(() => readSavedLedger(storageKey, persistent), [storageKey, persistent]),
    serverLedger,
  );
  const ledger = useMemo(() => saved && snapshot
    ? advanceObservedAi(saved.ledger, storageKey, snapshot, consensus) : saved?.ledger, [saved, storageKey, snapshot, consensus]);
  // Commit the same prediction the user just saw. Never reconstruct a live
  // decision from the current road after the next result has already arrived.
  useEffect(() => {
    if (!ledger) return;
    commitLedger(storageKey, ledger, persistent);
  }, [ledger, storageKey, persistent]);
  const synchronized = Boolean(snapshot && ledger && ledger.snapshot.total === snapshot.total
    && ledger.snapshot.outcomes.join('') === snapshot.outcomes.join(''));
  // Use all coherent shoe history even when the card is opened mid-shoe.
  // During a partial update keep the last coherent snapshot, never reset its maxima.
  const statisticsSnapshot = ledger?.snapshot ?? snapshot;
  const statisticsOutcomes = statisticsSnapshot?.outcomes.length === statisticsSnapshot?.total ? statisticsSnapshot?.outcomes : undefined;
  const statisticsRoad = statisticsSnapshot?.road;
  const simulated = useMemo(() => statisticsRoad !== undefined && statisticsOutcomes
    ? predictionPerformance(statisticsRoad, selected, statisticsOutcomes) : undefined, [statisticsRoad, selected, statisticsOutcomes]);
  const performance = useMemo(() => simulated && statisticsOutcomes
    ? summarizeAiShoe(simulated.decisions, statisticsOutcomes, ledger) : undefined, [simulated, statisticsOutcomes, ledger]);
  const decisionHistory = useMemo(() => performance?.decisions ?? [], [performance]);
  const sourcePerformance = useMemo(() => Object.fromEntries((initialSource ? [] : aiSources).map(source => [source,
    statisticsRoad !== undefined && statisticsOutcomes
      ? summarizeAiShoe(predictionPerformance(statisticsRoad, [source], statisticsOutcomes).decisions, statisticsOutcomes, ledger, source)
      : undefined,
  ])), [initialSource, statisticsRoad, statisticsOutcomes, ledger]);
  const prediction = isShuffling || !synchronized ? undefined : ledger?.pending?.prediction;
  const agreement = prediction ? ledger?.pending?.agreement ?? 0 : 0;
  useEffect(() => { onPredictionChange?.(prediction, decisionHistory, agreement); }, [agreement, onPredictionChange, decisionHistory, prediction]);
  const toggle = (source: AiSource) => setSelected(current => {
    if (current.includes(source) && current.length === 1) {
      setSelectionNotice(true);
      return current;
    }
    return current.includes(source)
      ? current.filter(item => item !== source)
      : aiSources.filter(item => item === source || current.includes(item));
  });

  return <section className={`ai-prediction-card grid h-full min-h-0 ${initialSource ? 'grid-rows-[minmax(0,1fr)_auto]' : 'grid-rows-[auto_minmax(0,1fr)_auto]'}`} aria-label={initialSource ? `${sourceLabels[initialSource]} 牌卡` : 'AI共識牌卡'}>
    {!initialSource && <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 border-b border-slate-600 bg-slate-900/90 px-2 py-0.5 text-[10px] text-white">
      {aiSources.map(source => <label key={source} className="inline-flex cursor-pointer items-center gap-1 whitespace-nowrap">
        <input type="checkbox" checked={selected.includes(source)} onChange={() => toggle(source)} aria-label={`選用 ${sourceLabels[source]}`} />
        <span>{sourceLabels[source]}</span>
        <strong className="tabular-nums text-cyan-200" title="本靴命中局數 ÷ 本靴總局數（含和局及無訊號）。">{sourcePerformance[source]?.accuracy == null ? '—' : `${sourcePerformance[source]!.accuracy!.toFixed(1)}%（${sourcePerformance[source]!.correct}/${sourcePerformance[source]!.total}）`}</strong>
      </label>)}
    </div>}
    <div className="grid min-h-0 grid-cols-2">
      <div className="ai-road-panel ai-actual-panel grid min-h-0 grid-rows-[auto_minmax(0,1fr)] border-r border-slate-200">
        <h3 className="ai-road-heading flex items-center justify-between gap-2 px-2 py-1 text-sm font-semibold"><span>實際路單</span><span className="ai-road-badge">已開獎</span></h3>
        <RoadGrid raw={raw} surfaceColor="#edf6ff" />
      </div>
      <div className="ai-road-panel ai-prediction-panel grid min-h-0 grid-rows-[auto_minmax(0,1fr)]">
        <h3 className="ai-road-heading flex items-center justify-between gap-2 px-2 py-1 text-sm font-semibold"><span>下一局共識</span><span className="ai-road-badge">{prediction ? outcomeLabel(prediction) : '無訊號'}</span></h3>
        <RoadGrid raw={raw} prediction={prediction} outcomes={chronologicalOutcomes} surfaceColor="#fff8e1" source={initialSource} />
      </div>
    </div>
    <footer className="ai-prediction-footer flex flex-wrap items-center gap-x-3 border-t border-slate-600 px-2 py-1 text-[11px] leading-4">
      <span>下局預測：<strong className="font-bold" style={{ color: prediction === '1' ? '#60a5fa' : prediction === '2' ? '#f87171' : '#cbd5e1' }}>{isShuffling ? '洗牌中' : !synchronized ? '資料同步中' : outcomeLabel(prediction)}</strong>{!isShuffling && !prediction && <em className="ml-1 not-italic text-amber-200">（本局不出手）</em>}</span>
      <span title="依本靴歷史逐局回測；已保存的當時預測優先採用，不以事後預測改寫結果。">上一局：<strong className={performance?.lastResult === '命中' ? 'text-emerald-300' : performance?.lastResult === '錯誤' ? 'text-orange-300' : 'text-slate-300'}>{performance?.lastResult ?? '資料同步中'}</strong></span>
      {performance ? <>
        <span>目前連中：<strong className="text-emerald-300">{performance.streak}</strong>（最高 {performance.maxStreak}）</span>
        <span>目前連錯：<strong className="text-orange-300">{performance.missStreak}</strong>（最高 {performance.maxMissStreak}）</span>
        <span className="text-slate-400" title="統計本靴第一局至目前；未保存的預測逐局回測補足，已保存的預測保留。最高為本靴最高紀錄，和局不增減連中／連錯。">本靴統計 {performance.total} 局</span>
      </> : <span className="text-slate-400">連中／連錯：本靴資料同步中</span>}
    </footer>
    <Dialog open={selectionNotice} onOpenChange={setSelectionNotice}>
      <DialogContent showCloseButton={false} className="border border-cyan-700 bg-[#111c2d] p-6 text-white shadow-2xl">
        <DialogTitle className="text-lg font-bold">請保留一種 AI</DialogTitle>
        <DialogDescription className="text-sm leading-6 text-slate-200">AI 共識牌卡至少要選擇一種 AI 才能產生訊號。</DialogDescription>
        <DialogClose className="mt-2 rounded-lg bg-cyan-700 px-4 py-2 text-sm font-semibold text-white hover:bg-cyan-600">知道了</DialogClose>
      </DialogContent>
    </Dialog>
  </section>;
}
