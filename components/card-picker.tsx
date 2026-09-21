'use client';

import { useState } from 'react';
import { Check, ChevronDown } from 'lucide-react';
import { Command, CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command';
import { cardSearch } from '@/lib/card-search';

export type CardMode = 'full' | 'bead' | 'big' | 'eye' | 'small' | 'cockroach'
  | 'points' | 'value-distribution' | 'weighted' | 'weighted-consensus'
  | 'v' | 'cross' | 'chartgpt' | 'gemini' | 'deepseek' | 'claude' | 'ai-consensus'
  | 'road-follow' | 'road-reverse' | 'road-streak' | 'road-sequence' | 'road-markov';

const cardGroups: { code: string; name: string; cards: { code: string; mode: CardMode; name: string }[] }[] = [
  { code: '1', name: '圖形牌卡', cards: [
    { code: '101', mode: 'v', name: 'V型牌卡' }, { code: '102', mode: 'cross', name: '十字牌卡' },
  ] },
  { code: '2', name: '一般牌卡', cards: [
    { code: '201', mode: 'full', name: 'MT牌卡' }, { code: '202', mode: 'bead', name: '珠盤牌卡' },
    { code: '203', mode: 'big', name: '大路牌卡' }, { code: '204', mode: 'eye', name: '大眼牌卡' },
    { code: '205', mode: 'small', name: '小路牌卡' }, { code: '206', mode: 'cockroach', name: '蟑螂牌卡' },
  ] },
  { code: '3', name: '統計牌卡', cards: [
    { code: '301', mode: 'value-distribution', name: '數值分布牌卡' },
    { code: '302', mode: 'points', name: '勝方點數分布牌卡' },
    { code: '303', mode: 'weighted', name: '近局加權牌卡' }, { code: '304', mode: 'weighted-consensus', name: '近局加權共識牌卡' },
  ] },
  { code: '4', name: 'AI牌卡', cards: [
    { code: '401', mode: 'chartgpt', name: 'ChartGPT' }, { code: '402', mode: 'gemini', name: 'Google Gemini' },
    { code: '403', mode: 'deepseek', name: 'Deepseek' }, { code: '404', mode: 'claude', name: 'Claude' },
    { code: '405', mode: 'ai-consensus', name: 'AI共識牌卡' },
  ] },
  { code: '5', name: '路單策略牌卡', cards: [
    { code: '501', mode: 'road-follow', name: '跟路策略牌卡' },
    { code: '502', mode: 'road-reverse', name: '反路策略牌卡' },
    { code: '503', mode: 'road-streak', name: '連莊／連閒策略牌卡' },
    { code: '504', mode: 'road-sequence', name: '序列比對牌卡' },
    { code: '505', mode: 'road-markov', name: '馬可夫轉移牌卡' },
  ] },
];

const cardNames = Object.fromEntries(cardGroups.flatMap(group => group.cards.map(card => [card.mode, card.name]))) as Record<CardMode, string>;

export function CardPicker({ value, tableName, onSelect }: { value: CardMode; tableName: string; onSelect: (mode: CardMode) => void }) {
  const [open, setOpen] = useState(false);
  return <>
    <button type="button" onClick={() => setOpen(true)} title={cardNames[value]}
      aria-label={`${tableName}牌卡樣式，目前${cardNames[value]}`} aria-haspopup="dialog"
      className="table-card-mode inline-flex h-8 max-w-36 items-center gap-1 rounded-md border border-cyan-300/65 bg-cyan-950/70 px-2.5 text-xs font-semibold text-cyan-100 outline-none focus:ring-2 focus:ring-cyan-300/40">
      <span className="min-w-0 truncate">{cardNames[value]}</span><ChevronDown className="h-3 w-3 shrink-0" />
    </button>
    <CommandDialog open={open} onOpenChange={setOpen} title="選擇牌卡" description="輸入分類代號、牌卡代號或名稱"
      className="top-6! translate-y-0! w-[calc(100vw-2rem)] max-h-[calc(100vh-3rem)] max-w-[1320px]! border border-cyan-700 bg-[#111c2d] p-0 text-white shadow-2xl">
      <Command className="bg-[#111c2d] text-white" filter={cardSearch}>
        <div className="px-4 pt-4 text-lg font-bold text-white">選擇牌卡</div>
        <CommandInput placeholder="輸入 1～5、三位代號或名稱…" aria-label="搜尋牌卡" className="text-white placeholder:text-slate-400" />
        <CommandList className="card-picker-list max-h-[calc(100vh-9rem)]">
          <CommandEmpty className="text-slate-400">找不到符合的牌卡</CommandEmpty>
          {cardGroups.map(group => <CommandGroup key={group.code} heading={<span className="text-sm font-bold text-cyan-200">{group.code} · {group.name}</span>}
            className="rounded-xl border border-slate-600 bg-slate-900/80 p-2 text-white">
            {group.cards.map(card => <CommandItem key={card.mode} value={`${group.code}|${card.code}|${group.name}|${card.name}`}
              onSelect={() => { setOpen(false); onSelect(card.mode); }}
              className="mb-1 min-h-11 rounded-lg border border-transparent bg-slate-800/70 px-3 py-2 text-sm font-semibold text-white data-[selected=true]:border-cyan-500 data-[selected=true]:bg-cyan-900 data-[selected=true]:text-white">
              <span className="w-10 shrink-0 rounded bg-cyan-950 px-1.5 py-1 text-center font-mono text-xs text-cyan-200">{card.code}</span>
              <span className="min-w-0 flex-1">{card.name}</span>{value === card.mode && <Check className="ml-auto h-4 w-4 text-cyan-300" aria-label="目前使用" />}
            </CommandItem>)}
          </CommandGroup>)}
        </CommandList>
      </Command>
    </CommandDialog>
  </>;
}
