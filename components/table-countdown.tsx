'use client';

import { useEffect, useState } from 'react';
import { Clock } from 'lucide-react';

// Only this small badge ticks; the road grids do not need a timer-driven render.
export function TableCountdown({ deadline, receivedAt, connected, shuffling }: {
  deadline?: number; receivedAt?: number; connected: boolean; shuffling: boolean;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!connected || deadline === undefined) return;
    const refresh = () => setNow(Date.now());
    refresh();
    const timer = window.setInterval(refresh, 250);
    return () => window.clearInterval(timer);
  }, [connected, deadline]);
  const stale = !connected || (deadline === undefined && !receivedAt);
  const seconds = shuffling && connected ? 0 : stale || deadline === undefined
    ? null : Math.max(0, Math.ceil((deadline - now) / 1000));
  return <span aria-label={seconds === null ? '倒數尚未同步' : `倒數 ${seconds} 秒`}
    title={seconds === null ? '等待平台倒數資料' : '平台倒數秒數'}
    className={`table-card-countdown inline-flex items-center justify-center rounded border px-1 font-mono tabular-nums ${seconds === null ? 'border-slate-500 text-slate-400' : seconds > 0 ? 'border-lime-500 text-lime-400' : 'border-red-500 text-red-500'}`}>
    <Clock aria-hidden="true" className="shrink-0" style={{ width: '1em', height: '1em' }} strokeWidth={1.8} />
    <span>{seconds ?? '—'}</span>
  </span>;
}
