'use client';

import { useEffect, useRef, useState, type UIEvent } from 'react';
import type { AiPredictionRound } from '@/lib/ai-prediction-history';

const sideLabel = (side?: string) => side === '1' ? '閒' : side === '2' ? '莊' : side === '3' ? '和' : '無訊號';
const sideColor = (side?: string) => side === '1' ? '#2563eb' : side === '2' ? '#dc2626' : side === '3' ? '#15803d' : '#64748b';
const originLabel = (round: AiPredictionRound) => round.origin === 'observed' ? '當時紀錄'
  : round.origin === 'replayed' ? '歷史回測' : round.origin === 'pending' ? '待開獎'
    : round.outcome === '3' ? '不計命中／錯誤' : '未保存預測';
// An unrecorded tie has no directional signal to display. Keep its underlying
// record unchanged; never substitute the actual winner for a saved prediction.
const predictionMissing = (round: AiPredictionRound) => round.origin === 'unrecorded' && round.outcome !== '3';
const predictionLabel = (round: AiPredictionRound) => predictionMissing(round) ? '未記錄' : sideLabel(round.prediction);
const roundDescription = (round: AiPredictionRound) =>
  `第 ${round.position} 局，預測${predictionLabel(round)}，實際${round.outcome ? sideLabel(round.outcome) : '待開獎'}，${round.result}，${originLabel(round)}`;

/** Both panels share round positions, including ties and abstentions. */
export function AiPredictionHistory({ rounds, status }: { rounds?: AiPredictionRound[]; status: string }) {
  const actualHost = useRef<HTMLDivElement>(null);
  const predictionHost = useRef<HTMLDivElement>(null);
  const followLatest = useRef(true);
  const [selectedPosition, setSelectedPosition] = useState<number>();
  const lastPosition = rounds?.at(-1)?.position;
  const selected = rounds?.find(round => round.position === selectedPosition)
    ?? rounds?.findLast(round => round.outcome !== undefined) ?? rounds?.at(-1);

  useEffect(() => {
    if (!followLatest.current) return;
    for (const host of [actualHost.current, predictionHost.current]) {
      if (host) host.scrollLeft = host.scrollWidth - host.clientWidth;
    }
  }, [lastPosition]);

  const syncScroll = (event: UIEvent<HTMLDivElement>, other: HTMLDivElement | null) => {
    const host = event.currentTarget;
    followLatest.current = host.scrollWidth - host.clientWidth - host.scrollLeft < 4;
    if (other && Math.abs(other.scrollLeft - host.scrollLeft) > 1) other.scrollLeft = host.scrollLeft;
  };

  return <div className="ai-history-comparison">
    <div className="ai-history-panels">
      {(['actual', 'prediction'] as const).map(kind => <section key={kind} className={`ai-road-panel ai-${kind}-panel ai-history-panel`} aria-label={kind === 'actual' ? '實際路單，依局號排列' : 'AI預測紀錄，依局號排列'}>
        <h3 className="ai-road-heading ai-history-heading">
          <span>{kind === 'actual' ? '實際路單' : 'AI預測'}</span>
          <span className="ai-road-badge">{kind === 'actual' ? '已開獎' : status}</span>
        </h3>
        <div ref={kind === 'actual' ? actualHost : predictionHost} className="ai-history-grid" tabIndex={0} aria-label={kind === 'actual' ? '捲動實際路單紀錄' : '捲動AI預測紀錄'} onScroll={event => syncScroll(event, kind === 'actual' ? predictionHost.current : actualHost.current)}>
          {rounds?.map(round => {
            const side = kind === 'actual' ? round.outcome : round.prediction;
            const pending = round.origin === 'pending';
            const symbol = kind === 'actual' ? round.outcome ? sideLabel(side) : '待'
              : predictionMissing(round) ? '?' : side ? sideLabel(side) : '—';
            const verdict = round.result === '命中' ? '✓' : round.result === '錯誤' ? '×' : round.result === '和局' ? '和' : '';
            return <button type="button" key={round.position} className="ai-history-cell"
              data-selected={round.position === selected?.position} data-origin={round.origin}
              aria-label={roundDescription(round)} aria-pressed={round.position === selected?.position}
              title={roundDescription(round)} onClick={() => setSelectedPosition(round.position)}>
              <svg viewBox="0 0 40 40" aria-hidden="true">
                <text x="2" y="8" fontSize="8" fill="#64748b">{round.position}</text>
                {kind === 'prediction' && round.origin === 'replayed' && <text x="35" y="9" textAnchor="middle" fontSize="11" fill="#92400e">*</text>}
                <circle cx="20" cy="23" r="13" stroke={sideColor(side)} strokeWidth="1.5" strokeDasharray={pending ? '3 2' : undefined} fill={side ? '#fff' : 'none'} />
                <text x="20" y="24" textAnchor="middle" dominantBaseline="central" fontSize="18" fontWeight="700" fill={sideColor(side)}>{symbol}</text>
                {kind === 'prediction' && !pending && <text x="35" y="37" textAnchor="middle" fontSize="10" fontWeight="700" fill={round.result === '命中' ? '#047857' : round.result === '錯誤' ? '#c2410c' : '#64748b'}>{verdict}</text>}
              </svg>
            </button>;
          })}
        </div>
      </section>)}
    </div>
  </div>;
}
