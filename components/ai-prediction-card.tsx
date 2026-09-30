'use client';

import { useEffect, useMemo, useState } from 'react';
import { BaccaratRoad, type RoadMarker } from '@/components/baccarat-road';
import { aiConsensus, aiSources, type AiSource } from '@/lib/ai-consensus';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import type { PredictionDecision } from '@/lib/prediction-performance';

const sourceLabels: Record<AiSource, string> = {
  chartgpt: 'ChartGPT', gemini: 'Google Gemini', deepseek: 'DeepSeek', claude: 'Claude',
};
const sourceAbbreviations: Record<AiSource, string> = {
  chartgpt: 'GPT', gemini: 'GM', deepseek: 'DS', claude: 'CL',
};

function outcomeLabel(outcome?: string) {
  return outcome === '1' ? '閒' : outcome === '2' ? '莊' : '無訊號';
}

function isBigCode(value: string | undefined) {
  return value !== undefined && /^\d[\d?]\d[1-3]$/.test(value);
}

function parseBigColumns(raw: string) {
  return raw.split('#').map(column => column.includes(',') ? column.split(',') : column.match(/.{4}/g) ?? []);
}

export function predictionPerformance(raw: string, selected: readonly AiSource[]) {
  const columns = parseBigColumns(raw).filter(column => column.length > 0);
  const rounds = columns.flatMap((column, columnIndex) => column
    .map((code, rowIndex) => ({ code, columnIndex, rowIndex }))
    .filter(item => isBigCode(item.code)));
  let correct = 0;
  let noSignal = 0;
  let streak = 0;
  let missStreak = 0;
  let maxStreak = 0;
  let maxMissStreak = 0;
  let lastResult: '命中' | '錯誤' | '無訊號' | '等待' = '等待';
  const decisions: PredictionDecision[] = [];
  for (const round of rounds) {
    const prefix = columns.slice(0, round.columnIndex + 1).map((column, columnIndex) =>
      column.slice(0, columnIndex === round.columnIndex ? round.rowIndex : column.length).join(','))
      .filter(Boolean).join('#');
    const roundConsensus = aiConsensus(prefix, selected);
    const predicted = roundConsensus.side;
    const actual = round.code.at(-1) as '1' | '2';
    const agreement = predicted ? roundConsensus.votes.filter(vote => vote.side === predicted).length : 0;
    decisions.push({ prediction: predicted, outcome: actual, agreement, activeVotes: roundConsensus.active });
    if (!predicted) { noSignal += 1; lastResult = '無訊號'; }
    else if (predicted === round.code.at(-1)) { correct += 1; streak += 1; missStreak = 0; maxStreak = Math.max(maxStreak, streak); lastResult = '命中'; }
    else { streak = 0; missStreak += 1; maxMissStreak = Math.max(maxMissStreak, missStreak); lastResult = '錯誤'; }
  }
  const signaled = rounds.length - noSignal;
  return { total: rounds.length, correct, noSignal, accuracy: signaled > 0 ? correct / signaled * 100 : null, streak, missStreak, maxStreak, maxMissStreak, lastResult, decisions };
}

function appendPrediction(raw: string, prediction?: string) {
  if (!prediction) return raw;
  const code = `0?0${prediction}`;
  if (!raw) return code;
  const columns = parseBigColumns(raw);
  let lastColumn = -1;
  let lastRow = -1;
  for (let column = columns.length - 1; column >= 0 && lastColumn < 0; column -= 1) {
    for (let row = columns[column].length - 1; row >= 0; row -= 1) {
      if (isBigCode(columns[column][row])) { lastColumn = column; lastRow = row; break; }
    }
  }
  if (lastColumn < 0) return `${raw}#${code}`;
  const lastOutcome = columns[lastColumn][lastRow].at(-1);
  let targetColumn = lastColumn;
  let targetRow = lastRow;
  if (lastOutcome === prediction && lastRow < 5 && !isBigCode(columns[lastColumn][lastRow + 1])) {
    targetRow += 1;
  } else {
    targetColumn += 1;
    targetRow = lastOutcome === prediction ? lastRow : 0;
    while (isBigCode(columns[targetColumn]?.[targetRow])) targetColumn += 1;
  }
  columns[targetColumn] ??= [];
  while (columns[targetColumn].length <= targetRow) columns[targetColumn].push('');
  columns[targetColumn][targetRow] = code;
  return columns.map(column => column.join(',')).join('#');
}

function RoadGrid({ raw, prediction, surfaceColor, source }: { raw: string; prediction?: string; surfaceColor: string; source?: AiSource }) {
  const marker: RoadMarker | undefined = prediction ? {
    text: source ? sourceAbbreviations[source] : '共',
    color: prediction === '2' ? '#ef3535' : '#2864e8',
    label: `${source ? sourceLabels[source] : '共識'}訊號${outcomeLabel(prediction)}`,
  } : undefined;
  return <div className="ai-road-grid min-h-0 min-w-0 overflow-hidden">
    <BaccaratRoad raw={appendPrediction(raw, prediction)} kind="big" columnLimit={10} surfaceColor={surfaceColor} marker={marker} />
  </div>;
}

export function AiPredictionCard({ raw, tableState, initialSource, onPredictionChange }: { raw: string; tableState?: string; initialSource?: AiSource; onPredictionChange?: (side: '1' | '2' | undefined, history: PredictionDecision[], agreement?: number) => void }) {
  const [selected, setSelected] = useState<AiSource[]>(initialSource ? [initialSource] : [...aiSources]);
  const [selectionNotice, setSelectionNotice] = useState(false);
  const isShuffling = tableState === '2';
  const consensus = useMemo(() => aiConsensus(raw, selected), [raw, selected]);
  const performance = useMemo(() => predictionPerformance(raw, selected), [raw, selected]);
  const sourcePerformance = useMemo(() => Object.fromEntries(aiSources.map(source => [source, predictionPerformance(raw, [source])])) as Record<AiSource, ReturnType<typeof predictionPerformance>>, [raw]);
  const prediction = isShuffling ? undefined : consensus.side;
  const agreement = prediction ? consensus.votes.filter(vote => vote.side === prediction).length : 0;
  useEffect(() => { onPredictionChange?.(prediction, performance.decisions, agreement); }, [agreement, onPredictionChange, performance.decisions, prediction]);
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
        <strong className="tabular-nums text-cyan-200">{sourcePerformance[source].accuracy === null ? `—（0/${sourcePerformance[source].total}）` : `${sourcePerformance[source].accuracy.toFixed(1)}%（${sourcePerformance[source].correct}/${sourcePerformance[source].total}）`}</strong>
      </label>)}
    </div>}
    <div className="grid min-h-0 grid-cols-2">
      <div className="ai-road-panel ai-actual-panel grid min-h-0 grid-rows-[auto_minmax(0,1fr)] border-r border-slate-200">
        <h3 className="ai-road-heading flex items-center justify-between gap-2 px-2 py-1 text-sm font-semibold"><span>實際路單</span><span className="ai-road-badge">已開獎</span></h3>
        <RoadGrid raw={raw} surfaceColor="#edf6ff" />
      </div>
      <div className="ai-road-panel ai-prediction-panel grid min-h-0 grid-rows-[auto_minmax(0,1fr)]">
        <h3 className="ai-road-heading flex items-center justify-between gap-2 px-2 py-1 text-sm font-semibold"><span>下一局共識</span><span className="ai-road-badge">{prediction ? outcomeLabel(prediction) : '無訊號'}</span></h3>
        <RoadGrid raw={raw} prediction={prediction} surfaceColor="#fff8e1" source={initialSource} />
      </div>
    </div>
    <footer className="ai-prediction-footer flex flex-wrap items-center gap-x-3 border-t border-slate-600 px-2 py-1 text-[11px] leading-4">
      <span>下局預測：<strong className="font-bold" style={{ color: prediction === '1' ? '#60a5fa' : prediction === '2' ? '#f87171' : '#cbd5e1' }}>{isShuffling ? '洗牌中' : outcomeLabel(prediction)}</strong>{!isShuffling && !prediction && <em className="ml-1 not-italic text-amber-200">（本局不出手）</em>}</span>
      <span>上次預測：<strong className={performance.lastResult === '命中' ? 'text-emerald-300' : performance.lastResult === '錯誤' ? 'text-orange-300' : 'text-slate-300'}>{performance.lastResult}</strong></span>
      <span>目前連中：<strong className="text-emerald-300">{performance.streak}</strong>（最高 {performance.maxStreak}）</span>
      <span>目前連錯：<strong className="text-orange-300">{performance.missStreak}</strong>（最高 {performance.maxMissStreak}）</span>
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
