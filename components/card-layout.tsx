'use client';

import type { ChangeEvent } from 'react';

export const CARD_LAYOUT_OPTIONS = [1, 2, 3, 4, 5, 6] as const;
export type CardColumns = (typeof CARD_LAYOUT_OPTIONS)[number];

/** Responsive grid classes shared by the live and focused-table views. */
export const cardGridColumns: Record<CardColumns, string> = {
  1: 'grid-cols-1',
  2: 'grid-cols-1 sm:grid-cols-2',
  3: 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3',
  4: 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-4',
  5: 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5',
  6: 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6',
};

export function CardLayoutSelect({ value, onChange }: { value: CardColumns; onChange: (value: CardColumns) => void }) {
  const handleChange = (event: ChangeEvent<HTMLSelectElement>) => {
    onChange(Number(event.target.value) as CardColumns);
  };

  return (
    <label className="flex items-center gap-2 text-xs text-slate-300">
      <span>牌卡大小</span>
      <select
        value={value}
        onChange={handleChange}
        aria-label="選擇每列牌卡數量"
        className="h-8 rounded-md border border-cyan-300/65 bg-cyan-950/70 px-2.5 text-xs font-semibold text-cyan-100 outline-none focus:ring-2 focus:ring-cyan-300/40"
      >
        {CARD_LAYOUT_OPTIONS.map(option => <option key={option} value={option}>{option} 張／列</option>)}
      </select>
    </label>
  );
}
