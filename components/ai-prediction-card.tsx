'use client';

import { useMemo, useState } from 'react';
import { BaccaratRoad, type RoadMarker } from '@/components/baccarat-road';
import { aiConsensus, aiSources, type AiSource } from '@/lib/ai-consensus';

const sourceLabels: Record<AiSource, string> = {
  chartgpt: 'ChartGPT', gemini: 'Google Gemini', deepseek: 'Deepseek', claude: 'Claude',
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

function RoadGrid({ raw, prediction, surfaceColor }: { raw: string; prediction?: string; surfaceColor: string }) {
  const marker: RoadMarker | undefined = prediction ? {
    text: '共', color: prediction === '2' ? '#ef3535' : '#2864e8',
    label: `共識訊號${outcomeLabel(prediction)}`,
  } : undefined;
  return <div className="ai-road-grid min-h-0 min-w-0 overflow-hidden">
    <BaccaratRoad raw={appendPrediction(raw, prediction)} kind="big" columnLimit={10} surfaceColor={surfaceColor} marker={marker} />
  </div>;
}

export function AiPredictionCard({ raw, tableState, initialSource }: { raw: string; tableState?: string; initialSource?: AiSource }) {
  const [selected, setSelected] = useState<AiSource[]>(initialSource ? [initialSource] : [...aiSources]);
  const isShuffling = tableState === '2';
  const consensus = useMemo(() => aiConsensus(raw, selected), [raw, selected]);
  const prediction = isShuffling ? undefined : consensus.side;
  const toggle = (source: AiSource) => setSelected(current => current.includes(source)
    ? current.length > 1 ? current.filter(item => item !== source) : current
    : aiSources.filter(item => item === source || current.includes(item)));

  return <section className="ai-prediction-card grid h-full min-h-0 grid-rows-[auto_minmax(0,1fr)_auto]" aria-label={initialSource ? `${sourceLabels[initialSource]} 牌卡` : 'AI共識牌卡'}>
    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 border-b border-slate-600 bg-slate-900/90 px-2 py-0.5 text-[10px] text-white">
      <strong>{initialSource ? `${sourceLabels[initialSource]} 牌卡` : 'AI共識牌卡'}</strong><span className="text-amber-200">本機規則</span>
      {!initialSource && aiSources.map(source => <label key={source} className="inline-flex cursor-pointer items-center gap-1 whitespace-nowrap">
        <input type="checkbox" checked={selected.includes(source)} onChange={() => toggle(source)} aria-label={`選用 ${sourceLabels[source]}`} />
        {sourceLabels[source]}
      </label>)}
      {!initialSource && <span className="text-slate-300">至少選 1 種</span>}
    </div>
    <div className="grid min-h-0 grid-cols-2">
      <div className="ai-road-panel ai-actual-panel grid min-h-0 grid-rows-[auto_minmax(0,1fr)] border-r border-slate-200">
        <h3 className="ai-road-heading flex items-center justify-between gap-2 px-2 py-1 text-sm font-semibold"><span>實際路單</span><span className="ai-road-badge">已開獎</span></h3>
        <RoadGrid raw={raw} surfaceColor="#edf6ff" />
      </div>
      <div className="ai-road-panel ai-prediction-panel grid min-h-0 grid-rows-[auto_minmax(0,1fr)]">
        <h3 className="ai-road-heading flex items-center justify-between gap-2 px-2 py-1 text-sm font-semibold"><span>下一局共識</span><span className="ai-road-badge">{prediction ? outcomeLabel(prediction) : '無訊號'}</span></h3>
        <RoadGrid raw={raw} prediction={prediction} surfaceColor="#fff8e1" />
      </div>
    </div>
    <footer className="ai-prediction-footer border-t border-slate-600 px-2 py-1 text-[11px] leading-4">
      {consensus.votes.map((vote, index) => <span key={vote.source}>
        {index > 0 && '／'}{sourceLabels[vote.source]}{' '}
        <strong className="font-bold" style={{ color: vote.side === '1' ? '#60a5fa' : vote.side === '2' ? '#f87171' : '#94a3b8' }}>{outcomeLabel(vote.side)}</strong>
      </span>)}
      {' · '}{isShuffling ? '洗牌中' : !raw ? '等待路單' : <>最終答案：<strong className="font-bold" style={{ color: prediction === '1' ? '#60a5fa' : prediction === '2' ? '#f87171' : '#cbd5e1' }}>{outcomeLabel(prediction)}</strong></>}
    </footer>
  </section>;
}
