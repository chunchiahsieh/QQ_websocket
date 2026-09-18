'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
type Player = ReturnType<(typeof import('mpegts.js'))['default']['createPlayer']>;

export function DealerVideo({ source, connected, tableName, children }: {
  source?: string; connected: boolean; tableName: string; children: ReactNode;
}) {
  const [enabled, setEnabled] = useState(false);
  const [state, setState] = useState<'loading' | 'playing' | 'error'>('loading');
  const video = useRef<HTMLVideoElement>(null);
  const active = enabled && connected && Boolean(source);
  useEffect(() => {
    if (!active || !source || !video.current) return;
    const element = video.current;
    let cancelled = false;
    let failed = false;
    let player: Player | undefined;
    setState('loading');
    const dispose = () => {
      if (player) {
        player.destroy();
        player = undefined;
      }
    };
    const fail = () => {
      if (cancelled) return;
      failed = true;
      clearTimeout(timeout);
      setState('error');
      dispose();
    };
    const timeout = setTimeout(fail, 15000);
    const playing = () => { clearTimeout(timeout); setState('playing'); };
    element.addEventListener('playing', playing);
    void import('mpegts.js').then(({ default: mpegts }) => {
      if (cancelled || failed) return;
      if (!mpegts.getFeatureList().mseLivePlayback) { fail(); return; }
      player = mpegts.createPlayer({ type: 'flv', isLive: true, url: source }, {
        enableWorker: false, enableStashBuffer: false,
        liveBufferLatencyChasing: true, autoCleanupSourceBuffer: true,
      });
      player.on(mpegts.Events.ERROR, fail);
      player.attachMediaElement(element);
      player.load();
      player.play()?.catch(fail);
    }).catch(fail);
    return () => {
      cancelled = true;
      clearTimeout(timeout);
      element.removeEventListener('playing', playing);
      dispose();
      element.removeAttribute('src');
      element.load();
    };
  }, [active, source]);
  return <div className="flex h-full min-h-0 flex-col">
    <div className="relative min-h-0 flex-1 overflow-hidden">
      {children}
      {active && <video ref={video} autoPlay muted playsInline aria-label={`百家樂 ${tableName} 即時視訊`}
        className="absolute inset-0 h-full w-full bg-black object-cover" />}
      {active && state !== 'playing' && <div role="status" className="absolute inset-0 grid place-items-center bg-black/75 p-2 text-center text-xs text-white">
        {state === 'loading' ? '視訊載入中…' : '視訊無法播放，請關閉後重試'}
      </div>}
    </div>
    <div className="flex h-6 shrink-0 items-center justify-between gap-1 bg-stone-100 px-1.5 text-[10px] text-slate-600">
      <span>{active ? '即時視訊' : '視訊'}</span>
      <button type="button" role="switch" aria-checked={active} aria-label={`百家樂 ${tableName} 視訊`}
        disabled={!source || !connected} title={!source ? '平台尚未提供視訊來源' : !connected ? '請先恢復連線' : '切換荷官照片與即時視訊'}
        onClick={() => setEnabled(value => !value)}
        className={`relative h-3.5 w-7 shrink-0 rounded-full transition-colors disabled:opacity-40 ${active ? 'bg-emerald-500' : 'bg-slate-500'}`}>
        <span className={`absolute top-0.5 h-2.5 w-2.5 rounded-full bg-white transition-transform ${active ? 'left-0.5 translate-x-3.5' : 'left-0.5'}`} />
      </button>
    </div>
  </div>;
}
