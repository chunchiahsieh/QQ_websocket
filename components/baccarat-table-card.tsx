"use client";
import { memo, useCallback, useEffect, useRef, useState } from "react";
import { CheckCircle2, Crown } from "lucide-react";
import { BaccaratRoad } from "@/components/baccarat-road";
import { TableCountdown } from "@/components/table-countdown";
import { DealerVideo } from "@/components/dealer-video";
import { AiPredictionCard } from "@/components/ai-prediction-card";
import type { AiSource } from "@/lib/ai-consensus";
import { GraphicalCard } from "@/components/graphical-card";
import { PointAnalysisCard } from "@/components/point-analysis-card";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { StatisticalCard } from "@/components/statistical-card";
import { WeightedConsensusCard } from "@/components/weighted-consensus-card";
import { CardPicker, type CardMode } from "@/components/card-picker";
import { RoadStrategyCard } from "@/components/road-strategy-card";
import { tableOverlayLabel, type TablePhase } from "@/lib/table-state";
import { beadWinners } from "@/lib/statistical-cards";
import {
  bettingStrategyLabels,
  initialBettingLedger,
  replayBets,
  settleBet,
  type BetSide,
  type BettingLedger,
  type BettingStrategy,
} from "@/lib/betting-strategy";
import type { PredictionDecision } from "@/lib/prediction-performance";
import {
  actionStrategyLabels,
  applyActionStrategy,
  defaultActionConfig,
  shouldAct,
  type ActionConfig,
  type ActionStrategy,
} from "@/lib/action-strategy";
export type TableInfo = {
  videoUrl?: string;
  tablePhase?: TablePhase | null;
  tableState?: string;
  countdownDeadline?: number;
  countdownReceivedAt?: number;
  countdownValue?: number;
  countdownRound?: string;
  countdownSource?: "wait" | "snapshot" | "explicit" | "end";
  dealerPhoto?: string;
  id: string;
  name: string;
  gameType: string;
  dealer: string;
  room: string;
  shoe: string;
  round: string;
  banker: string;
  player: string;
  tie: string;
  players: string;
  beadPlate: string;
  bigRoad: string;
  bigEyeRoad: string;
  smallRoad: string;
  cockroachRoad: string;
};
export type FocusedTableSettings = {
  cardMode: CardMode;
  bettingStrategy: BettingStrategy;
  bettingLedger: BettingLedger;
  lastSettledRound: number;
  pendingPrediction: { round: number; side?: BetSide };
  actionStrategy: ActionStrategy;
  actionConfig: ActionConfig;
};
const roadOnlyModes: CardMode[] = [
  "big",
  "eye",
  "small",
  "cockroach",
  "points",
  "value-distribution",
  "weighted",
  "weighted-consensus",
  "v",
  "cross",
  "chartgpt",
  "gemini",
  "deepseek",
  "claude",
  "ai-consensus",
  "road-follow",
  "road-reverse",
  "road-streak",
  "road-sequence",
  "road-markov",
];
const aiModes: CardMode[] = [
  "chartgpt",
  "gemini",
  "deepseek",
  "claude",
  "ai-consensus",
];
const strategyModes: CardMode[] = [
  "road-follow",
  "road-reverse",
  "road-streak",
  "road-sequence",
  "road-markov",
];
const availableCardModes = new Set<CardMode>([
  "full",
  "bead",
  "big",
  "eye",
  "small",
  "cockroach",
  "points",
  "value-distribution",
  "weighted",
  "weighted-consensus",
  "v",
  "cross",
  "chartgpt",
  "gemini",
  "deepseek",
  "claude",
  "ai-consensus",
  ...strategyModes,
]);

const dealerPhotos: Record<string, string> = {
  艾希: "https://ds.ofalive99.net/static/imagesx/ad/2FMz3PC89Dsp2ZTfvCbL.png",
};
function DealerPortrait({ name, photo }: { name: string; photo?: string }) {
  const source = photo || dealerPhotos[name];
  const [failedSource, setFailedSource] = useState<string>();
  return (
    <div className="relative h-full min-h-0 overflow-hidden bg-slate-200">
      {source && source !== failedSource ? (
        <img
          src={source}
          alt={`荷官 ${name}`}
          loading="lazy"
          referrerPolicy="no-referrer"
          className="absolute inset-0 h-full w-full object-cover object-top"
          onError={() => setFailedSource(source)}
        />
      ) : (
        <div
          className="grid h-full place-items-center text-slate-500"
          aria-label="暫無荷官照片"
        >
          <Crown className="h-9 w-9" strokeWidth={1.4} />
        </div>
      )}
    </div>
  );
}
export const BaccaratTableCard = memo(function BaccaratTableCard({
  table,
  connected,
  beadOnly: initialBeadOnly = false,
  onFocusTable,
  platformLabel,
  storageScope,
  highlightShoeProfit = false,
}: {
  table: TableInfo;
  connected: boolean;
  beadOnly?: boolean;
  onFocusTable?: (table: TableInfo, settings?: FocusedTableSettings) => void;
  platformLabel?: string;
  storageScope?: string;
  highlightShoeProfit?: boolean;
}) {
  const resolvedPlatformLabel =
    platformLabel ??
    (table.id.startsWith("DG:")
      ? "DG"
      : table.id.startsWith("AB:")
        ? "歐博"
        : "MT");
  const cardModeStorageKey = `jshen-card-mode:${resolvedPlatformLabel}:${storageScope ?? table.id}`;
  const bettingStorageKey = `jshen-betting:${resolvedPlatformLabel}:${storageScope ?? table.id}`;
  const actionStorageKey = `jshen-action:${resolvedPlatformLabel}:${storageScope ?? table.id}`;
  const [cardMode, setCardMode] = useState<CardMode>(
    initialBeadOnly ? "bead" : "full",
  );
  const [cardNotice, setCardNotice] = useState("");
  const [actionNotice, setActionNotice] = useState("");
  useEffect(() => {
    if (!actionNotice) return;
    const timer = window.setTimeout(() => setActionNotice(""), 3500);
    return () => window.clearTimeout(timer);
  }, [actionNotice]);
  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(
        cardModeStorageKey,
      ) as CardMode | null;
      if (
        stored &&
        availableCardModes.has(stored) &&
        !(
          resolvedPlatformLabel === "DG" &&
          (stored === "points" || stored === "value-distribution")
        )
      )
        setCardMode(stored);
    } catch {
      /* The default card remains available when browser storage is blocked. */
    }
  }, [cardModeStorageKey, resolvedPlatformLabel]);
  const [showDealer, setShowDealer] = useState(true);
  const beadOnly = cardMode === "bead";
  const roadOnly = roadOnlyModes.includes(cardMode);
  const isAiCard = aiModes.includes(cardMode);
  const isStrategyCard = strategyModes.includes(cardMode);
  const isGraphicalCard = cardMode === "v" || cardMode === "cross";
  const isPredictiveCard =
    isAiCard ||
    isStrategyCard ||
    isGraphicalCard ||
    cardMode === "points" ||
    cardMode === "weighted" ||
    cardMode === "weighted-consensus";
  const completedOutcomes = beadWinners(table.beadPlate);
  const completedRoundCount = completedOutcomes.length;
  const [bettingStrategy, setBettingStrategy] =
    useState<BettingStrategy>("flat");
  const [bettingLedger, setBettingLedger] =
    useState<BettingLedger>(initialBettingLedger);
  const [shoeLedger, setShoeLedger] =
    useState<BettingLedger>(initialBettingLedger);
  const [bettingReady, setBettingReady] = useState(false);
  const [actionStrategy, setActionStrategy] =
    useState<ActionStrategy>("always");
  const [actionConfig, setActionConfig] =
    useState<ActionConfig>(defaultActionConfig);
  const [actionDecision, setActionDecision] = useState(false);
  const strategyRef = useRef<BettingStrategy>("flat");
  const ledgerRef = useRef<BettingLedger>(initialBettingLedger());
  const lastSettledRound = useRef(completedRoundCount);
  const pendingPrediction = useRef<{ round: number; side?: BetSide }>({
    round: completedRoundCount,
  });
  const predictionHistory = useRef<PredictionDecision[]>([]);
  const latestPrediction = useRef<{ side?: BetSide; agreement?: number }>({});
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(actionStorageKey);
      if (!raw) return;
      const saved = JSON.parse(raw) as {
        strategy?: ActionStrategy;
        config?: Partial<ActionConfig>;
      };
      if (saved.strategy && Object.hasOwn(actionStrategyLabels, saved.strategy))
        setActionStrategy(saved.strategy);
      if (saved.config)
        setActionConfig({ ...defaultActionConfig, ...saved.config });
    } catch {
      /* Keep the default action strategy. */
    }
  }, [actionStorageKey]);
  const persistBetting = useCallback(
    (strategy: BettingStrategy, ledger: BettingLedger) => {
      try {
        window.localStorage.setItem(
          bettingStorageKey,
          JSON.stringify({
            strategy,
            ledger,
            lastSettledRound: lastSettledRound.current,
            pendingPrediction: pendingPrediction.current,
          }),
        );
      } catch {
        /* Simulation continues in memory. */
      }
    },
    [bettingStorageKey],
  );
  useEffect(() => {
    let strategy: BettingStrategy = "flat";
    let ledger = initialBettingLedger();
    let lastRound = completedRoundCount;
    let pending: { round: number; side?: BetSide } = {
      round: completedRoundCount,
    };
    try {
      const saved = JSON.parse(
        window.localStorage.getItem(bettingStorageKey) || "null",
      ) as {
        strategy?: BettingStrategy;
        ledger?: BettingLedger;
        lastSettledRound?: number;
        pendingPrediction?: { round: number; side?: BetSide };
      } | null;
      if (saved && Object.hasOwn(bettingStrategyLabels, saved.strategy ?? ""))
        strategy = saved.strategy!;
      if (saved?.ledger)
        ledger = {
          ...initialBettingLedger(),
          ...saved.ledger,
          totalStake: Number.isFinite(saved.ledger.totalStake)
            ? saved.ledger.totalStake
            : 0,
        };
      if (Number.isFinite(saved?.lastSettledRound))
        lastRound = saved!.lastSettledRound!;
      if (saved?.pendingPrediction) pending = saved.pendingPrediction;
    } catch {
      /* Use a fresh simulation when stored data is invalid. */
    }
    strategyRef.current = strategy;
    ledgerRef.current = ledger;
    lastSettledRound.current = lastRound;
    pendingPrediction.current = pending;
    setBettingStrategy(strategy);
    setBettingLedger(ledger);
    setBettingReady(true);
  }, [bettingStorageKey]);
  const handlePredictionChange = useCallback(
    (
      side: BetSide | undefined,
      history: PredictionDecision[],
      agreement?: number,
    ) => {
      if (!bettingReady) return;
      predictionHistory.current = history;
      latestPrediction.current = { side, agreement };
      const isConsensus = cardMode === "ai-consensus";
      const replayed = replayBets(
        strategyRef.current,
        applyActionStrategy(actionStrategy, history, actionConfig, isConsensus),
      );
      setShoeLedger((current) =>
        current.profit === replayed.profit &&
        current.bets === replayed.bets &&
        current.nextStake === replayed.nextStake &&
        current.wins === replayed.wins &&
        current.losses === replayed.losses
          ? current
          : replayed,
      );
      const willAct = shouldAct(
        actionStrategy,
        side,
        history,
        actionConfig,
        isConsensus,
        agreement,
      );
      pendingPrediction.current = {
        round: completedRoundCount,
        side: willAct ? side : undefined,
      };
      setActionDecision(willAct);
      persistBetting(strategyRef.current, ledgerRef.current);
    },
    [
      bettingReady,
      completedRoundCount,
      persistBetting,
      actionStrategy,
      actionConfig,
      cardMode,
    ],
  );
  useEffect(() => {
    if (!bettingReady || completedRoundCount <= lastSettledRound.current)
      return;
    const outcome = completedOutcomes.at(-1);
    let next = ledgerRef.current;
    if (outcome && pendingPrediction.current.round === completedRoundCount - 1)
      next = settleBet(
        strategyRef.current,
        next,
        pendingPrediction.current.side,
        outcome,
      );
    lastSettledRound.current = completedRoundCount;
    ledgerRef.current = next;
    setBettingLedger(next);
    persistBetting(strategyRef.current, next);
  }, [bettingReady, completedOutcomes, completedRoundCount, persistBetting]);
  const selectBettingStrategy = (strategy: BettingStrategy) => {
    const ledger = replayBets(
      strategy,
      applyActionStrategy(
        actionStrategy,
        predictionHistory.current,
        actionConfig,
        cardMode === "ai-consensus",
      ),
    );
    strategyRef.current = strategy;
    ledgerRef.current = ledger;
    lastSettledRound.current = completedRoundCount;
    setBettingStrategy(strategy);
    setBettingLedger(ledger);
    setShoeLedger(ledger);
    persistBetting(strategy, ledger);
  };
  const selectActionStrategy = (strategy: ActionStrategy) => {
    if (strategy === "ai-consensus" && cardMode !== "ai-consensus") {
      setCardNotice("702 AI 共識門檻只適用於 AI 共識牌卡。");
      return;
    }
    setActionStrategy(strategy);
    try {
      window.localStorage.setItem(
        actionStorageKey,
        JSON.stringify({ strategy, config: actionConfig }),
      );
    } catch {
      /* Selection remains active in memory. */
    }
    const isConsensus = cardMode === "ai-consensus";
    const ledger = replayBets(
      strategyRef.current,
      applyActionStrategy(
        strategy,
        predictionHistory.current,
        actionConfig,
        isConsensus,
      ),
    );
    const { side, agreement } = latestPrediction.current;
    const willAct = shouldAct(
      strategy,
      side,
      predictionHistory.current,
      actionConfig,
      isConsensus,
      agreement,
    );
    pendingPrediction.current = {
      round: completedRoundCount,
      side: willAct ? side : undefined,
    };
    setActionDecision(willAct);
    ledgerRef.current = ledger;
    setBettingLedger(ledger);
    setShoeLedger(ledger);
    persistBetting(strategyRef.current, ledger);
  };
  const updateActionConfig = (next: ActionConfig) => {
    setActionConfig(next);
    try {
      window.localStorage.setItem(
        actionStorageKey,
        JSON.stringify({ strategy: actionStrategy, config: next }),
      );
    } catch {
      /* Selection remains active in memory. */
    }
    const isConsensus = cardMode === "ai-consensus";
    const ledger = replayBets(
      strategyRef.current,
      applyActionStrategy(
        actionStrategy,
        predictionHistory.current,
        next,
        isConsensus,
      ),
    );
    const { side, agreement } = latestPrediction.current;
    const willAct = shouldAct(
      actionStrategy,
      side,
      predictionHistory.current,
      next,
      isConsensus,
      agreement,
    );
    pendingPrediction.current = {
      round: completedRoundCount,
      side: willAct ? side : undefined,
    };
    setActionDecision(willAct);
    ledgerRef.current = ledger;
    setBettingLedger(ledger);
    setShoeLedger(ledger);
    persistBetting(strategyRef.current, ledger);
  };
  const resetBettingFromNextRound = () => {
    const ledger = initialBettingLedger();
    ledgerRef.current = ledger;
    lastSettledRound.current = completedRoundCount;
    setBettingLedger(ledger);
    persistBetting(strategyRef.current, ledger);
  };
  const roadKind =
    cardMode === "eye"
      ? "eye"
      : cardMode === "small"
        ? "small"
        : cardMode === "cockroach"
          ? "cockroach"
          : "big";
  const roadRaw =
    cardMode === "eye"
      ? table.bigEyeRoad
      : cardMode === "small"
        ? table.smallRoad
        : cardMode === "cockroach"
          ? table.cockroachRoad
          : table.bigRoad;
  const overlayLabel = tableOverlayLabel(
    table.id,
    table.tableState,
    resolvedPlatformLabel,
    table.tablePhase,
  );
  const dealingOverlay = overlayLabel === "開牌中";
  const selectCardMode = (next: CardMode) => {
    if (
      (next === "points" || next === "value-distribution") &&
      resolvedPlatformLabel === "DG"
    ) {
      setCardNotice(
        `DG 沒有逐局勝方點數，無法使用${next === "points" ? "勝方點數分布牌卡" : "數值分布牌卡"}。`,
      );
      return;
    }
    setCardNotice("");
    setCardMode(next);
    try {
      window.localStorage.setItem(cardModeStorageKey, next);
    } catch {
      /* Selection still applies for the current page. */
    }
  };
  return (
    <article
      key={table.id}
      className="ofa-table-card group overflow-hidden border bg-[#12100c] transition hover:border-cyan-300/65"
    >
      <div className="table-card-heading">
        <div className="table-card-heading-left">
          <span className="table-card-label">
            <span>{resolvedPlatformLabel} · 百家樂</span>
            <span>{table.name}</span>
          </span>
          {!table.id.startsWith("AB:") && (
            <span
              className="table-card-players"
              aria-label={`在線人數 ${table.players}`}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true" fill="currentColor">
                <circle cx="12" cy="7" r="4.5" />
                <path d="M3 22v-3a9 9 0 0 1 18 0v3Z" />
              </svg>
              {table.players}
            </span>
          )}
          <TableCountdown
            deadline={table.countdownDeadline}
            receivedAt={table.countdownReceivedAt}
            initialValue={
              resolvedPlatformLabel === "DG" ? table.countdownValue : undefined
            }
            tickMilliseconds={resolvedPlatformLabel === "DG" ? 950 : 1000}
            connected={connected}
            paused={overlayLabel !== null}
          />
        </div>
        <div className="table-card-controls flex items-center gap-1.5">
          <span className="hidden text-[10px] text-slate-400 sm:inline">
            牌卡
          </span>
          <CardPicker
            value={cardMode}
            tableName={table.name}
            onSelect={selectCardMode}
            bettingStrategy={bettingStrategy}
            onBettingStrategySelect={(strategy) => {
              if (!isPredictiveCard) {
                setCardNotice(
                  "下注策略只能套用到會產生下局預測的牌卡，請先選擇圖形、統計、AI 或路單策略牌卡。",
                );
                return;
              }
              selectBettingStrategy(strategy);
            }}
            actionStrategy={actionStrategy}
            onActionStrategySelect={(strategy) => {
              if (!isPredictiveCard) {
                setCardNotice("出手策略只能套用到會產生下局預測的牌卡。");
                return;
              }
              selectActionStrategy(strategy);
            }}
          />
        </div>
        <Dialog
          open={Boolean(cardNotice)}
          onOpenChange={(open) => {
            if (!open) setCardNotice("");
          }}
        >
          <DialogContent
            showCloseButton={false}
            className="border border-cyan-700 bg-[#111c2d] p-6 text-white shadow-2xl"
          >
            <DialogTitle className="text-lg font-bold">
              此平台無法使用該牌卡
            </DialogTitle>
            <DialogDescription className="text-sm leading-6 text-slate-200">
              {cardNotice}
            </DialogDescription>
            <DialogClose className="mt-2 rounded-lg bg-cyan-700 px-4 py-2 text-sm font-semibold text-white hover:bg-cyan-600">
              知道了
            </DialogClose>
          </DialogContent>
        </Dialog>
        <select
          defaultValue=""
          onChange={(event) => {
            const action = event.target.value;
            if (action === "focus" && onFocusTable) {
              onFocusTable(table, {
                cardMode,
                bettingStrategy,
                bettingLedger,
                lastSettledRound: lastSettledRound.current,
                pendingPrediction: pendingPrediction.current,
                actionStrategy,
                actionConfig,
              });
              setActionNotice(table.name);
            } else if (action === "toggle-dealer")
              setShowDealer((value) => !value);
            event.currentTarget.value = "";
          }}
          aria-label={`${table.name}功能`}
          className="table-card-function h-8 rounded-md border border-cyan-300/60 bg-cyan-950/70 px-2 text-xs font-semibold text-cyan-100"
        >
          <option value="">功能</option>
          {onFocusTable && <option value="focus">關注牌桌</option>}
          <option value="toggle-dealer">
            {showDealer ? "隱藏荷官" : "顯示荷官"}
          </option>
        </select>
        {actionNotice && (
          <div
            role="status"
            className="focus-table-toast pointer-events-none fixed left-1/2 top-6 z-[100] flex min-w-72 max-w-[calc(100vw-2rem)] -translate-x-1/2 items-center gap-3 rounded-xl border-2 border-emerald-400 bg-[#112b25] px-5 py-3 text-emerald-50 shadow-[0_16px_42px_rgba(0,0,0,0.55)] ring-4 ring-emerald-400/20"
          >
            <CheckCircle2
              className="h-7 w-7 shrink-0 text-emerald-300"
              strokeWidth={2.25}
            />
            <span className="text-sm font-semibold">
              已將{" "}
              <strong className="text-base font-extrabold text-white">
                {actionNotice}
              </strong>{" "}
              加入關注牌桌
            </span>
          </div>
        )}
        <div className="table-card-totals">
          <span style={{ color: "#e93439" }}>莊 {table.banker}</span>
          <span style={{ color: "#0099dc" }}>閒 {table.player}</span>
          <span style={{ color: "#279854" }}>和 {table.tie}</span>
        </div>
      </div>
      <div
        className={`relative grid aspect-[550/180] bg-white ${!showDealer ? "grid-cols-1" : beadOnly || roadOnly ? "grid-cols-[20%_minmax(0,1fr)]" : "grid-cols-[20%_21.8181818%_minmax(0,1fr)]"}`}
      >
        <div
          className={`relative m-0.5 min-h-0 overflow-hidden rounded-md border-2 border-stone-400 bg-slate-200 ${showDealer ? "" : "hidden"}`}
        >
          <DealerVideo
            source={table.videoUrl}
            connected={connected}
            tableName={table.name}
          >
            <DealerPortrait name={table.dealer} photo={table.dealerPhoto} />
            <div
              title={`房間 ${table.room} · Shoe ${table.shoe} · 第 ${table.round} 把`}
              className="absolute inset-x-0 bottom-0 z-10 bg-gradient-to-r from-purple-800 via-amber-100/90 to-amber-200/80 px-1.5 py-1 text-center text-sm leading-4"
            >
              <span className="block truncate font-bold text-black">
                {table.dealer || "—"}
              </span>
            </div>
          </DealerVideo>
        </div>
        {isStrategyCard ? (
          <RoadStrategyCard
            mode={cardMode}
            platform={
              resolvedPlatformLabel === "歐博"
                ? "AB"
                : (resolvedPlatformLabel as "MT" | "DG")
            }
            tableId={table.id}
            roads={{
              bead: table.beadPlate,
              big: table.bigRoad,
              eye: table.bigEyeRoad,
              small: table.smallRoad,
              cockroach: table.cockroachRoad,
            }}
            onPredictionChange={handlePredictionChange}
          />
        ) : isAiCard ? (
          <AiPredictionCard
            key={cardMode}
            raw={table.bigRoad}
            initialSource={
              cardMode === "ai-consensus" ? undefined : (cardMode as AiSource)
            }
            tableState={
              resolvedPlatformLabel === "DG" ? undefined : table.tableState
            }
            onPredictionChange={handlePredictionChange}
          />
        ) : cardMode === "points" || cardMode === "value-distribution" ? (
          <PointAnalysisCard
            bigRoad={table.bigRoad}
            beadPlate={table.beadPlate}
            distributionOnly={cardMode === "value-distribution"}
            onPredictionChange={handlePredictionChange}
          />
        ) : cardMode === "weighted-consensus" ? (
          <WeightedConsensusCard
            beadPlate={table.beadPlate}
            onPredictionChange={handlePredictionChange}
          />
        ) : cardMode === "weighted" ? (
          <StatisticalCard
            beadPlate={table.beadPlate}
            onPredictionChange={handlePredictionChange}
          />
        ) : isGraphicalCard ? (
          <GraphicalCard
            beadRaw={table.beadPlate}
            fallbackRaw={table.bigRoad}
            mode={cardMode}
            onPredictionChange={handlePredictionChange}
          />
        ) : (
          <>
            {!roadOnly && (
              <div className="min-h-0 min-w-0 overflow-auto">
                <BaccaratRoad raw={table.beadPlate} kind="bead" />
              </div>
            )}
            {!beadOnly && (
              <div
                className={`grid min-h-0 min-w-0 overflow-auto ${roadOnly ? "grid-cols-1" : "grid-rows-[2fr_1fr]"}`}
              >
                {roadOnly ? (
                  <BaccaratRoad raw={roadRaw} kind={roadKind} />
                ) : (
                  <BaccaratRoad raw={table.bigRoad} kind="big" />
                )}
                {!roadOnly && (
                  <div className="grid min-h-0 min-w-0 grid-cols-3">
                    <BaccaratRoad raw={table.bigEyeRoad} kind="eye" />
                    <BaccaratRoad raw={table.smallRoad} kind="small" />
                    <BaccaratRoad raw={table.cockroachRoad} kind="cockroach" />
                  </div>
                )}
              </div>
            )}
          </>
        )}
        {overlayLabel && connected && (
          <div
            role="status"
            aria-label={overlayLabel}
            className={`pointer-events-none absolute inset-y-0 left-[20%] right-0 z-10 grid place-items-center ${dealingOverlay ? "bg-amber-600/35" : "bg-sky-500/40"}`}
          >
            <span
              className="text-4xl font-black text-white"
              style={{
                textShadow: dealingOverlay
                  ? "0 2px 0 #78350f, 2px 0 0 #78350f, -2px 0 0 #78350f, 0 -2px 0 #78350f"
                  : "0 2px 0 #087eb9, 2px 0 0 #087eb9, -2px 0 0 #087eb9, 0 -2px 0 #087eb9",
              }}
            >
              {overlayLabel}
            </span>
          </div>
        )}
      </div>
      {isPredictiveCard && (
        <div className="border-t border-slate-600/70 bg-slate-950/95 px-1.5 py-1 text-[10px] text-slate-200 sm:px-2">
          <div className="flex items-center gap-2 overflow-x-auto whitespace-nowrap pb-1">
            <label className="text-slate-300">
              下注：
              <select
                value={bettingStrategy}
                onChange={(event) =>
                  selectBettingStrategy(event.target.value as BettingStrategy)
                }
                className="rounded border border-amber-400/70 bg-slate-900 px-1 py-0.5 font-bold text-amber-200"
              >
                {Object.entries(bettingStrategyLabels).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <span className="text-slate-300">
              下一注：
              <strong className="font-bold text-amber-200">
                {bettingLedger.nextStake} 單位
              </strong>
            </span>
            <span
              className="h-4 border-l border-slate-600"
              aria-hidden="true"
            />
            <label className="text-slate-300">
              出手：
              <select
                value={actionStrategy}
                onChange={(event) =>
                  selectActionStrategy(event.target.value as ActionStrategy)
                }
                className="rounded border border-violet-400/70 bg-slate-900 px-1 py-0.5 font-bold text-violet-200"
              >
                {Object.entries(actionStrategyLabels).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <span className="text-slate-300">
              結果：
              <strong
                className={
                  actionDecision
                    ? "font-bold text-emerald-300"
                    : "font-bold text-orange-300"
                }
              >
                {actionDecision ? "出手" : "不出手"}
              </strong>
            </span>
          </div>
          <div className="flex items-center gap-2 overflow-x-auto whitespace-nowrap border-t border-slate-700/70 pt-1">
            <span className={`rounded border px-1.5 py-0.5 ${highlightShoeProfit ? "border-emerald-400/45 bg-emerald-400/10" : "border-slate-600/70 bg-slate-900/70"}`}>
              本靴：
              <strong
                className={
                  `${shoeLedger.profit >= 0 ? "text-emerald-300" : "text-rose-300"} ${highlightShoeProfit ? "mx-1 text-xl font-black tracking-wide drop-shadow-[0_0_8px_rgba(52,211,153,.35)]" : ""}`
                }
              >
                {shoeLedger.profit >= 0 ? "+" : ""}
                {shoeLedger.profit.toFixed(2)}{highlightShoeProfit ? " 注" : ""}
              </strong>{" "}
              · {shoeLedger.bets} 注（{shoeLedger.wins}勝／{shoeLedger.losses}
              負）
            </span>
            <span className="rounded border border-slate-600/70 bg-slate-900/70 px-1.5 py-0.5">
              重置後：
              <strong
                className={
                  bettingLedger.profit >= 0
                    ? "text-emerald-300"
                    : "text-rose-300"
                }
              >
                {bettingLedger.profit >= 0 ? "+" : ""}
                {bettingLedger.profit.toFixed(2)}
              </strong>{" "}
              · {bettingLedger.bets} 注（{bettingLedger.wins}勝／
              {bettingLedger.losses}負）
            </span>
            <button
              type="button"
              onClick={resetBettingFromNextRound}
              className="ml-auto shrink-0 rounded border border-amber-300/50 px-1.5 py-0.5 text-amber-100 hover:bg-amber-300/10"
            >
              重置
            </button>
          </div>
        </div>
      )}
    </article>
  );
});
