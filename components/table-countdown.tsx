'use client';

import { memo, useEffect, useRef } from 'react';
import { Clock } from 'lucide-react';
import { remainingCountdownSeconds } from '@/lib/countdown';

// Only this small badge ticks; the road grids do not need a timer-driven render.
export const TableCountdown = memo(function TableCountdown({ deadline, receivedAt, initialValue, tickMilliseconds = 1000, connected, paused }: {
  deadline?: number; receivedAt?: number; initialValue?: number; tickMilliseconds?: number;
  connected: boolean; paused: boolean;
}) {
  const badge = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const refresh = () => {
      const element = badge.current;
      if (!element) return;
      const stale = !connected || (deadline === undefined && !receivedAt);
      const seconds = paused && connected ? 0 : stale ? null
        : remainingCountdownSeconds({ deadline, receivedAt, initialValue, tickMilliseconds, now: Date.now() });
      const value = element.querySelector<HTMLElement>('[data-countdown-value]');
      if (value) value.textContent = seconds === null ? '—' : String(seconds);
      element.setAttribute('aria-label', seconds === null ? '倒數尚未同步' : `倒數 ${seconds} 秒`);
      element.title = seconds === null ? '等待平台倒數資料' : '平台倒數秒數';
      element.className = `table-card-countdown inline-flex items-center justify-center rounded border px-1 font-mono tabular-nums ${seconds === null ? 'border-slate-500 text-slate-400' : seconds > 0 ? 'border-lime-500 text-lime-400' : 'border-red-500 text-red-500'}`;
    };
    refresh();
    // DG's official clock advances about every 950ms. A one-second UI poll
    // can miss that boundary by nearly another full second.
    const timer = window.setInterval(refresh, tickMilliseconds === 950 ? 100 : 1000);
    return () => window.clearInterval(timer);
  }, [connected, deadline, receivedAt, initialValue, tickMilliseconds, paused]);
  return <span ref={badge} aria-label="倒數尚未同步" title="等待平台倒數資料"
    className="table-card-countdown inline-flex items-center justify-center rounded border border-slate-500 px-1 font-mono tabular-nums text-slate-400">
    <Clock aria-hidden="true" className="shrink-0" style={{ width: '1em', height: '1em' }} strokeWidth={1.8} />
    <span data-countdown-value>—</span>
  </span>;
});
