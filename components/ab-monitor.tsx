'use client';
import { useEffect, useState } from 'react';
import { abCard, type LiveAbTable } from '@/lib/ab-card';
import { BaccaratTableCard, type TableInfo } from '@/components/baccarat-table-card';
import { CardLayoutSelect, cardGridColumns, type CardColumns } from '@/components/card-layout';

export function AbMonitor({ onStatus, onTables, onFocusTable, cardColumns, onCardColumnsChange }: { onStatus: (status: 'connecting' | 'connected' | 'error') => void; onTables?: (tables: TableInfo[]) => void; onFocusTable?: (table: TableInfo) => void; cardColumns: CardColumns; onCardColumnsChange: (value: CardColumns) => void }) {
  const [tables, setTables] = useState<LiveAbTable[]>([]);
  const [connected, setConnected] = useState(false);
  const [updatedAt, setUpdatedAt] = useState('');
  const [message, setMessage] = useState('正在連接 歐博…');
  useEffect(() => {
    const abort = new AbortController();
    let socket: WebSocket | undefined;
    let failed = false;
    const fail = (message: string) => {
      if (abort.signal.aborted) return;
      failed = true; setConnected(false); onStatus('error'); setMessage(message); socket?.close();
    };
    onStatus('connecting');
    void (async () => {
      try {
        const response = await fetch('/api/ab/start', { method: 'POST', signal: abort.signal, cache: 'no-store' });
        const result = await response.json() as { wsUrl?: string; ticket?: string; message?: string };
        if (!response.ok || !result.wsUrl || !result.ticket) throw new Error(result.message || '歐博 工作階段建立失敗。');
        if (abort.signal.aborted) return;
        socket = new WebSocket(result.wsUrl);
        socket.onopen = () => {
          if (abort.signal.aborted) { socket?.close(); return; }
          socket?.send(JSON.stringify({ ticket: result.ticket }));
        };
        socket.onmessage = event => {
          if (abort.signal.aborted) return;
          try {
            const data = JSON.parse(event.data);
            if (data.type === 'reset') {
              setConnected(false); onStatus('connecting'); setTables([]);
              setMessage('歐博 重新連線中…'); return;
            }
            if (data.type === 'error') { fail(data.message || '歐博 串流錯誤。'); return; }
            if (data.type === 'status') setMessage('正在取得 歐博 桌況…');
            if (data.type === 'tables' && Array.isArray(data.tables) && data.tables.length) {
              onStatus('connected'); setConnected(true); setUpdatedAt(new Date().toLocaleTimeString('zh-TW', { hour12: false }));
              setMessage('歐博 即時連線中');
              setTables(current => {
                const next = new Map((data.snapshot ? [] : current).map((table: LiveAbTable) => [table.tableId, table]));
                for (const table of data.tables as LiveAbTable[]) {
                  if (table.tableId) next.set(table.tableId, { ...next.get(table.tableId), ...table,
                    ...(table.countDown != null && table.receivedAt != null ? { countdownDeadline: table.receivedAt + Math.max(0, table.countDown) * 1000 } : {}) });
                }
                const updated = [...next.values()].sort((a, b) => (a.tableName || '').localeCompare(b.tableName || '', undefined, { numeric: true }));
                onTables?.(updated.map(abCard));
                return updated;
              });
            }
          } catch { fail('歐博 JSON 資料解析失敗。'); }
        };
        socket.onerror = () => fail('歐博 連線失敗，請稍後重試。');
        socket.onclose = () => { if (!failed) fail('歐博 工作階段已結束，請切換分頁重試。'); };
      } catch (error) {
        if (!abort.signal.aborted) fail(error instanceof Error ? error.message : '歐博 連線失敗。');
      }
    })();
    return () => { abort.abort(); socket?.close(); };
  }, [onStatus]);
  return <section className="overflow-hidden rounded-2xl border border-[#86632f]/35 bg-[#0d0b08]/92">
     <header className="flex flex-wrap items-center justify-between gap-3 border-b border-[#5d451f]/60 px-6 py-4">
       <div><h2 className="text-lg font-semibold">即時桌況 <span className="ml-2 rounded-md border px-2 py-0.5 text-xs">{tables.length} 桌</span></h2>
       <p className="mt-1 text-xs">{connected ? `最後更新 ${updatedAt}` : message}</p></div>
       <CardLayoutSelect value={cardColumns} onChange={onCardColumnsChange} />
     </header>
     <div className={`grid w-full min-w-0 gap-3 bg-transparent p-2 ${cardGridColumns[cardColumns]}`}>
      {tables.map(table => <BaccaratTableCard key={table.tableId} table={abCard(table)} connected={connected} platformLabel="歐博" onFocusTable={onFocusTable} />)}
    </div>
  </section>;
}
