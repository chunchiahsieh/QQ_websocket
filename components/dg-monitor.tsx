'use client';
import { useEffect, useState } from 'react';
import { dgCard, type LiveDgTable } from '@/lib/dg-card';
import { readJsonResponse } from '@/lib/safe-response-json';
import { BaccaratTableCard, type TableInfo } from '@/components/baccarat-table-card';
import { CardLayoutSelect, cardGridColumns, type CardColumns } from '@/components/card-layout';

export function DgMonitor({ gameUrl, collector = false, onStatus, onTables, onFocusTable, cardColumns, onCardColumnsChange }: { gameUrl?: string | null; collector?: boolean; onStatus: (status: 'connecting' | 'connected' | 'error') => void; onTables?: (tables: TableInfo[]) => void; onFocusTable?: (table: TableInfo) => void; cardColumns: CardColumns; onCardColumnsChange: (value: CardColumns) => void }) {
  const [tables, setTables] = useState<LiveDgTable[]>([]);
  const [connected, setConnected] = useState(false);
  const [updatedAt, setUpdatedAt] = useState('');
  const [message, setMessage] = useState('正在連接 DG…');
  useEffect(() => {
    const abort = new AbortController();
    let socket: WebSocket | undefined;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let retryAttempt = 0;
    const waitBeforeRetry = (delay: number) => new Promise<void>(resolve => {
      retryTimer = setTimeout(resolve, delay);
      abort.signal.addEventListener('abort', () => {
        if (retryTimer) clearTimeout(retryTimer);
        resolve();
      }, { once: true });
    });
    const connect = async () => {
      while (!abort.signal.aborted) {
        let settled = false;
        try {
          setConnected(false); onStatus('connecting');
          setMessage(collector ? '正在連接 DG 採集端…' : '正在取得 DG 桌況…');
          const response = await fetch('/api/dg/start', {
            method: 'POST', signal: abort.signal, cache: 'no-store',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ gameUrl: gameUrl || undefined, collector }),
          });
          const result = await readJsonResponse<{ wsUrl?: string; ticket?: string; message?: string }>(response);
          if (!response.ok || !result.wsUrl || !result.ticket) throw new Error(result.message || 'DG 工作階段建立失敗。');
          if (abort.signal.aborted) break;
          await new Promise<void>(resolve => {
            const finish = () => { if (!settled) { settled = true; resolve(); } };
            socket = new WebSocket(result.wsUrl!);
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
                  setMessage('DG 重新連線中…'); return;
                }
                if (data.type === 'error') {
                  setConnected(false); onStatus('connecting'); setTables([]);
                  setMessage(data.message || 'DG 串流錯誤，正在重試…');
                  socket?.close(); return;
                }
                if (data.type === 'status') setMessage('正在取得 DG 桌況…');
                if (data.type === 'tables' && Array.isArray(data.tables) && data.tables.length) {
                  retryAttempt = 0;
                  onStatus('connected'); setConnected(true); setUpdatedAt(new Date().toLocaleTimeString('zh-TW', { hour12: false }));
                  setMessage('DG 即時連線中');
                  setTables(current => {
                    const next = new Map((data.snapshot ? [] : current).map((table: LiveDgTable) => [table.tableId, table]));
                    for (const table of data.tables as LiveDgTable[]) {
                      if (table.tableId) next.set(table.tableId, { ...next.get(table.tableId), ...table,
                        ...(table.countDown != null && table.receivedAt != null ? { countdownDeadline: table.receivedAt + Math.max(0, table.countDown) * 1000 } : {}) });
                    }
                    const updated = [...next.values()].sort((a, b) => (a.tableName || '').localeCompare(b.tableName || '', undefined, { numeric: true }));
                    onTables?.(updated.map(dgCard));
                    return updated;
                  });
                }
              } catch {
                setConnected(false); onStatus('connecting'); setMessage('DG JSON 資料解析失敗，正在重試…');
                socket?.close();
              }
            };
            socket.onerror = finish;
            socket.onclose = finish;
          });
        } catch (error) {
          if (abort.signal.aborted) break;
          setConnected(false); onStatus('connecting');
          setMessage(error instanceof Error ? `${error.message} 正在重試…` : 'DG 連線失敗，正在重試…');
        } finally {
          socket?.close(); socket = undefined;
        }
        if (abort.signal.aborted) break;
        const delay = Math.min(5000 * (2 ** retryAttempt), 30000);
        retryAttempt = Math.min(retryAttempt + 1, 4);
        setConnected(false); onStatus('connecting'); setMessage('DG 重新連線中…');
        await waitBeforeRetry(delay);
      }
    };
    void connect();
    return () => { abort.abort(); if (retryTimer) clearTimeout(retryTimer); socket?.close(); };
  }, [collector, gameUrl, onStatus, onTables]);
  return <section className="overflow-hidden rounded-2xl border border-[#86632f]/35 bg-[#0d0b08]/92">
     <header className="flex flex-wrap items-center justify-between gap-3 border-b border-[#5d451f]/60 px-6 py-4">
       <div><h2 className="text-lg font-semibold">即時桌況 <span className="ml-2 rounded-md border px-2 py-0.5 text-xs">{tables.length} 桌</span></h2>
       <p className="mt-1 text-xs">{connected ? `最後更新 ${updatedAt}` : message}</p></div>
       <CardLayoutSelect value={cardColumns} onChange={onCardColumnsChange} />
     </header>
     <div className={`grid w-full min-w-0 gap-3 bg-transparent p-2 ${cardGridColumns[cardColumns]}`}>
      {tables.map(table => <BaccaratTableCard key={table.tableId} table={dgCard(table)} connected={connected} platformLabel="DG" onFocusTable={onFocusTable} />)}
    </div>
  </section>;
}
