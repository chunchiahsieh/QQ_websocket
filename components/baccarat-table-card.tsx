'use client';
import { memo, useState } from 'react';
import { Crown } from 'lucide-react';
import { BaccaratRoad } from '@/components/baccarat-road';
import { TableCountdown } from '@/components/table-countdown';
import { DealerVideo } from '@/components/dealer-video';
import { AiPredictionCard, type AiProvider } from '@/components/ai-prediction-card';
import { GraphicalCard } from '@/components/graphical-card';
import { tableOverlayLabel, type TablePhase } from '@/lib/table-state';
export type TableInfo = {
  videoUrl?: string;
  tablePhase?: TablePhase | null;
  tableState?: string; countdownDeadline?: number; countdownReceivedAt?: number;
  countdownValue?: number; countdownRound?: string;
  countdownSource?: 'wait' | 'snapshot' | 'explicit' | 'end';
  dealerPhoto?: string;
  id: string; name: string; gameType: string; dealer: string; room: string; shoe: string; round: string;
  banker: string; player: string; tie: string; players: string;
  beadPlate: string; bigRoad: string; bigEyeRoad: string; smallRoad: string; cockroachRoad: string;
};
type CardMode = 'full' | 'bead' | 'big' | 'eye' | 'small' | 'cockroach' | 'v3' | 'v5' | 'cross' | 'chartgpt' | 'gemini' | 'deepseek' | 'claude';
const roadOnlyModes: CardMode[] = ['big', 'eye', 'small', 'cockroach', 'v3', 'v5', 'cross', 'chartgpt', 'gemini', 'deepseek', 'claude'];
const aiModes: AiProvider[] = ['chartgpt', 'gemini', 'deepseek', 'claude'];

const dealerPhotos: Record<string,string> = {'艾希':'https://ds.ofalive99.net/static/imagesx/ad/2FMz3PC89Dsp2ZTfvCbL.png'};
function DealerPortrait({ name, photo }: { name: string; photo?: string }) {
  const source = photo || dealerPhotos[name];
  const [failedSource, setFailedSource] = useState<string>();
  return (
    <div className="relative h-full min-h-0 overflow-hidden bg-slate-200">
      {source && source !== failedSource ? (
        <img src={source} alt={`荷官 ${name}`} loading="lazy" referrerPolicy="no-referrer"
          className="absolute inset-0 h-full w-full object-cover object-top"
          onError={() => setFailedSource(source)} />
      ) : (
        <div className="grid h-full place-items-center text-slate-500" aria-label="暫無荷官照片">
          <Crown className="h-9 w-9" strokeWidth={1.4} />
        </div>
      )}
    </div>
  );
}
export const BaccaratTableCard = memo(function BaccaratTableCard({table, connected, beadOnly: initialBeadOnly = false, onFocusTable, platformLabel}: {table: TableInfo; connected: boolean; beadOnly?: boolean; onFocusTable?: (table: TableInfo) => void; platformLabel?: string}) {
 const [cardMode, setCardMode] = useState<CardMode>(initialBeadOnly ? 'bead' : 'full');
 const [showDealer, setShowDealer] = useState(true);
 const beadOnly = cardMode === 'bead';
 const roadOnly = roadOnlyModes.includes(cardMode);
 const isAiCard = aiModes.includes(cardMode as AiProvider);
 const isGraphicalCard = cardMode === 'v3' || cardMode === 'v5' || cardMode === 'cross';
 const roadKind = cardMode === 'eye' ? 'eye' : cardMode === 'small' ? 'small' : cardMode === 'cockroach' ? 'cockroach' : 'big';
 const roadRaw = cardMode === 'eye' ? table.bigEyeRoad : cardMode === 'small' ? table.smallRoad : cardMode === 'cockroach' ? table.cockroachRoad : table.bigRoad;
 const resolvedPlatformLabel = platformLabel ?? (table.id.startsWith('DG:') ? 'DG' : table.id.startsWith('AB:') ? '歐博' : 'MT');
 const overlayLabel = tableOverlayLabel(table.id, table.tableState, resolvedPlatformLabel, table.tablePhase);
 const dealingOverlay = overlayLabel === '開牌中';
 return (<article key={table.id} className="ofa-table-card group overflow-hidden border bg-[#12100c] transition hover:border-cyan-300/65">
                    <div className="table-card-heading">
                      <div className="table-card-heading-left">
                        <span className="table-card-label"><span>{resolvedPlatformLabel} · 百家樂</span><span>{table.name}</span></span>
                        {!table.id.startsWith('AB:') && <span className="table-card-players" aria-label={`在線人數 ${table.players}`}>
                          <svg viewBox="0 0 24 24" aria-hidden="true" fill="currentColor"><circle cx="12" cy="7" r="4.5" /><path d="M3 22v-3a9 9 0 0 1 18 0v3Z" /></svg>{table.players}
                        </span>}
                        <TableCountdown deadline={table.countdownDeadline} receivedAt={table.countdownReceivedAt}
                          initialValue={resolvedPlatformLabel === 'DG' ? table.countdownValue : undefined}
                          tickMilliseconds={resolvedPlatformLabel === 'DG' ? 950 : 1000}
                          connected={connected} paused={overlayLabel !== null} />
                      </div>
                      <div className="table-card-controls flex items-center gap-1.5"><span className="hidden text-[10px] text-slate-400 sm:inline">牌卡</span><select value={cardMode} onChange={event => setCardMode(event.target.value as CardMode)} aria-label={`${table.name}牌卡樣式`} className="table-card-mode h-8 rounded-md border border-cyan-300/65 bg-cyan-950/70 px-2.5 text-xs font-semibold text-cyan-100 outline-none focus:ring-2 focus:ring-cyan-300/40">
                        <optgroup label="一般牌卡"><option value="full">MT牌卡</option><option value="bead">珠盤牌卡</option><option value="big">大路牌卡</option><option value="eye">大眼牌卡</option><option value="small">小路牌卡</option><option value="cockroach">蟑螂牌卡</option></optgroup>
                        <optgroup label="圖形牌卡"><option value="v3">V型牌卡-3</option><option value="v5">V型牌卡-5</option><option value="cross">十字牌卡</option></optgroup>
                        <optgroup label="AI牌卡"><option value="chartgpt">ChartGPT</option><option value="gemini">Google Gemini</option><option value="deepseek">Deepseek</option><option value="claude">Claude</option></optgroup>
                      </select></div>
                      <select defaultValue="" onChange={event => { const action = event.target.value; if (action === 'focus') onFocusTable?.(table); if (action === 'toggle-dealer') setShowDealer(value => !value); event.currentTarget.value = ''; }} aria-label={`${table.name}功能`} className="table-card-function h-8 rounded-md border border-cyan-300/60 bg-cyan-950/70 px-2 text-xs font-semibold text-cyan-100"><option value="">功能</option>{onFocusTable && <option value="focus">關注牌桌</option>}<option value="toggle-dealer">{showDealer ? '隱藏荷官' : '顯示荷官'}</option></select>
                      <div className="table-card-totals">
                        <span style={{ color: '#e93439' }}>莊 {table.banker}</span>
                        <span style={{ color: '#0099dc' }}>閒 {table.player}</span>
                        <span style={{ color: '#279854' }}>和 {table.tie}</span>
                      </div>
                    </div>
                    <div className={`relative grid aspect-[550/180] bg-white ${!showDealer ? 'grid-cols-1' : beadOnly || roadOnly ? 'grid-cols-[20%_minmax(0,1fr)]' : 'grid-cols-[20%_21.8181818%_minmax(0,1fr)]'}`}>
                      <div className={`relative m-0.5 min-h-0 overflow-hidden rounded-md border-2 border-stone-400 bg-slate-200 ${showDealer ? '' : 'hidden'}`}>
                        <DealerVideo source={table.videoUrl} connected={connected} tableName={table.name}>
                        <DealerPortrait name={table.dealer} photo={table.dealerPhoto} />
                        <div title={`房間 ${table.room} · Shoe ${table.shoe} · 第 ${table.round} 把`} className="absolute inset-x-0 bottom-0 z-10 bg-gradient-to-r from-purple-800 via-amber-100/90 to-amber-200/80 px-1.5 py-1 text-center text-sm leading-4">
                          <span className="block truncate font-bold text-black">{table.dealer || '—'}</span>
                        </div>
                        </DealerVideo>
                      </div>
                       {isAiCard ? <AiPredictionCard raw={table.bigRoad} provider={cardMode as AiProvider} tableState={resolvedPlatformLabel === 'DG' ? undefined : table.tableState} countdownDeadline={table.countdownDeadline} /> : isGraphicalCard ? <GraphicalCard beadRaw={table.beadPlate} fallbackRaw={table.bigRoad} mode={cardMode} /> : <>
                         {!roadOnly && <div className="min-h-0 min-w-0 overflow-auto"><BaccaratRoad raw={table.beadPlate} kind="bead" /></div>}
                         {!beadOnly && <div className={`grid min-h-0 min-w-0 overflow-auto ${roadOnly ? 'grid-cols-1' : 'grid-rows-[2fr_1fr]'}`}>
                           {roadOnly ? <BaccaratRoad raw={roadRaw} kind={roadKind} /> : <BaccaratRoad raw={table.bigRoad} kind="big" />}
                           {!roadOnly && <div className="grid min-h-0 min-w-0 grid-cols-3">
                             <BaccaratRoad raw={table.bigEyeRoad} kind="eye" />
                             <BaccaratRoad raw={table.smallRoad} kind="small" />
                             <BaccaratRoad raw={table.cockroachRoad} kind="cockroach" />
                           </div>}
                         </div>}
                       </>}
                      {overlayLabel && connected && (
                        <div role="status" aria-label={overlayLabel} className={`pointer-events-none absolute inset-y-0 left-[20%] right-0 z-10 grid place-items-center ${dealingOverlay ? 'bg-amber-600/55' : 'bg-sky-500/40'}`}>
                          <span className="text-4xl font-black text-white" style={{ textShadow: dealingOverlay ? '0 2px 0 #78350f, 2px 0 0 #78350f, -2px 0 0 #78350f, 0 -2px 0 #78350f' : '0 2px 0 #087eb9, 2px 0 0 #087eb9, -2px 0 0 #087eb9, 0 -2px 0 #087eb9' }}>{overlayLabel}</span>
                        </div>
                      )}
                    </div>
                  </article>
 );
});
