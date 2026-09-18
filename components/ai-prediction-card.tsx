'use client';

import { useEffect, useRef, useState } from 'react';
import { BaccaratRoad, type RoadMarker } from '@/components/baccarat-road';

export type AiProvider = 'chartgpt' | 'gemini' | 'deepseek' | 'claude';

const providerLabels: Record<AiProvider, string> = {
  chartgpt: 'ChartGPT',
  gemini: 'Google Gemini',
  deepseek: 'Deepseek',
  claude: 'Claude',
};

// Lightweight seeded pseudo-random prediction for the demo. The seed mixes
// the current road and provider, then uses a small LCG formula so each model
// can produce a different 莊／閒 result without calling an external AI API.
function formulaPrediction(raw: string, provider: AiProvider): '1' | '2' {
  const providerOffset = ({ chartgpt: 17, gemini: 31, deepseek: 47, claude: 61 } as const)[provider];
  let seed = (providerOffset * 2654435761) >>> 0;
  for (let index = 0; index < raw.length; index += 1) {
    seed = (Math.imul(seed ^ raw.charCodeAt(index), 16777619) + index) >>> 0;
  }
  seed = (seed + Math.imul(providerOffset, 1013904223)) >>> 0;
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return ((seed >>> 28) & 1) === 0 ? '1' : '2';
}

type AnalysisStatus = 'waiting' | 'thinking' | 'ready' | 'timeout';

function latestOutcome(raw: string) {
  const entries = raw.split('#').flatMap(column => column.split(',')).reverse();
  const latest = entries.find(entry => /^\d[\d?]\d[1-3]$/.test(entry));
  return latest?.at(-1) === '1' || latest?.at(-1) === '2' ? latest.at(-1) : undefined;
}

function outcomeLabel(outcome?: string) {
  return outcome === '1' ? '閒' : outcome === '2' ? '莊' : '等待';
}

function isBigCode(value: string | undefined) {
  return value !== undefined && /^\d[\d?]\d[1-3]$/.test(value);
}

function parseBigColumns(raw: string) {
  return raw.split('#').map(column => column.includes(',')
    ? column.split(',')
    : column.match(/.{4}/g) ?? []);
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

function AiRoadGrid({ raw, prediction, surfaceColor }: { raw: string; prediction?: string; surfaceColor: string }) {
  const marker: RoadMarker | undefined = prediction ? {
    text: 'AI',
    color: prediction === '2' ? '#ef3535' : '#2864e8',
    label: `AI預測${outcomeLabel(prediction)}`,
  } : undefined;
  return <div className="ai-road-grid min-h-0 min-w-0 overflow-hidden">
    <BaccaratRoad raw={appendPrediction(raw, prediction)} kind="big" columnLimit={10} surfaceColor={surfaceColor} marker={marker} />
  </div>;
}

export function AiPredictionCard({ raw, provider, tableState, countdownDeadline }: {
  raw: string;
  provider: AiProvider;
  tableState?: string;
  countdownDeadline?: number;
}) {
  const label = providerLabels[provider];
  const isShuffling = tableState === '2';
  const [clock, setClock] = useState(() => Date.now());
  const roundFinished = countdownDeadline === undefined || countdownDeadline <= clock;
  const [status, setStatus] = useState<AnalysisStatus>('waiting');
  const [elapsed, setElapsed] = useState(0);
  const [actual, setActual] = useState<string>();
  const [prediction, setPrediction] = useState<string>();
  const pendingPrediction = useRef<string | undefined>(undefined);
  const pendingPredictionRaw = useRef<string | undefined>(undefined);
  const pendingPredictionProvider = useRef<AiProvider | undefined>(undefined);
  const lastInput = useRef('');
  const statusRef = useRef<AnalysisStatus>('waiting');
  const sequence = useRef(0);

  useEffect(() => {
    if (isShuffling || countdownDeadline === undefined || countdownDeadline <= Date.now()) return;
    const timer = window.setTimeout(() => setClock(Date.now()), Math.max(0, countdownDeadline - Date.now()) + 1);
    return () => window.clearTimeout(timer);
  }, [countdownDeadline, isShuffling]);

  useEffect(() => {
    if (isShuffling || !roundFinished) {
      sequence.current += 1;
      pendingPrediction.current = undefined;
      pendingPredictionRaw.current = undefined;
      pendingPredictionProvider.current = undefined;
      lastInput.current = '';
      setPrediction(undefined);
      setActual(undefined);
      setStatus('waiting');
      return;
    }
    const nextActual = latestOutcome(raw);
    const inputSignature = `${provider}:${raw}`;
    if (!nextActual || inputSignature === lastInput.current) return;
    lastInput.current = inputSignature;
    const previousPrediction = pendingPrediction.current;
    const completedPreviousPrediction = previousPrediction !== undefined
      && pendingPredictionProvider.current === provider
      && pendingPredictionRaw.current !== raw;
    pendingPrediction.current = undefined;
    pendingPredictionRaw.current = undefined;
    pendingPredictionProvider.current = undefined;
    // The latest raw result is only the actual value for a prior prediction
    // when a new round has arrived. Do not echo the previous round as the
    // actual result while the current prediction is still pending.
    setActual(completedPreviousPrediction ? nextActual : undefined);
    setPrediction(undefined);
    statusRef.current = 'thinking';
    setStatus('thinking');
    setElapsed(0);
    const currentSequence = ++sequence.current;
    const startedAt = Date.now();
    const ticker = window.setInterval(() => setElapsed(Math.floor((Date.now() - startedAt) / 1000)), 250);
    const analysisTimer = window.setTimeout(() => {
      if (sequence.current !== currentSequence || statusRef.current !== 'thinking') return;
      // Provider adapters are optional in this demo, so use the seeded
      // formula above instead of making an external AI request.
      const nextPrediction = formulaPrediction(raw, provider);
      pendingPrediction.current = nextPrediction;
      pendingPredictionRaw.current = raw;
      pendingPredictionProvider.current = provider;
      setPrediction(nextPrediction);
      statusRef.current = 'ready';
      setStatus('ready');
    }, provider === 'deepseek' ? 3200 : provider === 'claude' ? 2600 : 2000);
    const timeoutTimer = window.setTimeout(() => {
      if (sequence.current !== currentSequence || statusRef.current !== 'thinking') return;
      statusRef.current = 'timeout';
      setStatus('timeout');
    }, 5000);
    return () => { window.clearInterval(ticker); window.clearTimeout(analysisTimer); window.clearTimeout(timeoutTimer); };
  }, [raw, provider, isShuffling, roundFinished]);

  const statusText = status === 'thinking'
    ? `已處理 ${elapsed} 秒 · 深度分析中…`
    : isShuffling
      ? '洗牌中，暫停預測'
    : status === 'timeout'
      ? '分析逾時，等待下一筆實際結果後重試'
      : status === 'ready' ? '已完成本輪預測，等待實際結果比對'
        : !roundFinished ? '等待本局結束後再預測' : '等待牌局資料';

  return (
    <section className="ai-prediction-card grid h-full min-h-0 grid-rows-[minmax(0,1fr)_auto]" aria-label={`${label} AI牌卡`}>
      <div className="grid min-h-0 grid-cols-2">
        <div className="ai-road-panel ai-actual-panel grid min-h-0 grid-rows-[auto_minmax(0,1fr)] border-r border-slate-200">
          <h3 className="ai-road-heading flex items-center justify-between gap-2 px-2 py-1 text-sm font-semibold"><span>實際結果</span><span className="ai-road-badge">已開獎</span></h3>
          <AiRoadGrid raw={raw} surfaceColor="#edf6ff" />
        </div>
        <div className="ai-road-panel ai-prediction-panel grid min-h-0 grid-rows-[auto_minmax(0,1fr)]">
          <h3 className="ai-road-heading flex items-center justify-between gap-2 px-2 py-1 text-sm font-semibold"><span>預測結果 · 下一局</span><span className="ai-road-badge">{prediction ? '已產生' : '待分析'}</span></h3>
          <AiRoadGrid raw={raw} prediction={prediction} surfaceColor="#fff8e1" />
        </div>
      </div>
      <footer className="ai-prediction-footer grid gap-0.5 border-t border-slate-600 px-2 py-1 text-[11px] leading-4">
        <div className="flex flex-wrap items-center justify-between gap-2"><span className="font-medium">{label}：{statusText}</span><span>預測 {outcomeLabel(prediction)} · 實際 {outcomeLabel(actual)}</span></div>
      </footer>
    </section>
  );
}
