'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Check, Download, FileJson, FileText, Pause, Play, RotateCcw, Square, Trophy } from 'lucide-react';

type Result = '莊' | '閒' | '和';
type TargetKind = '圖形' | 'AI';
type Target = { id: string; name: string; kind: TargetKind; model?: string };
type PlatformId = 'MT' | 'DG' | 'AB';
type RecordStatus = 'correct' | 'wrong' | 'timeout' | 'no_signal';
type DemoRecord = { roundId: number; targetId: string; targetName: string; prediction: Result | null; actualResult: Result; status: RecordStatus; simulatedLatencyMs: number | null };
type RunSnapshot = { runId: string; sourcePlatform: PlatformId; totalRounds: number; targets: Target[]; rounds: DemoRecord[]; targetTotalMs: number; actualActiveDurationMs: number; pausedMs: number; completed: boolean; startedAt: string; finishedAt?: string };

const RESULT_COLORS: Record<Result, string> = { 莊: '#ef4444', 閒: '#3b82f6', 和: '#22c55e' };
const RUN_CONFIG = { minMs: 12_000, maxMs: 28_000, prepRatio: .05, playbackRatio: .80, aggregateRatio: .10 };
const MIN_ROUNDS = 100;
const MAX_ROUNDS = 10_000;
const targetCatalog: Target[] = [
  { id: 'v', name: 'V型牌卡', kind: '圖形' },
  { id: 'cross', name: '十字牌卡', kind: '圖形' },
  { id: 'chartgpt', name: 'ChartGPT', kind: 'AI', model: 'ChartGPT' },
  { id: 'gemini', name: 'Google Gemini', kind: 'AI', model: 'Google Gemini' },
  { id: 'deepseek', name: 'Deepseek', kind: 'AI', model: 'Deepseek' },
  { id: 'claude', name: 'Claude', kind: 'AI', model: 'Claude' },
];
const resultValues: Result[] = ['莊', '閒', '和'];

const randomBetween = (min: number, max: number) => Math.floor(min + Math.random() * (max - min + 1));
const chooseResult = (): Result => { const value = Math.random(); return value < .46 ? '莊' : value < .91 ? '閒' : '和'; };
const statusLabel: Record<RecordStatus, string> = { correct: '命中', wrong: '錯誤', timeout: 'Timeout', no_signal: '未出訊號' };
const statusTone: Record<RecordStatus, string> = { correct: 'text-emerald-300', wrong: 'text-rose-300', timeout: 'text-amber-300', no_signal: 'text-slate-400' };

function generateRun(totalRounds: number, targets: Target[], targetTotalMs: number, sourcePlatform: PlatformId): RunSnapshot {
  const rounds: DemoRecord[] = [];
  const quality = new Map(targets.map(target => [target.id, target.id === 'v' ? .44 + Math.random() * .30 : target.kind === '圖形' ? .34 + Math.random() * .32 : .32 + Math.random() * .34]));
  for (let round = 1; round <= totalRounds; round++) {
    const actualResult = chooseResult();
    for (const target of targets) {
      const marker = Math.random();
      let status: RecordStatus;
      let prediction: Result | null = null;
      let simulatedLatencyMs: number | null = null;
      if (target.kind === 'AI' && marker < .02) status = 'timeout';
      else if (target.kind === '圖形' && marker < .05) status = 'no_signal';
      else {
        const correct = Math.random() < (quality.get(target.id) ?? .6);
        status = correct ? 'correct' : 'wrong';
        prediction = correct ? actualResult : resultValues.filter(value => value !== actualResult)[randomBetween(0, 1)];
        simulatedLatencyMs = randomBetween(80, 900);
      }
      rounds.push({ roundId: round, targetId: target.id, targetName: target.name, prediction, actualResult, status, simulatedLatencyMs });
    }
  }
  return { runId: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, sourcePlatform, totalRounds, targets, rounds, targetTotalMs, actualActiveDurationMs: 0, pausedMs: 0, completed: false, startedAt: new Date().toISOString() };
}

const escapeHtml = (value: unknown) => {
  const text = typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? String(value) : JSON.stringify(value) ?? '';
  return text.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char] ?? char));
};
const download = (filename: string, content: string, type: string) => {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = filename; anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
};
const csvCell = (value: unknown) => { const text = typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? String(value) : value == null ? '' : JSON.stringify(value); return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text; };

function ResultsRoad({ results, label }: { results: Result[]; label: string }) {
  return <div className="rounded-lg border border-cyan-300/20 bg-slate-950/50 p-3"><div className="mb-2 text-xs font-semibold text-cyan-100">{label}</div><div className="flex max-h-24 flex-wrap gap-1 overflow-hidden">{results.slice(-48).map((result, index) => <span key={`${result}-${index}`} className="grid h-6 w-6 place-items-center rounded-full border text-[11px] font-bold" style={{ borderColor: RESULT_COLORS[result], color: RESULT_COLORS[result] }}>{result}</span>)}</div>{results.length === 0 && <p className="text-xs text-slate-500">等待資料</p>}</div>;
}

const LINE_COLORS = ['#22d3ee', '#f59e0b', '#a78bfa', '#4ade80', '#fb7185', '#f472b6'];

function AccuracyLineChart({ records, targets }: { records: DemoRecord[]; targets: Target[] }) {
  const width = 760;
  const height = 250;
  const padX = 54;
  const padY = 28;
  const series = targets.map((target, targetIndex) => {
    const targetRecords = records.filter(record => record.targetId === target.id).sort((a, b) => a.roundId - b.roundId);
    if (targetRecords.length === 0) return { target, color: LINE_COLORS[targetIndex % LINE_COLORS.length], samples: [] as Array<{ x: number; value: number }> };
    const step = Math.max(1, Math.ceil(targetRecords.length / 60));
    const windowSize = Math.max(5, Math.ceil(targetRecords.length / 24));
    const samples: Array<{ x: number; value: number }> = [];
    for (let end = step - 1; end < targetRecords.length; end += step) {
      const slice = targetRecords.slice(Math.max(0, end + 1 - windowSize), end + 1);
      const valid = slice.filter(record => record.status === 'correct' || record.status === 'wrong');
      if (!valid.length) continue;
      const correct = valid.filter(record => record.status === 'correct').length;
      const x = padX + (end / Math.max(1, targetRecords.length - 1)) * (width - padX * 2);
      samples.push({ x, value: correct / valid.length });
    }
    return { target, color: LINE_COLORS[targetIndex % LINE_COLORS.length], samples };
  });
  const values = series.flatMap(item => item.samples.map(sample => sample.value));
  const observedMin = values.length ? Math.min(...values) : 0;
  const observedMax = values.length ? Math.max(...values) : 1;
  const padding = Math.max(.03, (observedMax - observedMin) * .18);
  let axisMin = Math.max(0, observedMin - padding);
  let axisMax = Math.min(1, observedMax + padding);
  if (axisMax - axisMin < .1) {
    const middle = (axisMin + axisMax) / 2;
    axisMin = Math.max(0, middle - .05);
    axisMax = Math.min(1, middle + .05);
  }
  const axisSpan = Math.max(.01, axisMax - axisMin);
  const yFor = (value: number) => height - padY - ((value - axisMin) / axisSpan) * (height - padY * 2);
  const labels = [axisMax, (axisMin + axisMax) / 2, axisMin];
  const current = targets.map((target, targetIndex) => {
    const targetRecords = records.filter(record => record.targetId === target.id);
    const valid = targetRecords.filter(record => record.status === 'correct' || record.status === 'wrong');
    const correct = valid.filter(record => record.status === 'correct').length;
    return { target, value: valid.length ? correct / valid.length : 0, hasValue: valid.length > 0, color: LINE_COLORS[targetIndex % LINE_COLORS.length] };
  });
  const currentMax = current.length ? Math.max(...current.map(item => item.value)) : 0;
  const rightAxisMax = currentMax > 0 ? Math.min(1, Math.max(.1, Math.ceil((currentMax + .05) * 10) / 10)) : 1;
  const slot = (width - padX * 2) / Math.max(1, current.length);
  const barWidth = Math.min(52, slot * .52);
  const barBottom = height - padY;
  const barHeight = height - padY * 2;
  return <div className="rounded-lg border border-cyan-300/20 bg-slate-950/50 p-3">
    <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
      <div className="text-xs font-semibold text-cyan-100">正確率走勢／目前正確率</div>
      <div className="flex gap-3 text-[10px] text-slate-500"><span>折線：走勢</span><span>直條：目前</span></div>
    </div>
    <svg viewBox={'0 0 ' + width + ' ' + height} className="h-[250px] w-full" aria-label="正確率走勢與目前正確率組合圖">
      <line x1={padX} x2={width - padX} y1={padY} y2={padY} stroke="#334155" strokeWidth="1" />
      <line x1={padX} x2={width - padX} y1={height / 2} y2={height / 2} stroke="#334155" strokeWidth="1" />
      <line x1={padX} x2={width - padX} y1={height - padY} y2={height - padY} stroke="#334155" strokeWidth="1" />
      {labels.map((label, index) => <text key={'left-' + index} x="4" y={padY + index * ((height - padY * 2) / 2) + 4} fill="#94a3b8" fontSize="11">{(label * 100).toFixed(0)}%</text>)}
      <text x={width - 2} y={padY + 4} textAnchor="end" fill="#94a3b8" fontSize="11">{(rightAxisMax * 100).toFixed(0)}%</text>
      <text x={width - 2} y={height / 2 + 4} textAnchor="end" fill="#94a3b8" fontSize="11">{(rightAxisMax * 50).toFixed(0)}%</text>
      <text x={width - 2} y={height - padY + 4} textAnchor="end" fill="#94a3b8" fontSize="11">0%</text>
      {current.map((item, index) => {
        const x = padX + slot * index + (slot - barWidth) / 2;
        const barHeightValue = item.value / rightAxisMax * barHeight;
        const y = barBottom - barHeightValue;
        return <g key={'bar-' + item.target.id}>
          <rect x={x} y={item.hasValue ? y : barBottom - 2} width={barWidth} height={item.hasValue ? barHeightValue : 2} rx="4" fill={item.color} opacity={item.hasValue ? .16 : .08} />
          <text x={x + barWidth / 2} y={Math.max(padY + 13, y - 5)} textAnchor="middle" fill="#e2e8f0" fontSize="11">{item.hasValue ? (item.value * 100).toFixed(1) + '%' : '—'}</text>
          <text x={x + barWidth / 2} y={height - 5} textAnchor="middle" fill="#94a3b8" fontSize="10">{item.target.name}</text>
        </g>;
      })}
      {series.map(item => item.samples.length > 0 && <polyline key={'line-' + item.target.id} fill="none" stroke={item.color} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" points={item.samples.map(sample => sample.x.toFixed(1) + ',' + yFor(sample.value).toFixed(1)).join(' ')} />)}
    </svg>
    <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-slate-300">{series.map(item => <span key={item.target.id} className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-full" style={{ backgroundColor: item.color }} />{item.target.name}</span>)}</div>
    {records.length === 0 && <p className="mt-2 text-center text-xs text-slate-500">開始後會顯示走勢與目前比較</p>}
  </div>;
}
function RegressionTest() {
  const [roundsInput, setRoundsInput] = useState('500');
  const [customRoundsInput, setCustomRoundsInput] = useState('500');
  const [sourcePlatform, setSourcePlatform] = useState<PlatformId>('MT');
  const [selectedIds, setSelectedIds] = useState<string[]>(() => targetCatalog.map(target => target.id));
  const [run, setRun] = useState<RunSnapshot | null>(null);
  const [revealedRounds, setRevealedRounds] = useState(0);
  const [activeElapsed, setActiveElapsed] = useState(0);
  const [playState, setPlayState] = useState<'idle' | 'playing' | 'paused' | 'stopped' | 'done'>('idle');
  const [notice, setNotice] = useState('');
  const lastTick = useRef<number | undefined>(undefined);
  const pausedAt = useRef<number | undefined>(undefined);
  const [lastSnapshot, setLastSnapshot] = useState<RunSnapshot | null>(null);
  const targets = useMemo(() => targetCatalog.filter(target => selectedIds.includes(target.id)), [selectedIds]);
  const requestedRounds = Number(roundsInput === 'custom' ? customRoundsInput : roundsInput);
  const normalizedRounds = Number.isFinite(requestedRounds) ? Math.floor(requestedRounds) : MIN_ROUNDS;
  const totalRounds = Math.max(MIN_ROUNDS, Math.min(MAX_ROUNDS, normalizedRounds));
  const revealedRecords = useMemo(() => run ? run.rounds.filter(record => record.roundId <= revealedRounds) : [], [run, revealedRounds]);
  const actualResults = useMemo(() => run ? run.rounds.filter(record => record.targetId === run.targets[0]?.id && record.roundId <= revealedRounds).map(record => record.actualResult) : [], [run, revealedRounds]);
  const stats = useMemo(() => targets.map(target => {
    const records = revealedRecords.filter(record => record.targetId === target.id);
    const correct = records.filter(record => record.status === 'correct').length;
    const wrong = records.filter(record => record.status === 'wrong').length;
    const timeout = records.filter(record => record.status === 'timeout').length;
    const noSignal = records.filter(record => record.status === 'no_signal').length;
    const valid = correct + wrong;
    const rankingWindow = records.slice(-Math.max(8, Math.ceil(records.length * .18)));
    const rankingValid = rankingWindow.filter(record => record.status === 'correct' || record.status === 'wrong');
    const rankingCorrect = rankingValid.filter(record => record.status === 'correct').length;
    let streak = 0; let bestStreak = 0;
    for (const record of records) { if (record.status === 'correct') { streak++; bestStreak = Math.max(bestStreak, streak); } else streak = 0; }
    const latency = records.filter(record => record.simulatedLatencyMs !== null).map(record => record.simulatedLatencyMs!);
    const accuracy = rankingValid.length ? rankingCorrect / rankingValid.length : 0;
    return { target, total: records.length, correct, wrong, timeout, noSignal, valid, rankingValid: rankingValid.length, accuracy, coverage: records.length ? valid / records.length : 0, bestStreak, latency: latency.length ? latency.reduce((sum, value) => sum + value, 0) / latency.length : 0 };
  }), [revealedRecords, targets]);
  const ranking = [...stats].sort((a, b) => b.accuracy - a.accuracy || b.rankingValid - a.rankingValid || a.target.id.localeCompare(b.target.id));
  const targetResultCount = run ? run.totalRounds : totalRounds;
  const progress = targetResultCount ? Math.min(1, revealedRounds / targetResultCount) : 0;
  const speed = activeElapsed > 0 ? Math.round((revealedRounds * 1000) / activeElapsed) : 0;
  const phase = playState === 'done' ? '成果揭曉' : playState === 'stopped' ? '已停止' : !run ? '等待開始' : activeElapsed < run.targetTotalMs * RUN_CONFIG.prepRatio ? '準備資料' : activeElapsed < run.targetTotalMs * (RUN_CONFIG.prepRatio + RUN_CONFIG.playbackRatio) ? '逐批執行中' : activeElapsed < run.targetTotalMs * (1 - .05) ? '彙整結果' : '成果揭曉';

  const begin = useCallback(() => {
    if (targets.length === 0) { setNotice('至少選擇一張牌卡才能開始。'); return; }
    const roundsRatio = (totalRounds - MIN_ROUNDS) / (MAX_ROUNDS - MIN_ROUNDS); const targetTotalMs = Math.round(3_000 + roundsRatio * 27_000 + randomBetween(-400, 400));
    const next = generateRun(totalRounds, targets, targetTotalMs, sourcePlatform);
    setRun(next); setLastSnapshot(null); setRevealedRounds(0); setActiveElapsed(0); setNotice(''); setPlayState('playing');
    lastTick.current = performance.now(); pausedAt.current = undefined;
  }, [sourcePlatform, targets, totalRounds]);
  const stop = useCallback(() => { if (!run || playState === 'idle' || playState === 'done') return; setPlayState('stopped'); setLastSnapshot({ ...run, rounds: run.rounds.filter(record => record.roundId <= revealedRounds), actualActiveDurationMs: activeElapsed, completed: false, finishedAt: new Date().toISOString() }); }, [activeElapsed, playState, revealedRounds, run]);
  const togglePause = useCallback(() => {
    if (!run || playState === 'done' || playState === 'stopped') return;
    if (playState === 'playing') { pausedAt.current = performance.now(); setPlayState('paused'); }
    else { const now = performance.now(); if (pausedAt.current) setRun(current => current ? { ...current, pausedMs: current.pausedMs + (now - pausedAt.current!) } : current); lastTick.current = now; pausedAt.current = undefined; setPlayState('playing'); }
  }, [playState, run]);
  const reset = () => { setPlayState('idle'); setRun(null); setLastSnapshot(null); setRevealedRounds(0); setActiveElapsed(0); setNotice(''); };

  useEffect(() => {
    const visibility = () => { if (document.hidden && playState === 'playing') { pausedAt.current = performance.now(); setPlayState('paused'); setNotice('分頁已切到背景，測試已自動暫停；返回後按「繼續」。'); } };
    document.addEventListener('visibilitychange', visibility); return () => document.removeEventListener('visibilitychange', visibility);
  }, [playState]);
  useEffect(() => {
    if (playState !== 'playing' || !run) return;
    const timer = window.setInterval(() => {
      const now = performance.now();
      const previous = lastTick.current ?? now;
      lastTick.current = now;
      setActiveElapsed(current => {
        const nextElapsed = Math.min(run.targetTotalMs, current + Math.max(0, now - previous));
        const prep = run.targetTotalMs * RUN_CONFIG.prepRatio;
        const playback = run.targetTotalMs * RUN_CONFIG.playbackRatio;
        const nextRounds = nextElapsed <= prep ? 0 : Math.min(run.totalRounds, Math.floor(run.totalRounds * Math.min(1, (nextElapsed - prep) / playback)));
        setRevealedRounds(nextRounds);
        if (nextElapsed >= run.targetTotalMs) {
          setPlayState('done');
          const finished = { ...run, actualActiveDurationMs: nextElapsed, completed: true, finishedAt: new Date().toISOString() };
          setRun(finished); setLastSnapshot(finished);
        }
        return nextElapsed;
      });
    }, 100);
    return () => window.clearInterval(timer);
  }, [playState, run]);

  const snapshot = lastSnapshot ?? (run && (playState === 'done' || playState === 'stopped') ? run : null);
  const downloadReport = (format: 'html' | 'csv' | 'json') => {
    if (!snapshot) return;
    const stamp = snapshot.runId.replace(/[^a-z0-9-]/gi, '');
    if (format === 'json') return download(`Baccarat-Regression-${stamp}.json`, JSON.stringify(snapshot, null, 2), 'application/json');
    const rows = snapshot.rounds.map(record => [record.roundId, record.targetName, record.prediction ?? '—', record.actualResult, statusLabel[record.status], record.simulatedLatencyMs ?? '—'].map(csvCell).join(','));
    if (format === 'csv') return download(`Baccarat-Regression-${stamp}.csv`, `sourcePlatform,${snapshot.sourcePlatform}\nroundId,target,prediction,actual,status,simulatedLatencyMs\n${rows.join('\n')}`, 'text/csv;charset=utf-8');
    const summary = stats.map(item => `<tr><td>${escapeHtml(item.target.name)}</td><td>${(item.accuracy * 100).toFixed(2)}%</td><td>${item.valid}</td><td>${(item.coverage * 100).toFixed(2)}%</td><td>${item.timeout}</td><td>${item.noSignal}</td></tr>`).join('');
    const details = snapshot.rounds.map(record => `<tr><td>${record.roundId}</td><td>${escapeHtml(record.targetName)}</td><td>${record.prediction ?? '—'}</td><td>${record.actualResult}</td><td>${statusLabel[record.status]}</td><td>${record.simulatedLatencyMs ?? '—'}</td></tr>`).join('');
    const html = `<!doctype html><html lang="zh-Hant"><meta charset="utf-8"><title>百家樂回歸測試報告</title><style>body{font:14px system-ui;margin:32px;color:#172033}table{border-collapse:collapse;width:100%;margin:12px 0}th,td{border:1px solid #cbd5e1;padding:6px;text-align:left}th{background:#e2e8f0}</style><h1>百家樂回歸測試報告</h1><p>資料平台：${escapeHtml(snapshot.sourcePlatform)}　runId：${escapeHtml(snapshot.runId)}　局數：${snapshot.totalRounds}　狀態：${snapshot.completed ? '完整完成' : '部分結果'}</p><h2>排名</h2><table><tr><th>牌卡</th><th>正確率</th><th>有效判定</th><th>覆蓋率</th><th>Timeout</th><th>未出訊號</th></tr>${summary}</table><h2>逐局明細</h2><table><tr><th>局號</th><th>牌卡</th><th>預測</th><th>實際</th><th>判定</th><th>處理耗時</th></tr>${details}</table></html>`;
    download(`Baccarat-Regression-Report-${stamp}.html`, html, 'text/html;charset=utf-8');
  };

  return <section className="overflow-hidden rounded-2xl border border-cyan-400/30 bg-[#0d111a] shadow-[0_24px_70px_rgba(0,0,0,.42)]">
    <header className="border-b border-cyan-400/20 bg-slate-950/40 px-5 py-4"><div className="flex flex-wrap items-center justify-between gap-3"><div><h1 className="text-lg font-semibold text-cyan-100">回歸測試</h1><p className="mt-1 text-xs text-slate-400">選擇資料平台、牌卡與測試局數後開始執行。</p></div><span className="text-xs text-slate-400">依局數自動配速</span></div></header>
    <div className="grid gap-3 p-3">
      <section className={`rounded-xl border border-cyan-300/20 bg-slate-900/50 p-3 ${playState === 'idle' ? 'order-first' : 'order-last'}`}><div className="mb-3 flex flex-wrap items-center justify-between gap-2"><h2 className="font-semibold text-cyan-100">測試設定</h2><span className="text-xs text-slate-400">開始後設定會鎖定</span></div><div className="grid gap-4 lg:grid-cols-[220px_1fr]"><div className="grid gap-3"><label className="grid gap-2 text-xs text-slate-300">資料平台<select value={sourcePlatform} disabled={playState === 'playing' || playState === 'paused'} onChange={event => setSourcePlatform(event.target.value as PlatformId)} className="h-10 rounded-md border border-cyan-300/35 bg-slate-950 px-3 text-sm text-white"><option value="MT">MT · 百家樂</option><option value="DG">DG · 百家樂</option><option value="AB">歐博 · 百家樂</option></select></label><label className="grid gap-2 text-xs text-slate-300">測試局數 <span className="text-[10px] text-slate-500">隨機抽取歷史紀錄 · 上限 {MAX_ROUNDS.toLocaleString()} 局</span><select value={roundsInput} disabled={playState === 'playing' || playState === 'paused'} onChange={event => setRoundsInput(event.target.value)} className="h-10 rounded-md border border-cyan-300/35 bg-slate-950 px-3 text-sm text-white"><option value="100">100 局</option><option value="500">500 局</option><option value="1000">1,000 局</option><option value="3000">3,000 局</option><option value="10000">最大局數 · 10,000 局</option><option value="custom">自訂局數</option></select><button type="button" disabled={playState === 'playing' || playState === 'paused'} onClick={() => setRoundsInput('10000')} className="h-9 rounded-md border border-cyan-300/40 px-3 text-xs text-cyan-100 disabled:opacity-40">最大局數</button>{roundsInput === 'custom' && <input type="number" min={MIN_ROUNDS} max={MAX_ROUNDS} step="1" value={customRoundsInput} onChange={event => setCustomRoundsInput(event.target.value)} className="h-9 rounded-md border border-cyan-300/35 bg-slate-950 px-3 text-sm text-white" />}</label></div><div><div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-xs text-slate-300"><span>選擇圖形牌卡與 AI 牌卡（可複選）</span><span className="flex gap-2"><button type="button" disabled={playState === 'playing' || playState === 'paused'} onClick={() => setSelectedIds(targetCatalog.map(target => target.id))} className="text-cyan-300 hover:underline disabled:opacity-40">全選</button><button type="button" disabled={playState === 'playing' || playState === 'paused'} onClick={() => setSelectedIds([])} className="text-cyan-300 hover:underline disabled:opacity-40">取消全選</button></span></div><div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">{targetCatalog.map(target => { const checked = selectedIds.includes(target.id); return <button key={target.id} type="button" disabled={playState === 'playing' || playState === 'paused'} onClick={() => setSelectedIds(current => checked ? current.filter(id => id !== target.id) : [...current, target.id])} className={`flex items-center justify-between rounded-lg border px-3 py-2 text-left text-xs transition ${checked ? 'border-cyan-300/70 bg-cyan-400/15 text-cyan-100' : 'border-slate-700 bg-slate-950/40 text-slate-400 hover:border-cyan-300/40'}`}><span><span className="mr-2 rounded bg-slate-700/70 px-1.5 py-0.5 text-[10px]">{target.kind}</span>{target.name}</span>{checked && <Check className="h-4 w-4 text-cyan-300" />}</button>; })}</div><p className="mt-2 text-xs text-slate-500">已選 {targets.length} 張牌卡 · 系統自動配速，不提供速度或執行時間設定。</p></div></div><div className="mt-4 flex flex-wrap items-center gap-2"><button type="button" onClick={begin} disabled={playState === 'playing' || playState === 'paused'} className="inline-flex h-10 items-center gap-2 rounded-md bg-cyan-700 px-4 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-40"><Play className="h-4 w-4" />開始測試</button><button type="button" onClick={togglePause} disabled={!run || playState === 'done' || playState === 'stopped'} className="inline-flex h-10 items-center gap-2 rounded-md border border-cyan-300/40 px-4 text-sm text-cyan-100 disabled:opacity-40">{playState === 'paused' ? <Play className="h-4 w-4" /> : <Pause className="h-4 w-4" />}{playState === 'paused' ? '繼續' : '暫停'}</button><button type="button" onClick={stop} disabled={!run || playState === 'done' || playState === 'stopped'} className="inline-flex h-10 items-center gap-2 rounded-md border border-rose-300/40 px-4 py-2 text-sm text-rose-200 disabled:opacity-40"><Square className="h-4 w-4" />停止</button><button type="button" onClick={reset} className="inline-flex h-10 items-center gap-2 rounded-md border border-slate-600 px-4 py-2 text-sm text-slate-300"><RotateCcw className="h-4 w-4" />重新測試</button>{notice && <span className="text-xs text-amber-200">{notice}</span>}</div></section>
      <section className="order-first rounded-xl border border-cyan-300/40 bg-slate-900/70 p-3 shadow-[0_12px_32px_rgba(8,145,178,.12)] lg:sticky lg:top-3 lg:z-10"><div className="flex flex-wrap items-end justify-between gap-3"><div><div className="text-xs text-slate-400">目前階段</div><div className="mt-1 text-lg font-semibold text-cyan-100">{phase}</div></div><div className="text-right text-xs text-slate-400"><div>{revealedRounds.toLocaleString()} / {targetResultCount.toLocaleString()} 局 · {(progress * 100).toFixed(1)}%</div><div>目前處理速度 {speed.toLocaleString()} 局／秒 · 已執行 {(activeElapsed / 1000).toFixed(1)} 秒</div></div></div><div className="mt-3 h-2 overflow-hidden rounded-full bg-slate-800"><div className="h-full rounded-full bg-gradient-to-r from-cyan-500 to-emerald-400 transition-[width]" style={{ width: `${progress * 100}%` }} /></div><div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4"><div className="rounded-lg border border-slate-700 bg-slate-950/50 px-3 py-2"><div className="text-[10px] text-slate-500">已揭露局數</div><div className="mt-1 text-base font-semibold text-cyan-100">{revealedRounds.toLocaleString()} / {targetResultCount.toLocaleString()}</div></div><div className="rounded-lg border border-slate-700 bg-slate-950/50 px-3 py-2"><div className="text-[10px] text-slate-500">完成進度</div><div className="mt-1 text-base font-semibold text-emerald-300">{(progress * 100).toFixed(1)}%</div></div><div className="rounded-lg border border-slate-700 bg-slate-950/50 px-3 py-2"><div className="text-[10px] text-slate-500">處理速度</div><div className="mt-1 text-base font-semibold text-cyan-100">{speed.toLocaleString()} 局／秒</div></div><div className="rounded-lg border border-slate-700 bg-slate-950/50 px-3 py-2"><div className="text-[10px] text-slate-500">執行時間</div><div className="mt-1 text-base font-semibold text-slate-200">{(activeElapsed / 1000).toFixed(1)} 秒</div></div></div></section>
      <div className="grid gap-4"><ResultsRoad results={actualResults} label="實際結果路單" /></div>
      <section className="rounded-xl border border-cyan-300/20 bg-slate-900/50 p-3"><div className="mb-3 flex flex-wrap items-center justify-between gap-2"><h2 className="font-semibold text-cyan-100">牌卡分析與目前排名</h2><span className="text-xs text-slate-500">依近期表現動態排名 · Timeout 僅適用 AI 牌卡</span></div><div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">{ranking.map((item, index) => <article key={item.target.id} className={`rounded-lg border p-2 transition-all duration-500 ${index === 0 && item.valid > 0 ? 'border-amber-300/60 bg-amber-300/10' : 'border-slate-700 bg-slate-950/30'}`}><div className="flex items-center justify-between gap-2"><div className="flex items-center gap-2 text-sm font-semibold text-white">{index < 3 && <><Trophy className={`h-4 w-4 ${index === 0 ? 'text-amber-300' : index === 1 ? 'text-slate-300' : 'text-orange-300'}`} /><span className="text-xs text-slate-400">第{index + 1}名</span></>}{item.target.name}</div><span className="text-base font-bold text-white">{item.valid ? `${(item.accuracy * 100).toFixed(1)}%` : '資料累積中'}</span></div><div className="mt-2 h-1.5 overflow-hidden rounded-full bg-slate-800"><div className="h-full bg-cyan-400 transition-[width]" style={{ width: `${item.accuracy * 100}%` }} /></div><div className="mt-2 grid grid-cols-4 gap-1 text-[10px] text-slate-400"><span>有效 {item.valid}</span><span>錯誤 {item.wrong}</span><span className={item.target.kind === '圖形' ? 'invisible' : ''} aria-hidden={item.target.kind === '圖形'}>Timeout {item.timeout}</span><span className={item.target.kind === 'AI' ? 'invisible' : ''} aria-hidden={item.target.kind === 'AI'}>未出訊號 {item.noSignal}</span></div></article>)}</div></section>
      <section className="rounded-xl border border-cyan-300/20 bg-slate-900/50 p-3"><div className="mb-3 flex flex-wrap items-center justify-between gap-2"><h2 className="font-semibold text-cyan-100">近期逐局紀錄</h2><span className="text-xs text-slate-500">已保留完整資料 · 畫面顯示最近 40 筆</span></div><div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(360px,0.85fr)]"><div className="max-h-48 overflow-auto"><table className="w-full min-w-[640px] text-left text-xs"><thead className="sticky top-0 bg-slate-950 text-slate-400"><tr><th className="px-2 py-2">局號</th><th className="px-2 py-2">牌卡</th><th className="px-2 py-2">預測</th><th className="px-2 py-2">實際</th><th className="px-2 py-2">判定</th><th className="px-2 py-2">處理耗時</th></tr></thead><tbody>{revealedRecords.slice(-40).map((record, index) => <tr key={`${record.roundId}-${record.targetId}-${index}`} className="border-t border-slate-800"><td className="px-2 py-1 text-slate-400">{record.roundId}</td><td className="px-2 py-1.5 text-slate-200">{record.targetName}</td><td className="px-2 py-1.5" style={{ color: record.prediction ? RESULT_COLORS[record.prediction] : '#94a3b8' }}>{record.prediction ?? '—'}</td><td className="px-2 py-1.5" style={{ color: RESULT_COLORS[record.actualResult] }}>{record.actualResult}</td><td className={`px-2 py-1.5 ${statusTone[record.status]}`}>{statusLabel[record.status]}</td><td className="px-2 py-1.5 text-slate-400">{record.simulatedLatencyMs ? `${record.simulatedLatencyMs} ms` : '—'}</td></tr>)}</tbody></table>{revealedRecords.length === 0 && <p className="py-8 text-center text-xs text-slate-500">開始後會逐批顯示紀錄。</p>}</div><AccuracyLineChart records={revealedRecords} targets={targets} /></div></section>
      {snapshot && <section className="rounded-xl border border-emerald-300/30 bg-emerald-400/5 p-3"><div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="font-semibold text-emerald-200">回歸報告已完成</h2><p className="mt-1 text-xs text-slate-400">{snapshot.completed ? '本次回歸測試完整完成' : `本次回歸測試已停止於 ${revealedRounds.toLocaleString()} 局`} · 報告使用同一份結果快照</p></div><div className="flex flex-wrap gap-2"><button type="button" onClick={() => downloadReport('html')} className="inline-flex items-center gap-1.5 rounded border border-emerald-300/40 px-3 py-2 text-xs text-emerald-100"><FileText className="h-4 w-4" />下載 HTML</button><button type="button" onClick={() => downloadReport('csv')} className="inline-flex items-center gap-1.5 rounded border border-emerald-300/40 px-3 py-2 text-xs text-emerald-100"><Download className="h-4 w-4" />下載 CSV</button><button type="button" onClick={() => downloadReport('json')} className="inline-flex items-center gap-1.5 rounded border border-emerald-300/40 px-3 py-2 text-xs text-emerald-100"><FileJson className="h-4 w-4" />下載 JSON</button></div></div></section>}
    </div>
  </section>;
}

export { RegressionTest };
