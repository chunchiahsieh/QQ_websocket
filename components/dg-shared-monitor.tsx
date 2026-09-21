'use client';

import { BaccaratTableCard, type TableInfo } from '@/components/baccarat-table-card';
import { CardLayoutSelect, cardGridColumns, type CardColumns } from '@/components/card-layout';

export function DgSharedMonitor({ tables, connected, message, updatedAt, onFocusTable, cardColumns, onCardColumnsChange, platformLabel = 'DG' }: {
  tables: TableInfo[]; connected: boolean; message: string; updatedAt: string; onFocusTable?: (table: TableInfo) => void;
  cardColumns: CardColumns; onCardColumnsChange: (value: CardColumns) => void; platformLabel?: 'DG' | '歐博';
}) {
  return <section className="overflow-hidden rounded-2xl border border-[#86632f]/35 bg-[#0d0b08]/92">
    <header className="flex flex-wrap items-center justify-between gap-3 border-b border-[#5d451f]/60 px-6 py-4">
      <div><h2 className="text-lg font-semibold">即時桌況 <span className="ml-2 rounded-md border px-2 py-0.5 text-xs">{tables.length} 桌</span></h2>
        <p className="mt-1 text-xs">{connected ? `最後更新 ${updatedAt}` : message}</p></div>
      <CardLayoutSelect value={cardColumns} onChange={onCardColumnsChange} />
    </header>
    <div className={`grid w-full min-w-0 gap-3 bg-transparent p-2 ${cardGridColumns[cardColumns]}`}>
      {tables.map(table => <BaccaratTableCard key={table.id} table={table} connected={connected} platformLabel={platformLabel} onFocusTable={onFocusTable} />)}
    </div>
  </section>;
}
