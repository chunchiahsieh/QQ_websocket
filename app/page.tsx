"use client";

import {
  SyntheticEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  Bell,
  Crown,
  ChevronLeft,
  ChevronRight,
  CircleDot,
  Gift,
  LayoutGrid,
  LoaderCircle,
  LogIn,
  LogOut,
  Users,
} from "lucide-react";
import { BaccaratRoad } from "@/components/baccarat-road";
import { TableCountdown } from "@/components/table-countdown";
import {
  BaccaratTableCard,
  type FocusedTableSettings,
  type TableInfo,
} from "@/components/baccarat-table-card";
import { DgMonitor } from "@/components/dg-monitor";
import { DgSharedMonitor } from "@/components/dg-shared-monitor";
import { AbMonitor } from "@/components/ab-monitor";
import { ContactLinks } from "@/components/contact-links";
import { FloatingBrowser } from "@/components/floating-browser";
import {
  CardLayoutSelect,
  cardGridColumns,
  type CardColumns,
} from "@/components/card-layout";
import { RegressionTest } from "@/components/regression-test";
import { JshenPicks } from "@/components/jshen-picks";
import { AiObservationProvider } from "@/components/ai-observation-provider";
import { filterMtUpdate, mtMergeBase, synchronizeMtClocks } from "@/lib/mt-table-state";
import {
  mtAuthenticateMessage,
  mtMemberMessage,
  mtMultipleJoinMessage,
  mtPingMessage,
  mtSharedChannelKey,
  mtTablesMessage,
  parseMtLaunchUrl,
  readMtWebSocketMessage,
  type MtFrontendConnection,
} from "@/lib/mt-frontend";

type ConnectionStatus =
  "idle" | "connecting" | "authenticating" | "connected" | "error";
type CollectorCredentials = { username: string; password: string };

// The legacy browser AB relay has no usable Render egress. Keep that worker
// disabled; AB viewers use snapshots uploaded by the Windows collector.
const ENABLE_BROWSER_AB = false;

// crypto.randomUUID() is restricted to secure contexts. The LAN demo runs on
// plain HTTP, so keep the same UUID-v4 format with getRandomValues() fallback.
const createBrowserUuid = () => {
  if (typeof globalThis.crypto?.randomUUID === "function")
    return globalThis.crypto.randomUUID();
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

type OfficialGameCode = "MTLI" | "DGLI";

const officialGameLabel = (gameCode: OfficialGameCode) => {
  if (gameCode === "MTLI") return "MT";
  if (gameCode === "DGLI") return "DG";
  return gameCode;
};

/** Exchange the official account token for one platform's short-lived game URL. */
const requestOfficialGameUrl = async (
  baseUrl: string,
  memberToken: string,
  gameCode: OfficialGameCode,
) => {
  const response = await fetch(`${baseUrl}/api/v2/game/${gameCode}/login`, {
    method: "POST",
    mode: "cors",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/plain, */*",
      Authorization: `Bearer ${memberToken}`,
    },
    body: JSON.stringify({
      game_return_url: baseUrl,
      game_kind: "",
      game_type: "",
      game_device: "Desktop",
    }),
  });
  const payload = (await response.json().catch(() => null)) as unknown;
  const data =
    payload &&
    typeof payload === "object" &&
    "data" in payload &&
    payload.data &&
    typeof payload.data === "object"
      ? (payload.data as Record<string, unknown>)
      : {};
  const candidates = [
    data.game_url,
    data.url,
    payload && typeof payload === "object" && "raw" in payload
      ? payload.raw
      : undefined,
  ].filter(
    (value): value is string =>
      typeof value === "string" && value.trim().length > 0,
  );
  const gameUrl = candidates
    .map((value) => value.trim().replace(/\\\//g, "/"))
    .find((value) => {
      try {
        const url = new URL(value);
        return (
          url.searchParams.has("token") || url.searchParams.has("sessionId")
        );
      } catch {
        return false;
      }
    });
  if (
    !response.ok ||
    Number((payload as { code?: unknown } | null)?.code) !== 200 ||
    !gameUrl
  ) {
    const message =
      payload &&
      typeof payload === "object" &&
      "message" in payload &&
      typeof payload.message === "string"
        ? payload.message
        : "";
    throw new Error(
      message ||
        `${officialGameLabel(gameCode)} 遊戲授權取得失敗（HTTP ${response.status}）。`,
    );
  }
  return gameUrl;
};

const payoutPools = [
  {
    code: "GRAND",
    name: "ULTIMATE POWER",
    amount: 323846.67,
    base: 100000,
    cap: 500000,
    color: "from-red-950/90 to-rose-800/70",
    border: "border-amber-300/60",
    menu: "border-red-400/60 bg-red-950/35",
    bar: "bg-red-400",
  },
  {
    code: "MAJOR",
    name: "SUPER POWER",
    amount: 86214.32,
    base: 20000,
    cap: 100000,
    color: "from-fuchsia-950/90 to-purple-800/70",
    border: "border-amber-300/60",
    menu: "border-fuchsia-400/60 bg-fuchsia-950/35",
    bar: "bg-fuchsia-400",
  },
  {
    code: "MINOR",
    name: "EXTRA POWER",
    amount: 12842.58,
    base: 5000,
    cap: 20000,
    color: "from-blue-950/90 to-cyan-800/70",
    border: "border-amber-300/60",
    menu: "border-blue-400/60 bg-blue-950/35",
    bar: "bg-blue-400",
  },
  {
    code: "MINI",
    name: "POWER",
    amount: 2841.16,
    base: 1000,
    cap: 5000,
    color: "from-emerald-950/90 to-green-800/70",
    border: "border-amber-300/60",
    menu: "border-emerald-400/60 bg-emerald-950/35",
    bar: "bg-emerald-400",
  },
] as const;
type PayoutAnnouncement = {
  username?: string;
  categoryCode?: string;
  amount?: number;
  createdAt?: string;
};
type PayoutAnnouncementRow = readonly [string, string, string];

const poolTone = (code: string) => {
  if (code === "GRAND") return "from-red-950/90 to-rose-800/70";
  if (code === "MAJOR") return "from-fuchsia-950/90 to-purple-800/70";
  if (code === "MINOR") return "from-blue-950/90 to-cyan-800/70";
  return "from-emerald-950/90 to-green-800/70";
};
const poolTextTone = (code: string) => {
  if (code === "GRAND") return "text-red-200";
  if (code === "MAJOR") return "text-fuchsia-200";
  if (code === "MINOR") return "text-blue-200";
  return "text-emerald-200";
};
const poolCardTone = (code: string) => {
  if (code === "GRAND")
    return "border-red-400/60 from-red-950/90 to-rose-800/70";
  if (code === "MAJOR")
    return "border-fuchsia-400/60 from-fuchsia-950/90 to-purple-800/70";
  if (code === "MINOR")
    return "border-blue-400/60 from-blue-950/90 to-cyan-800/70";
  return "border-emerald-400/60 from-emerald-950/90 to-green-800/70";
};
const poolBarTone = (code: string) => {
  if (code === "GRAND") return "bg-red-400";
  if (code === "MAJOR") return "bg-fuchsia-400";
  if (code === "MINOR") return "bg-blue-400";
  return "bg-emerald-400";
};
const announcementTone = (code: string) => {
  if (code === "GRAND") return "border-red-400/35 bg-red-950/20 text-red-100";
  if (code === "MAJOR")
    return "border-fuchsia-400/35 bg-fuchsia-950/20 text-fuchsia-100";
  if (code === "MINOR")
    return "border-blue-400/35 bg-blue-950/20 text-blue-100";
  return "border-emerald-400/35 bg-emerald-950/20 text-emerald-100";
};
const taipeiOnlineUsers = () => {
  const parts = new Intl.DateTimeFormat("zh-TW", {
    timeZone: "Asia/Taipei",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date());
  const hour = Number(parts.find((part) => part.type === "hour")?.value ?? 12);
  const minute = Number(
    parts.find((part) => part.type === "minute")?.value ?? 0,
  );
  const second = new Date().getSeconds();
  const range =
    hour < 6
      ? [80, 180]
      : hour < 12
        ? [180, 350]
        : hour < 18
          ? [350, 650]
          : [650, 1200];
  const progress = ((minute * 60 + second) % 300) / 300;
  return Math.floor(range[0] + (range[1] - range[0]) * progress);
};

const payoutStorageKey = "jshen-payout-pools-v1";
type PayoutAnchor = { amounts: number[]; updatedAt: number };

function usePersistentPayoutAmounts() {
  const [anchor, setAnchor] = useState<PayoutAnchor>(() => ({
    amounts: payoutPools.map((pool) => pool.amount),
    updatedAt: Date.now(),
  }));
  const [amounts, setAmounts] = useState<number[]>(() =>
    payoutPools.map((pool) => pool.amount),
  );
  const [announcements, setAnnouncements] = useState<PayoutAnnouncementRow[]>(
    [],
  );

  useEffect(() => {
    let next: PayoutAnchor | undefined;
    try {
      const stored = window.localStorage.getItem(payoutStorageKey);
      if (stored) {
        const parsed = JSON.parse(stored) as Partial<PayoutAnchor>;
        if (
          Array.isArray(parsed.amounts) &&
          parsed.amounts.length === payoutPools.length &&
          parsed.amounts.every(
            (value) => typeof value === "number" && Number.isFinite(value),
          ) &&
          typeof parsed.updatedAt === "number" &&
          Number.isFinite(parsed.updatedAt)
        ) {
          next = { amounts: parsed.amounts, updatedAt: parsed.updatedAt };
        }
      }
    } catch {
      /* Use a fresh anchor if browser storage is unavailable or invalid. */
    }
    next ??= {
      amounts: payoutPools.map((pool) => pool.amount),
      updatedAt: Date.now(),
    };
    setAnchor(next);
    try {
      window.localStorage.setItem(payoutStorageKey, JSON.stringify(next));
    } catch {
      /* Display can still continue in memory. */
    }
  }, []);

  useEffect(() => {
    const abort = new AbortController();
    let inFlight = false;
    const synchronize = async () => {
      if (inFlight || abort.signal.aborted) return;
      inFlight = true;
      try {
        const response = await fetch("/api/payouts", {
          cache: "no-store",
          signal: abort.signal,
        });
        if (!response.ok) return;
        const payload = (await response.json()) as {
          revision?: number | null;
          pools?: { code?: string; amount?: number }[];
          announcements?: PayoutAnnouncement[];
        };
        const revision = Number(payload.revision);
        if (!Number.isFinite(revision) || !Array.isArray(payload.pools)) return;
        const serverAmounts = payoutPools.map((pool) => {
          const match = payload.pools!.find(
            (item) => item.code?.toUpperCase() === pool.code,
          );
          return typeof match?.amount === "number" &&
            Number.isFinite(match.amount)
            ? match.amount
            : pool.amount;
        });
        setAnnouncements(
          (payload.announcements ?? []).flatMap((item) => {
            const code = item.categoryCode?.toUpperCase();
            if (
              !code ||
              !payoutPools.some((pool) => pool.code === code) ||
              typeof item.amount !== "number" ||
              !item.createdAt
            )
              return [];
            const timestamp = new Date(item.createdAt).toLocaleString("sv-SE", {
              timeZone: "Asia/Taipei",
            });
            const username = item.username?.trim() || "玩家***";
            const message = `恭喜 ${username} 取得 ${code} 派彩 $${item.amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
            return [[code, message, timestamp] as PayoutAnnouncementRow];
          }),
        );
        setAnchor((current) => {
          if (current.updatedAt === revision) return current;
          const next = { amounts: serverAmounts, updatedAt: revision };
          try {
            window.localStorage.setItem(payoutStorageKey, JSON.stringify(next));
          } catch {
            /* Continue in memory. */
          }
          return next;
        });
      } catch {
        /* Keep the last valid local anchor until the account service recovers. */
      } finally {
        inFlight = false;
      }
    };
    void synchronize();
    const timer = window.setInterval(() => {
      void synchronize();
    }, 5000);
    return () => {
      abort.abort();
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    const update = () => {
      const elapsedSeconds = Math.max(
        0,
        (Date.now() - anchor.updatedAt) / 1000,
      );
      const speed = taipeiOnlineUsers() / 86;
      const rates = [0.21 / 1.2, 0.12 / 0.9, 0.06 / 0.65, 0.03 / 0.45];
      setAmounts(
        anchor.amounts.map((amount, index) => {
          const pool = payoutPools[index];
          const cycleSize = pool.cap - pool.base;
          const accrued = rates[index] * speed * elapsedSeconds;
          const progress = Math.max(0, amount - pool.base) + accrued;
          return pool.base + (progress % cycleSize);
        }),
      );
    };
    update();
    const timer = window.setInterval(update, 500);
    return () => window.clearInterval(timer);
  }, [anchor]);

  return { amounts, announcements };
}

function PayoutFeature() {
  const { amounts, announcements } = usePersistentPayoutAmounts();
  return (
    <section className="overflow-hidden rounded-2xl border border-[#86632f]/45 bg-[#0d0b08]/95 shadow-[0_24px_70px_rgba(0,0,0,.42)]">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#5d451f]/55 bg-[#100d08]/80 px-5 py-4 sm:px-6">
        <div className="flex items-center gap-3">
          <Gift className="h-5 w-5 text-[#f0ce83]" />
          <div>
            <h1 className="text-lg font-semibold text-[#f3dfb4]">獎池</h1>
            <p className="mt-1 text-xs text-[#a98a50]">四大獎池即時現況</p>
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <span className="rounded-md border border-amber-300/30 bg-amber-300/10 px-3 py-1 text-xs text-amber-200">
            如有中獎，請聯絡系統管理員
          </span>
          <ContactLinks />
        </div>
      </div>
      <div className="grid gap-4 p-4 sm:grid-cols-2 lg:grid-cols-4">
        {payoutPools.map((pool, index) => (
          <article
            key={pool.code}
            className={`relative min-h-40 overflow-hidden rounded-xl border bg-gradient-to-br ${poolCardTone(pool.code)} p-4 shadow-lg`}
          >
            <div className="flex items-center justify-between">
              <span
                className={`text-xs font-bold tracking-[.18em] ${poolTextTone(pool.code)}`}
              >
                {pool.code}
              </span>
            </div>
            <p className="mt-8 whitespace-nowrap text-2xl font-bold tracking-tight text-[#fff4c9] sm:text-3xl">
              $
              {amounts[index].toLocaleString("en-US", {
                minimumFractionDigits: 2,
                maximumFractionDigits: 2,
              })}
            </p>
            <p className="mt-2 flex justify-between text-xs text-white/75">
              <span>
                下限 $
                {pool.base.toLocaleString("en-US", {
                  minimumFractionDigits: 2,
                  maximumFractionDigits: 2,
                })}
              </span>
              <span>
                上限 $
                {pool.cap.toLocaleString("en-US", {
                  minimumFractionDigits: 2,
                  maximumFractionDigits: 2,
                })}
              </span>
            </p>
            <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-white/15">
              <div
                className={`h-full rounded-full transition-[width] duration-500 ${poolBarTone(pool.code)}`}
                style={{
                  width: `${Math.min(100, (amounts[index] / pool.cap) * 100)}%`,
                }}
              />
            </div>
          </article>
        ))}
      </div>
      <div className="border-t border-[#5d451f]/45 p-4 sm:p-6">
        <div className="rounded-xl border border-[#765728]/35 bg-black/20 p-4">
          <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-[#f3dfb4]">
            <Bell className="h-4 w-4 text-[#f0ce83]" />
            近期派彩公告{" "}
            <span className="rounded border border-[#765728]/50 px-1.5 py-0.5 text-[10px] text-[#c9a55e]">
              四類 · 各類依時間排序
            </span>
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            {(["GRAND", "MAJOR", "MINOR", "MINI"] as const).map((code) => (
              <div
                key={code}
                className={`rounded-lg border p-3 ${announcementTone(code)}`}
              >
                <h3 className="mb-2 text-xs font-bold tracking-[.16em]">
                  {code}
                </h3>
                <div className="grid gap-2">
                  {announcements
                    .filter(([pool]) => pool === code)
                    .sort(
                      (a, b) =>
                        Date.parse(b[2].replace(" ", "T")) -
                        Date.parse(a[2].replace(" ", "T")),
                    )
                    .slice(0, 10)
                    .map(([pool, message, time]) => (
                      <div
                        key={`${pool}-${time}-${message}`}
                        className="flex flex-wrap items-center justify-between gap-2 rounded border border-white/10 bg-black/15 px-2.5 py-2 text-xs"
                      >
                        <span className="min-w-0 flex-1">{message}</span>
                        <time className="ml-2 whitespace-nowrap opacity-75">
                          {time}
                        </time>
                      </div>
                    ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

function PoolMenuCards() {
  const { amounts } = usePersistentPayoutAmounts();
  return (
    <div
      className="mt-2 rounded-xl border border-[#765728]/45 bg-black/15 p-2.5"
      aria-label="獎池摘要"
    >
      <div className="mb-2 px-1 text-xs font-semibold tracking-wide text-[#f0ce83]">
        獎池
      </div>
      <div className="grid gap-2">
        {payoutPools.map((pool, index) => (
          <div
            key={pool.code}
            className="flex min-h-[58px] flex-col justify-center rounded-lg border border-transparent px-3 py-3 text-sm text-slate-400 transition hover:border-cyan-400/30 hover:bg-cyan-400/5"
          >
            <div className="flex items-center justify-between gap-2">
              <span
                className={`font-bold tracking-[.16em] ${poolTextTone(pool.code)}`}
              >
                {pool.code}
              </span>
            </div>
            <div className="mt-1.5 flex items-baseline justify-between gap-2">
              <span className="text-sm font-bold tabular-nums text-[#fff2c9]">
                $
                {amounts[index].toLocaleString("en-US", {
                  minimumFractionDigits: 2,
                  maximumFractionDigits: 2,
                })}
              </span>
            </div>
            <div className="mt-1 flex justify-between text-[10px] text-[#8f7a52]">
              <span>
                下限 $
                {pool.base.toLocaleString("en-US", {
                  maximumFractionDigits: 0,
                })}
              </span>
              <span>
                上限 $
                {pool.cap.toLocaleString("en-US", { maximumFractionDigits: 0 })}
              </span>
            </div>
            <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-white/10">
              <div
                className={`h-full rounded-full transition-[width] duration-500 ${pool.bar}`}
                style={{
                  width: `${Math.min(100, (amounts[index] / pool.cap) * 100)}%`,
                }}
              />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function OnlineUsersCard({ collapsed }: { collapsed: boolean }) {
  const [count, setCount] = useState(0);
  useEffect(() => {
    const update = () => {
      setCount(taipeiOnlineUsers());
    };
    update();
    const timer = setInterval(update, 30000);
    return () => clearInterval(timer);
  }, []);
  if (collapsed)
    return (
      <div
        className="mt-3 flex justify-center rounded-lg border border-cyan-400/20 bg-cyan-400/5 py-3"
        title={`在線人數 ${count} 人`}
      >
        <Users className="h-4 w-4 text-cyan-200" />
      </div>
    );
  return (
    <div className="mt-3 rounded-xl border border-cyan-400/25 bg-gradient-to-r from-cyan-950/50 to-slate-900/70 px-3 py-2.5">
      <div className="flex items-center gap-2 text-xs font-semibold text-cyan-100">
        <Users className="h-4 w-4" />
        在線人數
      </div>
      <div className="mt-1 text-xl font-bold tabular-nums text-white">
        {count.toLocaleString()}{" "}
        <span className="text-xs font-normal text-cyan-200">人</span>
      </div>
    </div>
  );
}

function TableCompare({
  tablesByPlatform,
  connected,
  activePlatform,
  selected,
  onSelectedChange,
}: {
  tablesByPlatform: Record<"MT" | "DG" | "AB", TableInfo[]>;
  connected: boolean;
  activePlatform: "MT" | "DG" | "AB";
  selected: string[];
  onSelectedChange: (next: string[]) => void;
}) {
  const [sourcePlatform, setSourcePlatform] = useState<"MT" | "DG" | "AB">(
    activePlatform,
  );
  const [sourceTable, setSourceTable] = useState("百家樂1");
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const options = tablesByPlatform[sourcePlatform].filter(
    (table) => table.gameType === "BAC" || table.gameType === "BAS",
  );
  const tableOptions = options.map((table) => ({
    value: table.id,
    label: table.name,
  }));
  if (!tableOptions.some((option) => option.label === "百家樂1"))
    tableOptions.unshift({ value: "百家樂1", label: "百家樂1" });
  const addTable = () =>
    onSelectedChange([...selected, `${sourcePlatform}::${sourceTable}`]);
  const moveTable = (from: number, to: number) => {
    const next = [...selected];
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item);
    onSelectedChange(next);
  };
  return (
    <section className="overflow-hidden rounded-2xl border border-cyan-400/30 bg-[#0d111a] shadow-[0_24px_70px_rgba(0,0,0,.42)]">
      <header className="border-b border-cyan-400/20 px-5 py-4">
        <h1 className="text-lg font-semibold text-cyan-100">關注牌桌</h1>
        <p className="mt-1 text-xs text-slate-400">
          先選擇平台與桌號，再加入關注；拖曳左側把手調整順序
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <select
            value={sourcePlatform}
            onChange={(event) => {
              const next = event.target.value as "MT" | "DG" | "AB";
              setSourcePlatform(next);
              setSourceTable("百家樂1");
            }}
            aria-label="選擇平台"
            className="h-9 rounded-md border border-cyan-300/50 bg-slate-900 px-3 text-xs text-cyan-100"
          >
            <option value="MT">MT</option>
            <option value="DG">DG</option>
            <option value="AB">歐博</option>
          </select>
          <select
            value={sourceTable}
            onChange={(event) => setSourceTable(event.target.value)}
            aria-label="選擇桌號"
            className="h-9 rounded-md border border-cyan-300/50 bg-slate-900 px-3 text-xs text-cyan-100"
          >
            {tableOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={addTable}
            className="h-9 rounded-md border border-cyan-300/60 bg-cyan-800/70 px-3 text-xs font-semibold text-white hover:bg-cyan-700"
          >
            加入
          </button>
        </div>
      </header>
      {selected.length === 0 ? (
        <div className="grid min-h-56 place-items-center p-6 text-center text-sm text-slate-400">
          請選擇平台與桌號後加入。相同牌桌可以重複加入。
        </div>
      ) : (
        <div className="grid gap-3 p-3 min-[1200px]:grid-cols-2">
          {selected.map((key, index) => {
            const [source, id] = key.split("::");
            const table = tablesByPlatform[source as "MT" | "DG" | "AB"]?.find(
              (item) => item.id === id || item.name === id,
            );
            return (
              <div
                key={`${key}-${index}`}
                onDragOver={(event) => event.preventDefault()}
                onDrop={() => {
                  if (dragIndex !== null && dragIndex !== index)
                    moveTable(dragIndex, index);
                  setDragIndex(null);
                }}
                className="min-w-0"
              >
                <div
                  draggable
                  onDragStart={() => setDragIndex(index)}
                  className="mb-1 w-fit cursor-grab select-none rounded border border-cyan-300/30 px-2 py-0.5 text-[10px] text-cyan-200 active:cursor-grabbing"
                >
                  ⠿ 拖曳排序
                </div>
                {table ? (
                  <BaccaratTableCard table={table} connected={connected} />
                ) : (
                  <div className="rounded-lg border border-amber-300/30 bg-amber-300/10 p-4 text-sm text-amber-100">
                    {key.replace("::", " · ")}{" "}
                    尚未收到串流資料，請先切換至對應平台取得資料。
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

void TableCompare;

function FocusedTableCompare({
  tablesByPlatform,
  connectedByPlatform,
  selected,
  onSelectedChange,
  cardsPerRow,
  onCardsPerRowChange,
  onFocusTable,
}: {
  tablesByPlatform: Record<"MT" | "DG" | "AB", TableInfo[]>;
  connectedByPlatform: Record<"MT" | "DG" | "AB", boolean>;
  selected: string[];
  onSelectedChange: (next: string[]) => void;
  cardsPerRow: CardColumns;
  onCardsPerRowChange: (value: CardColumns) => void;
  onFocusTable: (table: TableInfo, settings?: FocusedTableSettings) => void;
}) {
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const removeTable = (index: number) =>
    onSelectedChange(selected.filter((_, itemIndex) => itemIndex !== index));
  const moveTable = (from: number, to: number) => {
    const next = [...selected];
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item);
    onSelectedChange(next);
  };
  return (
    <section className="overflow-hidden rounded-2xl border border-cyan-400/30 bg-[#0d111a] shadow-[0_24px_70px_rgba(0,0,0,.42)]">
      <header className="border-b border-cyan-400/20 px-5 py-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-lg font-semibold text-cyan-100">關注牌桌</h1>
          <CardLayoutSelect
            value={cardsPerRow}
            onChange={onCardsPerRowChange}
          />
        </div>
      </header>
      {selected.length === 0 ? (
        <div className="grid min-h-56 place-items-center p-6 text-center text-sm text-slate-400">
          請在即時桌況的牌卡功能中加入關注牌桌。
        </div>
      ) : (
        <div className={`grid gap-3 p-3 ${cardGridColumns[cardsPerRow]}`}>
          {selected.map((key, index) => {
            const [source, id, instanceId] = key.split("::");
            const typedSource = source as "MT" | "DG" | "AB";
            const table = tablesByPlatform[typedSource]?.find(
              (item) => item.id === id || item.name === id,
            );
            const label = source === "AB" ? "歐博" : source;
            const legacyOccurrence = selected
              .slice(0, index)
              .filter((item) => item === key).length;
            const storageScope = instanceId
              ? `focused:${instanceId}`
              : `focused:${source}:${id}:${legacyOccurrence}`;
            return (
              <div
                key={instanceId ? key : `${key}-${index}`}
                onDragOver={(event) => event.preventDefault()}
                onDrop={() => {
                  if (dragIndex !== null && dragIndex !== index)
                    moveTable(dragIndex, index);
                  setDragIndex(null);
                }}
                className="min-w-0"
              >
                <div className="mb-1 flex justify-end gap-1">
                  <div
                    draggable
                    onDragStart={() => setDragIndex(index)}
                    title="拖曳排序"
                    aria-label="拖曳排序"
                    className="flex h-7 w-7 cursor-grab select-none items-center justify-center rounded border border-cyan-300/30 text-sm text-cyan-200 active:cursor-grabbing"
                  >
                    ⠿
                  </div>
                  <button
                    type="button"
                    onClick={() => removeTable(index)}
                    title={`移除 ${label} ${id}`}
                    className="flex h-7 w-7 items-center justify-center rounded border border-rose-300/45 text-sm font-semibold text-rose-200 hover:bg-rose-500/15"
                    aria-label={`移除 ${label} ${id}`}
                  >
                    ×
                  </button>
                </div>
                {table ? (
                  <BaccaratTableCard
                    table={table}
                    connected={connectedByPlatform[typedSource]}
                    platformLabel={label}
                    onFocusTable={onFocusTable}
                    storageScope={storageScope}
                  />
                ) : (
                  <div className="rounded-lg border border-amber-300/30 bg-amber-300/10 p-4 text-sm text-amber-100">
                    {`${source} · ${id}`}{" "}
                    尚未收到串流資料，請先切換至對應平台取得資料。
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

const now = () =>
  new Intl.DateTimeFormat("zh-TW", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date());

// Viewer timestamps describe when Render accepted a snapshot, not when the
// browser last polled an unchanged copy of it.
const receivedAtTime = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) && value > 0
    ? new Intl.DateTimeFormat("zh-TW", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
      }).format(new Date(value))
    : "";

// The MT token never leaves the collector browser.  Only normalized table
// snapshots and connection state are sent to the authenticated shared feed so
// other users can watch the same data without opening a second MT socket.
let mtPublishSequence = 0;
const mtCollectorEpoch = createBrowserUuid();
let dgPublishSequence = 0;
const dgCollectorEpoch = createBrowserUuid();

const publishSharedMt = (message: {
  type: "snapshot" | "status";
  tables?: TableInfo[];
  status?: "connecting" | "connected" | "offline";
  message?: string;
}) => {
  void fetch("/api/mt/shared-feed", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    cache: "no-store",
    // The hub rejects out-of-order snapshots. A monotonic collector sequence
    // prevents a delayed POST from replacing fresh tables or rewinding a
    // countdown after reconnect.
    body: JSON.stringify({
      ...message,
      collector: true,
      collectorId: mtCollectorEpoch,
      sequence: ++mtPublishSequence,
      receivedAt: Date.now(),
    }),
  }).catch(() => {
    /* a missing relay must not interrupt the collector */
  });
};

const publishSharedDg = (message: {
  type: "snapshot" | "status";
  tables?: TableInfo[];
  status?: "connecting" | "connected" | "offline";
  message?: string;
}) => {
  void fetch("/api/dg/shared-feed", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    cache: "no-store",
    body: JSON.stringify({
      ...message,
      collector: true,
      collectorId: dgCollectorEpoch,
      sequence: ++dgPublishSequence,
      receivedAt: Date.now(),
    }),
  }).catch(() => {
    /* a missing relay must not interrupt the collector */
  });
};

// Presence is an internal relay signal. It is intentionally not rendered in
// the UI; the shared feed uses it only to decide whether collection should
// remain active.
const sendMtPresence = (online: boolean, viewerId: string) => {
  void fetch("/api/mt/shared-feed", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    cache: "no-store",
    body: JSON.stringify({ type: "presence", online, viewerId }),
  }).catch(() => {
    /* a missing relay must not interrupt the viewer */
  });
};

const defaultUsername = "";
const defaultPassword = "";
const toText = (value: unknown, fallback: string) =>
  typeof value === "string" || typeof value === "number"
    ? String(value)
    : fallback;

const optionalText = (value: unknown) =>
  typeof value === "string" || typeof value === "number"
    ? String(value)
    : undefined;

const finiteNumber = (value: unknown): number | undefined => {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim()
        ? Number(value)
        : NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
};

const epochMilliseconds = (value: number) =>
  value > 0 && value < 100_000_000_000 ? value * 1000 : value;

const photoUrl = (value: unknown): string | undefined => {
  if (typeof value !== "string" || !value.trim()) return undefined;
  try {
    const parsed = new URL(value, "https://ds.ofalive99.net/");
    return parsed.protocol === "https:" ? parsed.href : undefined;
  } catch {
    return undefined;
  }
};

const extractTableUpdates = (
  payload: unknown,
): Array<Partial<TableInfo> & { id: string }> => {
  const envelope =
    payload && typeof payload === "object"
      ? (payload as Record<string, unknown>)
      : {};
  const action =
    envelope.action && typeof envelope.action === "object"
      ? (envelope.action as Record<string, unknown>)
      : {};
  // MT event packets carry method="POST" alongside action.name.  The action
  // path is the meaningful event name; prefer it so /wait can expose body.count.
  const eventName = String(
    envelope.name ??
      envelope.event ??
      action.name ??
      envelope.action ??
      envelope.method ??
      "",
  );
  const receivedAt = Date.now();
  const records: Record<string, unknown>[] = [];
  const visit = (value: unknown, depth = 0) => {
    if (!value || depth > 6) return;
    if (Array.isArray(value)) {
      value.forEach((item) => visit(item, depth + 1));
      return;
    }
    if (typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    if (optionalText(record.table_id)) records.push(record);
    Object.values(record).forEach((item) => visit(item, depth + 1));
  };
  visit(payload);

  const unique = new Map<string, Partial<TableInfo> & { id: string }>();
  records.forEach((table) => {
    const trend = (table.trend ?? {}) as Record<string, unknown>;
    const dealer = (table.dealer ?? {}) as Record<string, unknown>;
    const dealerName = optionalText(
      dealer.nick_name ??
        dealer.nickname ??
        dealer.name ??
        dealer.username ??
        table.dealer_name,
    );
    const dealerPhoto = [
      table.dealer_image,
      table.dealer_image_url,
      table.dealerPhoto,
      dealer.avatar_url,
      dealer.image,
      dealer.avatar,
      dealer.photo,
    ]
      .map(photoUrl)
      .find(Boolean);
    const tableId = toText(table.table_id, "");
    const sourceTableId = optionalText(table.table_id_t) ?? tableId;
    const video = sourceTableId !== tableId ? table.video_live : table.video;
    const videoUrl = Array.isArray(video)
      ? video
          .map((line) =>
            Array.isArray(line) && typeof line[2] === "string" ? line[2] : "",
          )
          .find((value) => {
            try {
              const url = new URL(value);
              return url.protocol === "https:" && url.pathname.endsWith(".flv");
            } catch {
              return false;
            }
          })
      : undefined;
    if (!tableId) return;
    const current = unique.get(tableId) ?? { id: tableId };
    const explicitDeadline = finiteNumber(
      table.countdownDeadline ?? table.countdown_deadline ?? table.deadline,
    );
    const waitEvent = /(?:\/|:)wait(?:\b|$)/i.test(eventName);
    const countDown = finiteNumber(
      table.countDown ??
        table.countdown ??
        table.countdown_seconds ??
        table.countdownSeconds ??
        table.remaining_seconds ??
        table.remainingSeconds ??
        table.remain ??
        table.remainSeconds ??
        table.wait_time ??
        table.waitTime ??
        (waitEvent ? table.count : undefined),
    );
    // The lobby snapshot commonly carries a placeholder countdown of 0;
    // the authoritative live value arrives from the per-table /wait event.
    // Keep the source so mergeTableUpdates can distinguish those packets
    // without allowing a stale snapshot to reset a live countdown.
    const countdownSource =
      explicitDeadline !== undefined
        ? "explicit"
        : countDown !== undefined
          ? waitEvent
            ? "wait"
            : "snapshot"
          : undefined;
    const roundValue = optionalText(
      table.round ?? table.round_id ?? trend.current_round,
    );
    const countdownRound = optionalText(
      table.game_sn ??
        table.gameSn ??
        table.round ??
        table.round_id ??
        trend.current_round,
    );
    const showPokerEvent = eventName.toLowerCase().endsWith("/show_poker");
    const completedEvent = ["/summary", "/result", "/end"].some((suffix) =>
      eventName.toLowerCase().endsWith(suffix),
    );
    const endEvent = showPokerEvent || completedEvent;
    const tablePhase =
      optionalText(table.state) === "2" ||
      completedEvent ||
      (waitEvent && countDown !== undefined && countDown > 0)
        ? null
        : showPokerEvent || (waitEvent && countDown === 0)
          ? "dealing"
          : undefined;
    unique.set(tableId, {
      ...current,
      id: tableId,
      sourceTableId,
      mtEvent: waitEvent ? "wait" : showPokerEvent ? "show_poker" : completedEvent ? "complete" : eventName.endsWith("/tables") ? "snapshot" : "update",
      mtReceivedAt: receivedAt,
      ...(explicitDeadline !== undefined && {
        countdownDeadline: epochMilliseconds(explicitDeadline),
        countdownReceivedAt:
          finiteNumber(table.countdownReceivedAt) ?? receivedAt,
      }),
      ...(countDown !== undefined && {
        countdownValue: Math.max(0, countDown),
      }),
      ...(countdownRound !== undefined && { countdownRound }),
      ...(countdownSource !== undefined && { countdownSource }),
      ...(Array.isArray(video) && { videoUrl: videoUrl ?? "" }),
      ...((optionalText(table.state) !== undefined || (waitEvent && countDown !== undefined && countDown > 0)) && {
        tableState: waitEvent && countDown !== undefined && countDown > 0 ? "0" : optionalText(table.state),
      }),
      ...(tablePhase !== undefined && {
        tablePhase: tablePhase as TableInfo["tablePhase"],
      }),
      ...(explicitDeadline === undefined &&
        countDown !== undefined && {
          countdownDeadline: receivedAt + Math.max(0, countDown) * 1000,
          countdownReceivedAt: receivedAt,
        }),
      ...(endEvent && {
        countdownDeadline: receivedAt,
        countdownReceivedAt: receivedAt,
        countdownValue: 0,
        countdownSource: "end" as const,
      }),
      ...(optionalText(table.table_name) && {
        name: optionalText(table.table_name),
      }),
      ...(optionalText(table.table_type) && {
        gameType: optionalText(table.table_type),
      }),
      ...(dealerName !== undefined && { dealer: dealerName }),
      ...(dealerPhoto !== undefined && { dealerPhoto }),
      ...(optionalText(table.room_id) && { room: optionalText(table.room_id) }),
      ...(optionalText(table.shoe ?? trend.current_shoe) && {
        shoe: optionalText(table.shoe ?? trend.current_shoe),
      }),
      ...(roundValue !== undefined && { round: roundValue }),
      ...(optionalText(trend.total_round_banker) && {
        banker: optionalText(trend.total_round_banker),
      }),
      ...(optionalText(trend.total_round_player) && {
        player: optionalText(trend.total_round_player),
      }),
      ...(optionalText(trend.total_round_tie) && {
        tie: optionalText(trend.total_round_tie),
      }),
      ...(optionalText(table.totalplayers) && {
        players: optionalText(table.totalplayers),
      }),
      ...(typeof trend.bead_plate2 === "string" && {
        beadPlate: trend.bead_plate2,
      }),
      ...(typeof trend.big2 === "string" && { bigRoad: trend.big2 }),
      ...(typeof trend.big_eye2 === "string" && { bigEyeRoad: trend.big_eye2 }),
      ...(typeof trend.small2 === "string" && { smallRoad: trend.small2 }),
      ...(typeof trend.cockroach2 === "string" && {
        cockroachRoad: trend.cockroach2,
      }),
    });
  });
  return [...unique.values()];
};

const mergeTableUpdates = (
  current: TableInfo[],
  updates: Array<Partial<TableInfo> & { id: string }>,
) => {
  const tables = new Map(current.map((table) => [table.id, table]));
  updates.forEach((incoming) => {
    const currentTable = tables.get(incoming.id);
    const update = filterMtUpdate(currentTable, incoming);
    const previous = mtMergeBase(currentTable, update);
    tables.set(update.id, {
      id: update.id,
      sourceTableId: update.sourceTableId ?? previous?.sourceTableId,
      mtEvent: update.mtEvent ?? previous?.mtEvent,
      mtReceivedAt: update.mtReceivedAt ?? previous?.mtReceivedAt,
      videoUrl: update.videoUrl ?? previous?.videoUrl,
      tableState: update.tableState ?? previous?.tableState,
      tablePhase:
        update.tablePhase !== undefined
          ? update.tablePhase
          : previous?.tablePhase,
      countdownDeadline: update.countdownDeadline ?? previous?.countdownDeadline,
      countdownReceivedAt: update.countdownReceivedAt ?? previous?.countdownReceivedAt,
      countdownValue: update.countdownValue ?? previous?.countdownValue,
      countdownRound: update.countdownRound ?? previous?.countdownRound,
      countdownSource: update.countdownSource ?? previous?.countdownSource,
      name: update.name ?? previous?.name ?? update.id,
      gameType: update.gameType ?? previous?.gameType ?? "",
      dealer: update.dealer ?? previous?.dealer ?? "未指派",
      dealerPhoto:
        update.dealerPhoto ??
        (update.dealer !== undefined && update.dealer !== previous?.dealer
          ? undefined
          : previous?.dealerPhoto),
      room: update.room ?? previous?.room ?? "—",
      shoe: update.shoe ?? previous?.shoe ?? "—",
      round: update.round ?? previous?.round ?? "—",
      banker: update.banker ?? previous?.banker ?? "0",
      player: update.player ?? previous?.player ?? "0",
      tie: update.tie ?? previous?.tie ?? "0",
      players: update.players ?? previous?.players ?? "—",
      beadPlate: update.beadPlate ?? previous?.beadPlate ?? "",
      aiOutcomes: update.aiOutcomes ?? previous?.aiOutcomes,
      bigRoad: update.bigRoad ?? previous?.bigRoad ?? "",
      bigEyeRoad: update.bigEyeRoad ?? previous?.bigEyeRoad ?? "",
      smallRoad: update.smallRoad ?? previous?.smallRoad ?? "",
      cockroachRoad: update.cockroachRoad ?? previous?.cockroachRoad ?? "",
    });
  });
  const next = synchronizeMtClocks([...tables.values()])
    .filter((table) => table.gameType === "BAC" || table.gameType === "BAS")
    .sort((left, right) =>
      left.name.localeCompare(right.name, "en", {
        numeric: true,
        sensitivity: "base",
      }),
    );
  const unchanged =
    current.length === next.length &&
    current.every((table, index) => {
      const candidate = next[index];
      return Object.keys(table).every(
        (key) =>
          table[key as keyof TableInfo] === candidate[key as keyof TableInfo],
      );
    });
  return unchanged ? current : next;
};

type MtLease = { owner: string; expiresAt: number };
const MT_LEASE_MS = 5000;
const readMtLease = (key: string): MtLease | null => {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<MtLease>;
    return typeof value.owner === "string" && Number.isFinite(value.expiresAt)
      ? { owner: value.owner, expiresAt: Number(value.expiresAt) }
      : null;
  } catch {
    return null;
  }
};
const claimMtLease = (key: string, owner: string) => {
  try {
    const current = readMtLease(key);
    if (current && current.owner !== owner && current.expiresAt > Date.now())
      return false;
    localStorage.setItem(
      key,
      JSON.stringify({ owner, expiresAt: Date.now() + MT_LEASE_MS }),
    );
    return readMtLease(key)?.owner === owner;
  } catch {
    return true;
  }
};
const renewMtLease = (key: string, owner: string) => {
  try {
    if (readMtLease(key)?.owner !== owner) return false;
    localStorage.setItem(
      key,
      JSON.stringify({ owner, expiresAt: Date.now() + MT_LEASE_MS }),
    );
    return true;
  } catch {
    return true;
  }
};
const releaseMtLease = (key: string, owner: string) => {
  try {
    if (readMtLease(key)?.owner === owner) localStorage.removeItem(key);
  } catch {
    /* storage may be unavailable */
  }
};

type UserPayoutNotice = {
  id: string;
  username: string;
  categoryCode: string;
  categoryName: string;
  amount: number;
  createdAt: string;
  isCurrentUser?: boolean;
};

function PayoutWinnerNotification() {
  const [notice, setNotice] = useState<UserPayoutNotice | null>(null);
  const noticeRef = useRef<UserPayoutNotice | null>(null);
  const accountRef = useRef("");

  useEffect(() => {
    noticeRef.current = notice;
  }, [notice]);
  useEffect(() => {
    const abort = new AbortController();
    let inFlight = false;
    const poll = async () => {
      if (inFlight || abort.signal.aborted || noticeRef.current) return;
      inFlight = true;
      try {
        const response = await fetch("/api/payouts", {
          cache: "no-store",
          signal: abort.signal,
        });
        if (!response.ok) return;
        const payload = (await response.json()) as {
          accountUsername?: string | null;
          payouts?: UserPayoutNotice[];
        };
        const account = payload.accountUsername?.trim() ?? "";
        if (!account || !Array.isArray(payload.payouts)) return;
        accountRef.current = account;
        const storageKey = `jshen-seen-payouts:${account.toLowerCase()}`;
        let seen: string[] = [];
        try {
          seen = JSON.parse(
            window.localStorage.getItem(storageKey) || "[]",
          ) as string[];
        } catch {
          seen = [];
        }
        const next = [...payload.payouts]
          .filter(
            (item) =>
              item && typeof item.id === "string" && !seen.includes(item.id),
          )
          .sort(
            (left, right) =>
              Date.parse(left.createdAt) - Date.parse(right.createdAt),
          )[0];
        if (next) setNotice(next);
      } catch {
        /* Notification polling retries while the signed-in page remains open. */
      } finally {
        inFlight = false;
      }
    };
    void poll();
    const timer = window.setInterval(() => {
      void poll();
    }, 10000);
    return () => {
      abort.abort();
      window.clearInterval(timer);
    };
  }, []);

  const dismiss = () => {
    if (!notice) return;
    const account = accountRef.current || notice.username;
    const storageKey = `jshen-seen-payouts:${account.toLowerCase()}`;
    try {
      const seen = JSON.parse(
        window.localStorage.getItem(storageKey) || "[]",
      ) as string[];
      window.localStorage.setItem(
        storageKey,
        JSON.stringify([...new Set([...seen, notice.id])].slice(-200)),
      );
    } catch {
      /* Acknowledge for this page even when storage is unavailable. */
    }
    setNotice(null);
  };

  if (!notice) return null;
  return (
    <div
      className="fixed inset-0 z-[200] grid place-items-center bg-black/65 px-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label="中獎通知"
    >
      <section className="w-full max-w-md overflow-hidden rounded-2xl border-2 border-amber-300 bg-gradient-to-b from-[#33230b] to-[#100b05] text-center shadow-[0_24px_90px_rgba(245,183,54,.35)]">
        <div className="border-b border-amber-300/30 bg-amber-300/10 px-6 py-5">
          <Gift className="mx-auto h-10 w-10 text-amber-300" />
          <h2 className="mt-3 text-2xl font-black tracking-wide text-amber-100">
            恭喜中獎！
          </h2>
        </div>
        <div className="px-6 py-6">
          <p className="text-sm text-amber-200/80">
            您獲得 {notice.categoryCode} · {notice.categoryName}
          </p>
          <p className="mt-3 text-3xl font-black tabular-nums text-[#fff2b6]">
            $
            {Number(notice.amount).toLocaleString("en-US", {
              minimumFractionDigits: 2,
              maximumFractionDigits: 2,
            })}
          </p>
          <p className="mt-4 text-sm font-semibold text-amber-100">
            請截圖給管理員，確認派彩。
          </p>
          <button
            type="button"
            onClick={dismiss}
            className="mt-6 h-11 min-w-36 rounded-lg bg-gradient-to-b from-[#f3d98e] to-[#bd8734] px-6 font-bold text-[#241606] hover:brightness-110"
          >
            知道了
          </button>
        </div>
      </section>
    </div>
  );
}

function PayoutBroadcastNotification() {
  const [notice, setNotice] = useState<UserPayoutNotice | null>(null);
  const latestId = useRef<string | null>(null);
  useEffect(() => {
    const abort = new AbortController();
    let inFlight = false;
    const poll = async () => {
      if (inFlight || abort.signal.aborted) return;
      inFlight = true;
      try {
        const response = await fetch("/api/payouts", {
          cache: "no-store",
          signal: abort.signal,
        });
        if (!response.ok) return;
        const payload = (await response.json()) as {
          accountUsername?: string | null;
          announcements?: UserPayoutNotice[];
        };
        const announcements = Array.isArray(payload.announcements)
          ? payload.announcements
          : [];
        const newest = announcements[0];
        if (!newest?.id) return;
        const account = payload.accountUsername?.trim().toLowerCase() ?? "";
        const important = announcements.find(
          (item) =>
            item.categoryCode === "GRAND" || item.categoryCode === "MAJOR",
        );
        const importantStorageKey = account
          ? `jshen-seen-important-payouts:${account}`
          : "";
        const hasSeenImportant = (id: string) => {
          if (!importantStorageKey) return true;
          try {
            const seen = JSON.parse(
              window.localStorage.getItem(importantStorageKey) || "[]",
            ) as string[];
            return seen.includes(id);
          } catch {
            return false;
          }
        };
        const rememberImportant = (id: string) => {
          if (!importantStorageKey) return;
          try {
            const seen = JSON.parse(
              window.localStorage.getItem(importantStorageKey) || "[]",
            ) as string[];
            window.localStorage.setItem(
              importantStorageKey,
              JSON.stringify([...new Set([...seen, id])].slice(-200)),
            );
          } catch {
            /* The current page still shows the notice when storage is unavailable. */
          }
        };
        if (latestId.current === null) {
          latestId.current = newest.id;
          // GRAND and MAJOR remain available for the user's first later login.
          // Smaller pools are intentionally live-only and are not replayed.
          if (
            important?.id &&
            !important.isCurrentUser &&
            !hasSeenImportant(important.id)
          ) {
            rememberImportant(important.id);
            setNotice(important);
          }
          return;
        }
        if (latestId.current !== newest.id) {
          latestId.current = newest.id;
          if (
            newest.categoryCode === "GRAND" ||
            newest.categoryCode === "MAJOR"
          )
            rememberImportant(newest.id);
          if (!newest.isCurrentUser) setNotice(newest);
        }
      } catch {
        /* Retry while the signed-in page remains open. */
      } finally {
        inFlight = false;
      }
    };
    void poll();
    const timer = window.setInterval(() => {
      void poll();
    }, 5000);
    return () => {
      abort.abort();
      window.clearInterval(timer);
    };
  }, []);
  useEffect(() => {
    if (!notice) return;
    let audio: AudioContext | null = null;
    let audioTimer: number | undefined;
    try {
      if (window.AudioContext) {
        audio = new window.AudioContext();
        [523.25, 659.25, 783.99].forEach((frequency, index) => {
          const oscillator = audio!.createOscillator();
          const gain = audio!.createGain();
          const startsAt = audio!.currentTime + index * 0.14;
          oscillator.frequency.value = frequency;
          oscillator.type = "sine";
          gain.gain.setValueAtTime(0.0001, startsAt);
          gain.gain.exponentialRampToValueAtTime(0.16, startsAt + 0.025);
          gain.gain.exponentialRampToValueAtTime(0.0001, startsAt + 0.34);
          oscillator.connect(gain).connect(audio!.destination);
          oscillator.start(startsAt);
          oscillator.stop(startsAt + 0.36);
        });
        audioTimer = window.setTimeout(() => {
          void audio?.close();
        }, 1000);
      }
    } catch {
      /* Browsers may block sound until the user has interacted with the page. */
    }
    return () => {
      if (audioTimer) window.clearTimeout(audioTimer);
      if (audio?.state !== "closed") void audio?.close();
    };
  }, [notice]);
  if (!notice) return null;
  return (
    <div
      className="fixed inset-0 z-[190] grid place-items-center overflow-hidden bg-black/70 px-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label="全站中獎快訊"
    >
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_center,rgba(251,191,36,.24),transparent_58%)] animate-pulse"
      />
      <section className="relative w-full max-w-lg overflow-hidden rounded-2xl border-2 border-amber-300 bg-gradient-to-b from-[#3d2b0c] via-[#211607] to-[#0e0a04] text-center shadow-[0_24px_100px_rgba(245,183,54,.48)]">
        <div className="border-b border-amber-300/35 bg-amber-300/10 px-6 py-6">
          <Gift className="mx-auto h-12 w-12 animate-bounce text-amber-300" />
          <h2 className="mt-3 text-3xl font-black tracking-wide text-amber-50">
            恭喜玩家中獎！
          </h2>
        </div>
        <div className="px-6 py-7">
          <p className="text-lg font-bold text-amber-200">
            {notice.username}獲得 {notice.categoryCode} · {notice.categoryName}
          </p>
          <p className="mt-2 text-4xl font-black tabular-nums text-[#fff2b6]">
            $
            {Number(notice.amount).toLocaleString("en-US", {
              minimumFractionDigits: 2,
              maximumFractionDigits: 2,
            })}
          </p>
          <button
            type="button"
            onClick={() => setNotice(null)}
            className="mt-7 h-11 min-w-40 rounded-lg border border-amber-200/40 bg-amber-300/10 px-6 font-bold text-amber-50 hover:bg-amber-300/20"
          >
            關閉
          </button>
        </div>
      </section>
    </div>
  );
}

export default function Home() {
  const socket = useRef<WebSocket | null>(null);
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const mtPingTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const mtTablesTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const collectorAuthorizeInFlight = useRef(false);
  const mtClientId = useRef(createBrowserUuid());
  const mtViewerId = useRef(createBrowserUuid());
  const [status, setStatus] = useState<ConnectionStatus>("idle");
  const [tables, setTables] = useState<TableInfo[]>([]);
  const [tablesByPlatform, setTablesByPlatform] = useState<
    Record<"MT" | "DG" | "AB", TableInfo[]>
  >({ MT: [], DG: [], AB: [] });
  const [connectedByPlatform, setConnectedByPlatform] = useState<
    Record<"MT" | "DG" | "AB", boolean>
  >({ MT: false, DG: false, AB: false });
  const [focusedTables, setFocusedTables] = useState<string[]>([]);
  const focusedTablesRef = useRef<string[]>([]);
  const focusedWrites = useRef<Promise<void>>(Promise.resolve());
  const focusedPending = useRef(0);
  const focusedRevision = useRef(0);
  const focusedNeedsSave = useRef(false);
  const [focusedSyncError, setFocusedSyncError] = useState("");
  const [cardsPerRow, setCardsPerRow] = useState<CardColumns>(2);
  const [tableUpdatedAt, setTableUpdatedAt] = useState("");
  const [mtMessage, setMtMessage] = useState("等待牌桌資料");
  const [mtConnection, setMtConnection] = useState<MtFrontendConnection | null>(
    null,
  );
  const [abGameUrl, setAbGameUrl] = useState<string | null>(null);
  const [dgGameUrl, setDgGameUrl] = useState<string | null>(null);
  const [mtDemand, setMtDemand] = useState(false);
  const [collectorCredentials, setCollectorCredentials] =
    useState<CollectorCredentials | null>(null);
  const [dgMessage, setDgMessage] = useState("等待 DG 即時資料…");
  const [dgUpdatedAt, setDgUpdatedAt] = useState("");
  const [abMessage, setAbMessage] = useState("等待 歐博 即時資料…");
  const [abUpdatedAt, setAbUpdatedAt] = useState("");
  const [username, setUsername] = useState(defaultUsername);
  const [password, setPassword] = useState(defaultPassword);
  const [loginStatus, setLoginStatus] = useState<
    "idle" | "loading" | "success" | "error"
  >("idle");
  const [loginMessage, setLoginMessage] = useState("");
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [checkingSession, setCheckingSession] = useState(true);
  const [platform, setPlatform] = useState<"MT" | "DG" | "AB">("MT");
  const [activeMenu, setActiveMenu] = useState<
    "tables" | "payout" | "compare" | "regression" | "curated"
  >("curated");
  const [menuCollapsed, setMenuCollapsed] = useState(false);
  const [mtCollectorMode, setMtCollectorMode] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [logoutError, setLogoutError] = useState("");
  const handleDgTables = useCallback(
    (next: TableInfo[]) =>
      setTablesByPlatform((previous) => ({ ...previous, DG: next })),
    [],
  );
  const handleCollectorDgTables = useCallback(
    (next: TableInfo[]) => {
      handleDgTables(next);
      publishSharedDg({ type: "snapshot", tables: next });
    },
    [handleDgTables],
  );
  const handleAbTables = useCallback(
    (next: TableInfo[]) =>
      setTablesByPlatform((previous) => ({ ...previous, AB: next })),
    [],
  );

  useEffect(() => {
    const collectorMode =
      new URLSearchParams(window.location.search).get("collector") === "1";
    setMtCollectorMode(collectorMode);
  }, []);

  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("collector") === "1") {
      setCheckingSession(false);
      return;
    }
    const abort = new AbortController();
    let active = true;
    const timeout = window.setTimeout(() => abort.abort(), 5000);
    const restore = async () => {
      try {
        const response = await fetch("/api/session", { cache: "no-store", signal: abort.signal });
        if (!response.ok) return;
        const result = (await response.json()) as { username?: string };
        if (!active || abort.signal.aborted || !result.username) return;
        setUsername(result.username);
        setPassword("");
        setLoginStatus("success");
        setIsAuthenticated(true);
      } catch { /* A missing or expired session leaves the normal login available. */ }
      finally {
        window.clearTimeout(timeout);
        if (active) setCheckingSession(false);
      }
    };
    void restore();
    return () => { active = false; window.clearTimeout(timeout); abort.abort(); };
  }, []);

  // Presence is based on being logged in to this system, not on which
  // platform/menu the user is currently viewing.  The dedicated collector
  // uses this signal to keep the MT browser WebSocket alive whenever any
  // authenticated user is online, including users currently on DG, AB, or
  // another menu.
  useEffect(() => {
    // The collector browser is not a viewer. Its heartbeat must not keep the
    // shared feed alive when all real users have left.
    if (!isAuthenticated || mtCollectorMode) return;
    const viewerId = mtViewerId.current;
    const heartbeat = () => sendMtPresence(true, viewerId);
    heartbeat();
    const timer = setInterval(heartbeat, 15000);
    return () => {
      clearInterval(timer);
      sendMtPresence(false, viewerId);
    };
  }, [isAuthenticated, mtCollectorMode]);

  const handlePlatformStatus = useCallback(
    (source: "DG" | "AB", next: "connecting" | "connected" | "error") => {
      setConnectedByPlatform((previous) => {
        const connected = next === "connected";
        return previous[source] === connected
          ? previous
          : { ...previous, [source]: connected };
      });
      if (activeMenu === "tables" && platform === source) setStatus(next);
    },
    [activeMenu, platform],
  );
  const handleDgStatus = useCallback(
    (next: "connecting" | "connected" | "error") =>
      handlePlatformStatus("DG", next),
    [handlePlatformStatus],
  );
  const handleCollectorDgStatus = useCallback(
    (next: "connecting" | "connected" | "error") => {
      handleDgStatus(next);
      publishSharedDg({
        type: "status",
        status: next === "error" ? "offline" : next,
        message:
          next === "connected"
            ? "DG 即時連線中"
            : next === "error"
              ? "DG 即時資料暫停，等待恢復…"
              : "等待 DG 即時資料…",
      });
    },
    [handleDgStatus],
  );
  const handleAbStatus = useCallback(
    (next: "connecting" | "connected" | "error") =>
      handlePlatformStatus("AB", next),
    [handlePlatformStatus],
  );
  const handleMtStatus = useCallback(
    (next: ConnectionStatus) => {
      setConnectedByPlatform((previous) => {
        const connected = next === "connected";
        return previous.MT === connected
          ? previous
          : { ...previous, MT: connected };
      });
      if (activeMenu === "tables" && platform === "MT") setStatus(next);
    },
    [activeMenu, platform],
  );

  const connectOfficialCollector = useCallback(
    async (credentials: CollectorCredentials) => {
      const deviceKey = "mt-tz-device-id";
      let deviceId = localStorage.getItem(deviceKey);
      if (!deviceId) {
        deviceId = createBrowserUuid();
        localStorage.setItem(deviceKey, deviceId);
      }
      const officialBaseUrl = "https://www.tz6868.com";
      const officialResponse = await fetch(`${officialBaseUrl}/api/v1/login`, {
        method: "POST",
        mode: "cors",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          username: credentials.username,
          password: credentials.password,
          device_id: deviceId,
        }),
      });
      const officialPayload = (await officialResponse
        .json()
        .catch(() => null)) as unknown;
      const officialData =
        officialPayload &&
        typeof officialPayload === "object" &&
        "data" in officialPayload &&
        officialPayload.data &&
        typeof officialPayload.data === "object"
          ? (officialPayload.data as Record<string, unknown>)
          : {};
      const officialToken =
        typeof officialData.token === "string" ? officialData.token.trim() : "";
      const officialMessage =
        officialPayload &&
        typeof officialPayload === "object" &&
        "message" in officialPayload &&
        typeof officialPayload.message === "string"
          ? officialPayload.message
          : "";
      if (!officialResponse.ok || !officialToken) {
        if (officialResponse.status === 401 || officialResponse.status === 403)
          throw new Error("MT 專用帳號或密碼不正確。");
        throw new Error(
          officialMessage ||
            `MT 官網登入失敗（HTTP ${officialResponse.status}）。`,
        );
      }
      const [mtLaunchUrl, dgLaunchUrl] = await Promise.all([
        requestOfficialGameUrl(officialBaseUrl, officialToken, "MTLI"),
        requestOfficialGameUrl(officialBaseUrl, officialToken, "DGLI"),
      ]);
      setAbGameUrl(null);
      setDgGameUrl(dgLaunchUrl);
      setMtConnection(parseMtLaunchUrl(mtLaunchUrl));
      setTables([]);
      setTablesByPlatform((previous) => ({ ...previous, MT: [] }));
      setTableUpdatedAt("");
      setMtMessage("採集端待命中，等待觀看需求…");
      setStatus("connecting");
    },
    [],
  );

  // A fixed collector tab can resume after a deployment or page reload. Only
  // a collector-specific encrypted session may obtain these credentials; a
  // regular viewer session receives 401 from this endpoint.
  useEffect(() => {
    if (!mtCollectorMode || isAuthenticated) return;
    const abort = new AbortController();
    const resume = async () => {
      try {
        // Keep the bootstrap key in the fragment, never in the request URL.
        // A fixed collector installation can therefore recover after the
        // browser itself restarts without exposing the key to Render logs.
        const collectorKey = new URLSearchParams(
          window.location.hash.slice(1),
        ).get("collectorKey");
        const response = await fetch("/api/collector/bootstrap", {
          method: "POST",
          cache: "no-store",
          signal: abort.signal,
          headers: {
            "Content-Type": "application/json",
            ...(collectorKey ? { "X-Collector-Bootstrap": collectorKey } : {}),
          },
          body: "{}",
        });
        if (!response.ok) return;
        const result = (await response.json()) as {
          account?: { username?: string };
          collectorCredentials?: CollectorCredentials;
        };
        if (
          !result.collectorCredentials?.username ||
          !result.collectorCredentials.password
        )
          return;
        if (result.account?.username) setUsername(result.account.username);
        setLoginStatus("loading");
        setLoginMessage("採集端正在恢復連線…");
        if (abort.signal.aborted) return;
        setPassword("");
        setLoginStatus("success");
        setLoginMessage("採集端待命中。");
        setCollectorCredentials(result.collectorCredentials);
        setIsAuthenticated(true);
      } catch (error) {
        if (!abort.signal.aborted) {
          setLoginStatus("error");
          setLoginMessage(
            error instanceof Error ? error.message : "採集端恢復失敗。",
          );
        }
      }
    };
    void resume();
    return () => abort.abort();
  }, [connectOfficialCollector, isAuthenticated, mtCollectorMode]);

  useEffect(() => {
    if (!isAuthenticated || mtCollectorMode) return;
    let active = true;
    const refresh = async () => {
      if (focusedPending.current || focusedNeedsSave.current) return;
      const revision = focusedRevision.current;
      try {
        const response = await fetch("/api/focused-tables", {
          cache: "no-store",
        });
        if (!response.ok) throw new Error("關注牌桌暫時無法同步。");
        const data = (await response.json()) as { tables?: string[] };
        if (
          active &&
          !focusedPending.current &&
          revision === focusedRevision.current &&
          Array.isArray(data.tables)
        ) {
          focusedTablesRef.current = data.tables;
          setFocusedTables(data.tables);
          setFocusedSyncError("");
        }
      } catch {
        if (active)
          setFocusedSyncError("關注牌桌暫時無法同步，請稍後重新整理。");
      }
    };
    void refresh();
    const timer = setInterval(() => {
      void refresh();
    }, 15000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [isAuthenticated, mtCollectorMode]);

  const updateFocusedTables = useCallback((next: string[]) => {
    focusedRevision.current += 1;
    focusedTablesRef.current = next;
    setFocusedTables(next);
    focusedPending.current += 1;
    focusedWrites.current = focusedWrites.current
      .catch(() => {})
      .then(async () => {
        try {
          const response = await fetch("/api/focused-tables", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ tables: next }),
          });
          if (!response.ok) throw new Error("關注牌桌儲存失敗。");
          focusedNeedsSave.current = false;
          setFocusedSyncError("");
        } catch {
          focusedNeedsSave.current = true;
          setFocusedSyncError("關注牌桌儲存失敗，請重試。");
        } finally {
          focusedPending.current -= 1;
        }
      });
  }, []);

  const focusTable = useCallback(
    (table: TableInfo, settings?: FocusedTableSettings) => {
      const source = table.id.startsWith("DG:")
        ? "DG"
        : table.id.startsWith("AB:")
          ? "AB"
          : "MT";
      const instanceId = createBrowserUuid().replaceAll("-", "");
      if (settings) {
        const label = source === "AB" ? "歐博" : source;
        const storageScope = `focused:${instanceId}`;
        try {
          window.localStorage.setItem(
            `jshen-card-mode:${label}:${storageScope}`,
            settings.cardMode,
          );
          window.localStorage.setItem(
            `jshen-betting:${label}:${storageScope}`,
            JSON.stringify({
              strategy: settings.bettingStrategy,
              ledger: settings.bettingLedger,
              lastSettledRound: settings.lastSettledRound,
              pendingPrediction: settings.pendingPrediction,
              shoe: settings.bettingShoe,
              roundPositionVersion: settings.bettingRoundPositionVersion,
            }),
          );
          window.localStorage.setItem(
            `jshen-action:${label}:${storageScope}`,
            JSON.stringify({
              strategy: settings.actionStrategy,
              config: settings.actionConfig,
            }),
          );
        } catch {
          /* The followed table is still added when browser storage is unavailable. */
        }
      }
      updateFocusedTables([
        ...focusedTablesRef.current,
        `${source}::${table.id}::${instanceId}`,
      ]);
    },
    [updateFocusedTables],
  );

  const disconnect = () => {
    if (pollTimer.current) {
      clearInterval(pollTimer.current);
      pollTimer.current = null;
    }
    if (mtPingTimer.current) {
      clearInterval(mtPingTimer.current);
      mtPingTimer.current = null;
    }
    if (mtTablesTimer.current) {
      clearInterval(mtTablesTimer.current);
      mtTablesTimer.current = null;
    }
    socket.current?.close();
    socket.current = null;
    setConnectedByPlatform((previous) => ({ ...previous, MT: false }));
    setMtDemand(false);
    setMtConnection(null);
    setAbGameUrl(null);
    setDgGameUrl(null);
    setStatus("idle");
  };

  const logout = async () => {
    setLoggingOut(true);
    setLogoutError("");
    try {
      const response = await fetch(
        `/api/logout${mtCollectorMode ? "?collector=1" : ""}`,
        { method: "POST", signal: AbortSignal.timeout(10000) },
      );
      if (!response.ok) throw new Error("Logout failed");
      disconnect();
      localStorage.removeItem("table-monitor-token");
      setTables([]);
      setTableUpdatedAt("");
      setConnectedByPlatform({ MT: false, DG: false, AB: false });
      focusedTablesRef.current = [];
      setFocusedTables([]);
      setFocusedSyncError("");
      focusedNeedsSave.current = false;
      focusedRevision.current += 1;
      setPassword("");
      setLoginStatus("idle");
      setLoginMessage("");
      setMtConnection(null);
      setIsAuthenticated(false);
    } catch {
      setLogoutError("登出未完成，請再試一次。");
    } finally {
      setLoggingOut(false);
    }
  };

  const login = async (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!username.trim() || !password) {
      setLoginStatus("error");
      setLoginMessage("請輸入帳號與密碼。");
      return;
    }
    setLoginStatus("loading");
    setLoginMessage("");
    try {
      const deviceKey = "mt-tz-device-id";
      let deviceId = localStorage.getItem(deviceKey);
      if (!deviceId) {
        deviceId = createBrowserUuid();
        localStorage.setItem(deviceKey, deviceId);
      }
      const response = await fetch("/api/mt-login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: username.trim(),
          password,
          deviceId,
          collectorMode: mtCollectorMode,
        }),
      });
      // Some reverse proxies return a plain-text error page for a 5xx. Read
      // once and parse defensively so the UI shows the real error instead of
      // masking it with "Unexpected token ... is not valid JSON".
      const raw = await response.text();
      let result: {
        token?: string;
        message?: string;
        collectorCredentials?: { username?: string; password?: string };
        platforms?: {
          MT: { ready: boolean; error?: string };
          DG: { ready: boolean; error?: string };
        };
      } = {};
      try {
        result = raw ? JSON.parse(raw) : {};
      } catch {
        result = {
          message:
            raw.trim() || `登入服務回應錯誤（HTTP ${response.status}）。`,
        };
      }
      if (!response.ok || !result.platforms?.MT.ready)
        throw new Error(result.message || "平台後台尚未設定。");

      // A manual collector recovery saves the official credentials locally.
      // The official platform is contacted only after an actual viewer asks
      // for data, so an idle collector does not burn a short-lived game URL.
      if (mtCollectorMode) {
        const officialUsername =
          result.collectorCredentials?.username?.trim() || username.trim();
        const officialPassword =
          result.collectorCredentials?.password || password;
        setCollectorCredentials({
          username: officialUsername,
          password: officialPassword,
        });
      }
      localStorage.removeItem("table-monitor-token");
      setPassword("");
      focusedTablesRef.current = [];
      setFocusedTables([]);
      focusedNeedsSave.current = false;
      setLoginStatus("success");
      setLoginMessage("登入成功。");
      setIsAuthenticated(true);
    } catch (error) {
      setLoginStatus("error");
      setLoginMessage(
        error instanceof Error ? error.message : "登入失敗，請稍後再試。",
      );
    }
  };

  const hasFocusedMt = focusedTables.some((key) => key.startsWith("MT::"));
  const hasFocusedDg = focusedTables.some((key) => key.startsWith("DG::"));
  const hasFocusedAb = focusedTables.some((key) => key.startsWith("AB::"));

  useEffect(() => {
    // A collector is a background producer, not an MT-tab viewer. It must
    // remain active while any authenticated viewer is online, even if the
    // collector itself is currently showing DG, a menu, or a hidden page.
    const shouldCheckDemand =
      isAuthenticated && mtCollectorMode && collectorCredentials !== null;
    if (!shouldCheckDemand) {
      setMtDemand(false);
      return;
    }
    const abort = new AbortController();
    const checkDemand = async () => {
      try {
        const response = await fetch("/api/mt/shared-feed?role=collector", {
          cache: "no-store",
          signal: abort.signal,
        });
        if (!response.ok) return;
        const result = (await response.json()) as {
          shouldCollect?: boolean;
          viewerCount?: number;
          idleForMs?: number;
        };
        const shouldCollect = result.shouldCollect === true;
        setMtDemand(shouldCollect);
        if (result.viewerCount === 0) {
          if (shouldCollect) {
            setMtMessage("MT 即時資料待命中…");
          } else {
            setMtMessage("等待 MT 即時資料…");
          }
        }
      } catch {
        /* collector will retry while the page remains open */
      }
    };
    void checkDemand();
    const timer = setInterval(() => {
      void checkDemand();
    }, 10000);
    return () => {
      abort.abort();
      clearInterval(timer);
    };
  }, [collectorCredentials, isAuthenticated, mtCollectorMode]);

  // Bootstrap itself is intentionally lightweight. Once a real viewer is
  // present, collector A logs into TZ and obtains fresh MTLI/DGLI URLs. The
  // in-flight guard prevents the 10-second demand poll from opening a second
  // official session while the first authorization is still running.
  useEffect(() => {
    if (
      !isAuthenticated ||
      !mtCollectorMode ||
      !collectorCredentials ||
      !mtDemand ||
      mtConnection ||
      collectorAuthorizeInFlight.current
    )
      return;
    let cancelled = false;
    collectorAuthorizeInFlight.current = true;
    setLoginStatus("loading");
    setLoginMessage("偵測到觀看需求，正在啟動 MT／DG 採集…");
    void connectOfficialCollector(collectorCredentials)
      .then(() => {
        if (!cancelled) {
          setLoginStatus("success");
          setLoginMessage("採集端即時連線中。");
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setLoginStatus("error");
          setLoginMessage(
            error instanceof Error ? error.message : "採集端啟動失敗。",
          );
        }
      })
      .finally(() => {
        collectorAuthorizeInFlight.current = false;
      });
    return () => {
      cancelled = true;
    };
  }, [
    collectorCredentials,
    connectOfficialCollector,
    isAuthenticated,
    mtCollectorMode,
    mtConnection,
    mtDemand,
  ]);

  // When the last viewer has been gone for the grace period, release the
  // short-lived official URLs. A future viewer causes a clean authorization
  // instead of attempting to reuse an expired MTLI/DGLI token.
  useEffect(() => {
    if (!isAuthenticated || !mtCollectorMode || mtDemand) return;
    socket.current?.close();
    socket.current = null;
    setMtConnection(null);
    setDgGameUrl(null);
    setConnectedByPlatform((previous) => ({
      ...previous,
      MT: false,
      DG: false,
    }));
  }, [isAuthenticated, mtCollectorMode, mtDemand]);

  useEffect(() => {
    const shouldStreamMt =
      isAuthenticated && mtCollectorMode && mtConnection !== null && mtDemand;
    if (!shouldStreamMt) return;
    const abort = new AbortController();
    const sharedKey = mtSharedChannelKey(mtConnection);
    const leaseKey = `${sharedKey}-leader`;
    const channel =
      typeof BroadcastChannel !== "undefined"
        ? new BroadcastChannel(sharedKey)
        : null;
    const owner = mtClientId.current;
    let ws: WebSocket | undefined;
    let leaseTimer: ReturnType<typeof setInterval> | null = null;
    let retryTimer: ReturnType<typeof setInterval> | null = null;
    let isLeader = false;
    let leaderTables: TableInfo[] = [];
    let joinedMtTables = "";

    setTables([]);
    setTableUpdatedAt("");
    handleMtStatus("connecting");
    setMtMessage("正在連線 MT…");
    publishSharedMt({
      type: "status",
      status: "connecting",
      message: "MT 即時連線建立中…",
    });

    const applyPacket = async (
      data: Record<string, unknown>,
      fromShared = false,
    ) => {
      if (abort.signal.aborted) return;
      if (data.type === "reset") {
        setTables([]);
        handleMtStatus("connecting");
        return;
      }
      if (data.type === "error") {
        handleMtStatus("error");
        const message =
          typeof data.message === "string" ? data.message : "MT 串流中斷。";
        setMtMessage(message);
        if (isLeader)
          publishSharedMt({ type: "status", status: "offline", message });
        return;
      }
      // Only the elected leader is allowed to send official MT commands. A
      // follower may receive the auth response through BroadcastChannel but
      // must never authenticate a second upstream socket.
      if (!fromShared && data.action === "/api/v1/authenticate") {
        if (Number(data.err ?? 0) !== 0) {
          handleMtStatus("error");
          setMtMessage("MT 授權失敗，請重新登入官方頁面並貼上新的網址。");
          ws?.close();
          return;
        }
        ws?.send(mtMemberMessage("zhtw"));
        ws?.send(mtTablesMessage());
        if (mtPingTimer.current) clearInterval(mtPingTimer.current);
        mtPingTimer.current = setInterval(() => {
          if (ws?.readyState === WebSocket.OPEN) ws.send(mtPingMessage());
        }, 5000);
        // The official MT lobby refreshes its table list every five seconds.
        // The initial /tables response contains the road snapshot only; the
        // live countdown is delivered by later table updates (/wait, etc.).
        // Polling the same authenticated WebSocket keeps those updates flowing
        // without opening another socket or rebuilding the card layout.
        if (mtTablesTimer.current) clearInterval(mtTablesTimer.current);
        mtTablesTimer.current = setInterval(() => {
          if (ws?.readyState === WebSocket.OPEN) ws.send(mtTablesMessage());
        }, 5000);
        setMtMessage("MT 已完成授權，正在取得桌況…");
        return;
      }
      if (data.action === "/api/v1/member/logout") {
        handleMtStatus("error");
        setMtMessage("MT 官方工作階段已失效，請重新貼上登入後的新網址。");
        return;
      }
      const payloads =
        data.type === "tables" && Array.isArray(data.tables)
          ? data.tables.map((row: unknown) =>
              row && typeof row === "object" && "payload" in row
                ? (row as { payload: unknown }).payload
                : row,
            )
          : data;
      const updates = extractTableUpdates(payloads);
      if (updates.length === 0) return;
      const isTableSnapshot =
        data.action === "/api/v1/gametype/*/game/*/room/*/tables";
      if (!fromShared && isTableSnapshot && ws?.readyState === WebSocket.OPEN) {
        const tableIds = updates
          .map((update) => update.id)
          .filter(Boolean)
          .sort()
          .join(",");
        if (tableIds && tableIds !== joinedMtTables) {
          ws.send(mtMultipleJoinMessage(tableIds.split(",")));
          joinedMtTables = tableIds;
        }
      }
      setTables((current) => {
        const merged = mergeTableUpdates(current, updates);
        leaderTables = merged;
        setTablesByPlatform((previous) => ({ ...previous, MT: merged }));
        if (isLeader) publishSharedMt({ type: "snapshot", tables: merged });
        return merged;
      });
      setTableUpdatedAt(now());
      handleMtStatus("connected");
      setMtMessage("MT 即時連線中");
    };

    const openLeaderSocket = () => {
      if (abort.signal.aborted) return;
      isLeader = true;
      channel?.postMessage({ type: "leader", owner });
      handleMtStatus("connecting");
      setMtMessage("MT 即時連線建立中…");
      publishSharedMt({
        type: "status",
        status: "connecting",
        message: "MT 即時連線建立中…",
      });
      try {
        // MT local-test mode deliberately keeps the token in the browser. It
        // does not call the server-side /api/mt/start route or launch Edge.
        ws = new WebSocket(mtConnection.websocketUrl);
        socket.current = ws;
        ws.onopen = () => {
          if (abort.signal.aborted) {
            ws?.close();
            return;
          }
          ws?.send(mtAuthenticateMessage(mtConnection.token));
          handleMtStatus("authenticating");
          setMtMessage("MT WebSocket 已建立，等待桌況…");
          publishSharedMt({
            type: "status",
            status: "connecting",
            message: "MT 已建立連線，等待桌況…",
          });
        };
        ws.onmessage = (event) => {
          void (async () => {
            try {
              const raw = await readMtWebSocketMessage(event.data);
              if (!raw) return;
              const data = JSON.parse(raw) as Record<string, unknown>;
              channel?.postMessage({ type: "packet", payload: data });
              await applyPacket(data);
            } catch {
              // Official heartbeats and binary control frames are allowed; only
              // report a connection error after the socket itself closes.
            }
          })();
        };
        ws.onerror = () => {
          if (!abort.signal.aborted) {
            const message =
              "MT WebSocket 連線失敗，請確認網址或官方是否允許區網來源。";
            handleMtStatus("error");
            setMtMessage(message);
            publishSharedMt({ type: "status", status: "offline", message });
          }
        };
        ws.onclose = () => {
          releaseMtLease(leaseKey, owner);
          if (!abort.signal.aborted) {
            const message = "MT WebSocket 已關閉，請重新貼上授權網址。";
            handleMtStatus("error");
            setMtMessage(message);
            publishSharedMt({ type: "status", status: "offline", message });
          }
        };
      } catch (error) {
        releaseMtLease(leaseKey, owner);
        if (!abort.signal.aborted) {
          const message =
            error instanceof Error ? error.message : "MT WebSocket 無法建立。";
          handleMtStatus("error");
          setMtMessage(message);
          publishSharedMt({ type: "status", status: "offline", message });
        }
      }
    };

    const tryBecomeLeader = () => {
      if (abort.signal.aborted || isLeader) return;
      // Very old/private browser contexts may not expose BroadcastChannel.
      // Keep the original single-tab connection as a safe fallback instead
      // of leaving that tab waiting forever for a shared owner.
      if (!channel) {
        openLeaderSocket();
        return;
      }
      if (!claimMtLease(leaseKey, owner)) {
        handleMtStatus("connecting");
        setMtMessage("MT 即時資料待命中…");
        channel?.postMessage({ type: "hello", owner });
        return;
      }
      isLeader = true;
      leaseTimer = setInterval(
        () => {
          if (!renewMtLease(leaseKey, owner)) {
            isLeader = false;
            ws?.close();
          }
        },
        Math.max(1000, Math.floor(MT_LEASE_MS / 2)),
      );
      openLeaderSocket();
    };

    if (channel) {
      channel.onmessage = (event) => {
        const message = event.data as {
          type?: string;
          owner?: string;
          payload?: Record<string, unknown>;
          tables?: TableInfo[];
        };
        if (message.type === "hello" && isLeader)
          channel.postMessage({
            type: "snapshot",
            owner,
            tables: leaderTables,
          });
        if (
          message.type === "snapshot" &&
          !isLeader &&
          Array.isArray(message.tables) &&
          message.tables.length > 0
        ) {
          leaderTables = message.tables;
          setTables(message.tables);
          setTablesByPlatform((previous) => ({
            ...previous,
            MT: message.tables!,
          }));
          setTableUpdatedAt(now());
          handleMtStatus("connected");
          setMtMessage("MT 即時連線中");
        }
        if (message.type === "packet" && !isLeader && message.payload)
          void applyPacket(message.payload, true);
      };
      channel.postMessage({ type: "hello", owner });
    }
    tryBecomeLeader();
    retryTimer = setInterval(tryBecomeLeader, 1500);

    return () => {
      if (isLeader) {
        publishSharedMt({
          type: "status",
          status: "offline",
          message: "MT 即時資料暫停，等待恢復…",
        });
        setTables([]);
        setTablesByPlatform((previous) => ({ ...previous, MT: [] }));
        setTableUpdatedAt("");
      }
      abort.abort();
      if (retryTimer) clearInterval(retryTimer);
      if (leaseTimer) clearInterval(leaseTimer);
      releaseMtLease(leaseKey, owner);
      ws?.close();
      if (mtPingTimer.current) {
        clearInterval(mtPingTimer.current);
        mtPingTimer.current = null;
      }
      if (mtTablesTimer.current) {
        clearInterval(mtTablesTimer.current);
        mtTablesTimer.current = null;
      }
      if (socket.current === ws) socket.current = null;
      channel?.close();
      setConnectedByPlatform((previous) => ({ ...previous, MT: false }));
    };
  }, [
    isAuthenticated,
    mtCollectorMode,
    mtConnection,
    mtDemand,
    handleMtStatus,
  ]);

  // Viewer mode uses short-lived JSON requests: Render's edge runtime can
  // retain long-lived SSE connections after a tab closes. The separate 15s
  // presence heartbeat above owns viewer liveness; polling is read-only.
  useEffect(() => {
    const shouldSubscribe =
      isAuthenticated &&
      (activeMenu === "curated" ||
        (activeMenu === "tables" && platform === "MT") ||
        (activeMenu === "compare" && hasFocusedMt)) &&
      mtConnection === null;
    if (!shouldSubscribe) return;
    const abort = new AbortController();
    let inFlight = false;
    setTables([]);
    setTableUpdatedAt("");
    handleMtStatus("connecting");
    setMtMessage("等待 MT 即時資料…");
    const poll = async () => {
      if (inFlight || abort.signal.aborted) return;
      inFlight = true;
      try {
        const response = await fetch("/api/mt/shared-feed", {
          cache: "no-store",
          signal: abort.signal,
        });
        if (!response.ok) throw new Error(`shared feed ${response.status}`);
        const message = (await response.json()) as {
          type?: string;
          tables?: TableInfo[];
          status?: string;
          message?: string;
          receivedAt?: number;
          stale?: boolean;
        };
        if (message.type === "snapshot" && Array.isArray(message.tables)) {
          setTables(message.tables);
          setTablesByPlatform((previous) => ({
            ...previous,
            MT: message.tables!,
          }));
          setTableUpdatedAt(receivedAtTime(message.receivedAt));
          handleMtStatus("connected");
          setMtMessage("MT 即時資料同步中");
          return;
        }
        if (message.type === "status") {
          if (message.stale === true || message.status === "offline") {
            // Keep the last verified snapshot visible during a short
            // collector outage. Clearing it here was the source of the
            // full-card flicker whenever MT reconnected.
            handleMtStatus("error");
            setMtMessage(
              message.message ||
                (message.stale
                  ? "MT 資料已逾時，等待採集端恢復…"
                  : "MT 即時資料暫停，等待恢復…"),
            );
          } else {
            handleMtStatus("connecting");
            setMtMessage(message.message || "等待 MT 即時資料…");
          }
        }
      } catch {
        if (!abort.signal.aborted) {
          handleMtStatus("connecting");
          setMtMessage("MT 即時資料重新連線中…");
        }
      } finally {
        inFlight = false;
      }
    };
    void poll();
    const timer = setInterval(() => {
      void poll();
    }, 1000);
    return () => {
      abort.abort();
      clearInterval(timer);
      setConnectedByPlatform((previous) => ({ ...previous, MT: false }));
    };
  }, [
    activeMenu,
    handleMtStatus,
    hasFocusedMt,
    isAuthenticated,
    mtConnection,
    platform,
  ]);

  // Viewer mode never opens a DG relay/WebSocket. It polls only the snapshot
  // published by collector A, matching the MT ownership model exactly.
  useEffect(() => {
    const shouldSubscribe =
      isAuthenticated &&
      !mtCollectorMode &&
      (activeMenu === "curated" ||
        (activeMenu === "tables" && platform === "DG") ||
        (activeMenu === "compare" && hasFocusedDg));
    if (!shouldSubscribe) return;
    const abort = new AbortController();
    let inFlight = false;
    setDgMessage("等待 DG 即時資料…");
    const poll = async () => {
      if (inFlight || abort.signal.aborted) return;
      inFlight = true;
      try {
        const response = await fetch("/api/dg/shared-feed", {
          cache: "no-store",
          signal: abort.signal,
        });
        if (!response.ok) throw new Error(`shared feed ${response.status}`);
        const message = (await response.json()) as {
          type?: string;
          tables?: TableInfo[];
          status?: string;
          message?: string;
          receivedAt?: number;
          stale?: boolean;
        };
        if (message.type === "snapshot" && Array.isArray(message.tables)) {
          handleDgTables(message.tables);
          setDgUpdatedAt(receivedAtTime(message.receivedAt));
          setDgMessage("DG 即時資料同步中");
          handleDgStatus("connected");
          return;
        }
        if (message.type === "status") {
          setDgMessage(
            message.message ||
              (message.stale
                ? "DG 資料已逾時，等待採集端恢復…"
                : "等待 DG 即時資料…"),
          );
          handleDgStatus(
            message.stale === true || message.status === "offline"
              ? "error"
              : "connecting",
          );
        }
      } catch {
        if (!abort.signal.aborted) {
          setDgMessage("DG 即時資料重新連線中…");
          handleDgStatus("connecting");
        }
      } finally {
        inFlight = false;
      }
    };
    void poll();
    const timer = setInterval(() => {
      void poll();
    }, 1000);
    return () => {
      abort.abort();
      clearInterval(timer);
      setConnectedByPlatform((previous) => ({ ...previous, DG: false }));
    };
  }, [
    activeMenu,
    handleDgStatus,
    handleDgTables,
    hasFocusedDg,
    isAuthenticated,
    mtCollectorMode,
    platform,
  ]);

  // AB follows the same read-only viewer model as DG. It must never open a
  // second official session from a viewer tab.
  useEffect(() => {
    const shouldSubscribe =
      isAuthenticated &&
      !mtCollectorMode &&
      (activeMenu === "curated" ||
        (activeMenu === "tables" && platform === "AB") ||
        (activeMenu === "compare" && hasFocusedAb));
    if (!shouldSubscribe) return;
    const abort = new AbortController();
    let inFlight = false;
    setAbMessage("等待 歐博 即時資料…");
    const poll = async () => {
      if (inFlight || abort.signal.aborted) return;
      inFlight = true;
      try {
        const response = await fetch("/api/ab/shared-feed", {
          cache: "no-store",
          signal: abort.signal,
        });
        if (!response.ok) throw new Error(`shared feed ${response.status}`);
        const message = (await response.json()) as {
          type?: string;
          tables?: TableInfo[];
          status?: string;
          message?: string;
          receivedAt?: number;
          stale?: boolean;
        };
        if (message.type === "snapshot" && Array.isArray(message.tables)) {
          handleAbTables(message.tables);
          setAbUpdatedAt(receivedAtTime(message.receivedAt));
          setAbMessage("歐博 即時資料同步中");
          handleAbStatus("connected");
          return;
        }
        if (message.type === "status") {
          setAbMessage(
            message.message ||
              (message.stale
                ? "歐博 資料已逾時，等待採集端恢復…"
                : "等待 歐博 即時資料…"),
          );
          handleAbStatus(
            message.stale === true || message.status === "offline"
              ? "error"
              : "connecting",
          );
        }
      } catch {
        if (!abort.signal.aborted) {
          setAbMessage("歐博 即時資料重新連線中…");
          handleAbStatus("connecting");
        }
      } finally {
        inFlight = false;
      }
    };
    void poll();
    const timer = setInterval(() => {
      void poll();
    }, 1000);
    return () => {
      abort.abort();
      clearInterval(timer);
      setConnectedByPlatform((previous) => ({ ...previous, AB: false }));
    };
  }, [
    activeMenu,
    handleAbStatus,
    handleAbTables,
    hasFocusedAb,
    isAuthenticated,
    mtCollectorMode,
    platform,
  ]);

  if (!isAuthenticated && checkingSession) {
    return <main className="grid min-h-screen place-items-center bg-[#101a2c] text-sm text-white">正在確認登入狀態…</main>;
  }

  if (!isAuthenticated) {
    return (
      <main className="ofa-shell grid min-h-screen place-items-center px-4 py-10 text-[#f7edda]">
        <section className="w-full max-w-md overflow-hidden rounded-2xl border border-[#9d7536]/40 bg-[#0d0b08]/95 shadow-[0_30px_100px_rgba(0,0,0,.58)] backdrop-blur-xl">
          <div className="h-px bg-gradient-to-r from-transparent via-[#e5bd69] to-transparent" />
          <div className="p-6 sm:p-8">
            <div className="mb-8 text-center">
              <div className="mx-auto mb-5 grid h-16 w-16 place-items-center rounded-2xl border border-[#e6c273]/35 bg-gradient-to-b from-[#2a2012] to-[#0e0b07] shadow-[0_0_35px_rgba(197,145,52,.14)]">
                <img
                  src="/jshen-logo.svg"
                  alt="J神・圖形來世 Logo"
                  width="56"
                  height="56"
                />
              </div>
              <p className="text-[10px] font-semibold tracking-[.24em] text-[#c9a55e]">
                即時牌卡預測系統
              </p>
              <h1 className="mt-2 text-2xl font-semibold text-[#fff7e6]">
                J神・圖形來世
              </h1>
            </div>
            {(defaultUsername || defaultPassword) && (
              <div className="mb-5 rounded-lg border border-amber-300/25 bg-amber-300/[0.07] px-4 py-3 text-xs leading-5 text-amber-200">
                測試帳密已由本機環境預填。正式上線前必須移除
                .env.development.local。
              </div>
            )}
            <form onSubmit={login} name="jshen-login" className="grid gap-4">
              <label className="grid gap-2 text-sm font-medium text-[#cbb894]">
                帳號
                <input
                  id="jshen-username"
                  name="jshen-username"
                  value={username}
                  onChange={(event) => setUsername(event.target.value)}
                  autoComplete="section-jshen username"
                  placeholder="輸入帳號"
                  className="h-12 rounded-lg border border-[#705429]/55 bg-black/40 px-4 text-sm text-[#fff4dc] outline-none transition placeholder:text-[#675b48] focus:border-[#d0a653] focus:ring-2 focus:ring-[#d0a653]/10"
                />
              </label>
              <label className="grid gap-2 text-sm font-medium text-[#cbb894]">
                密碼
                <input
                  id="jshen-password"
                  name="jshen-password"
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  autoComplete="section-jshen current-password"
                  placeholder="輸入密碼"
                  className="h-12 rounded-lg border border-[#705429]/55 bg-black/40 px-4 text-sm text-[#fff4dc] outline-none transition placeholder:text-[#675b48] focus:border-[#d0a653] focus:ring-2 focus:ring-[#d0a653]/10"
                />
              </label>
              {loginMessage && (
                <p className="text-sm text-rose-300">{loginMessage}</p>
              )}
              <button
                type="submit"
                disabled={loginStatus === "loading"}
                className="mt-2 flex h-12 items-center justify-center gap-2 rounded-lg bg-gradient-to-b from-[#f0d58f] to-[#bd8734] px-6 text-sm font-bold text-[#211406] shadow-[0_10px_28px_rgba(186,128,41,.2)] transition hover:brightness-110 disabled:cursor-wait disabled:opacity-60"
              >
                {loginStatus === "loading" ? (
                  <LoaderCircle className="h-4 w-4 animate-spin" />
                ) : (
                  <LogIn className="h-4 w-4" />
                )}
                {loginStatus === "loading" ? "正在驗證" : "登入系統"}
              </button>
            </form>
            <div className="mt-4 flex flex-wrap items-center justify-center gap-3 text-sm">
              <span className="text-[#a98a50]">還沒有帳號？</span>
              <a
                href="https://jrk.tz6868.com/"
                target="_blank"
                rel="noopener noreferrer"
                aria-label="註冊帳號（另開分頁）"
                className="inline-flex min-h-10 items-center justify-center rounded-lg border border-[#9d7536]/60 px-4 font-semibold text-[#f0ce83] transition hover:bg-[#9d7536]/15 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[#f0ce83]"
              >
                註冊帳號
              </a>
            </div>
            <section
              aria-label="登入協助與聯絡資訊"
              className="mt-6 grid justify-items-center gap-3 border-t border-[#9d7536]/25 pt-5"
            >
              <p className="text-sm font-medium text-[#e3c68e]">
                需要登入協助？歡迎聯絡我們
              </p>
              <ContactLinks />
              <p className="text-xs text-[#a98a50]">
                LINE 掃碼加好友 · Threads @kevin_09145
              </p>
            </section>
          </div>
        </section>
      </main>
    );
  }

  return (
    <AiObservationProvider tablesByPlatform={tablesByPlatform} connectedByPlatform={connectedByPlatform}>
    <main className="ofa-shell min-h-screen pb-[calc(6rem+env(safe-area-inset-bottom))] text-[#f7edda] lg:pb-0">
      <PayoutWinnerNotification />
      <PayoutBroadcastNotification />
      <FloatingBrowser />
      <div
        className={`min-h-screen lg:grid ${menuCollapsed ? "lg:grid-cols-[78px_minmax(0,1fr)]" : "lg:grid-cols-[250px_minmax(0,1fr)]"}`}
      >
        <aside className="border-b border-[#86632f]/35 bg-[#0a0806]/95 px-3 py-3 lg:sticky lg:top-0 lg:h-screen lg:border-b-0 lg:border-r lg:px-5 lg:py-7">
          <div
            className={`flex items-center gap-3 ${menuCollapsed ? "justify-center" : "px-2"}`}
          >
            <div className="grid h-11 w-11 shrink-0 place-items-center rounded-xl border border-[#e6c273]/35 bg-gradient-to-b from-[#2a2012] to-[#0e0b07]">
              <img
                src="/jshen-logo.svg"
                alt="J神・圖形來世 Logo"
                width="40"
                height="40"
              />
            </div>
            <div className={menuCollapsed ? "hidden" : ""}>
              <p className="whitespace-nowrap text-base font-bold text-[#f7e5bc]">
                J神・圖形來世
              </p>
              <p className="mt-1 text-[10px] tracking-wide text-[#a98a50]">
                即時牌卡預測系統
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => setMenuCollapsed((value) => !value)}
            className="mt-5 hidden h-9 w-full items-center justify-center rounded-lg border border-[#765728]/35 text-[#a98a50] transition hover:bg-white/[0.04] hover:text-[#f0ce83] lg:flex"
            aria-label={menuCollapsed ? "展開選單" : "收合選單"}
          >
            {menuCollapsed ? (
              <ChevronRight className="h-4 w-4" />
            ) : (
              <>
                <ChevronLeft className="mr-2 h-4 w-4" />
                <span className="text-xs">收合選單</span>
              </>
            )}
          </button>
          <nav
            className="mt-4 hidden grid-cols-2 gap-2 lg:mt-10 lg:grid lg:grid-cols-1"
            aria-label="主選單"
          >
            <button
              type="button"
              title="J神嚴選"
              onClick={() => setActiveMenu("curated")}
              className={`flex items-center rounded-lg border px-3 py-3 text-sm transition ${menuCollapsed ? "justify-center" : "gap-3"} ${activeMenu === "curated" ? "border-amber-300/55 bg-amber-300/10 font-medium text-amber-100" : "border-transparent text-slate-400 hover:border-amber-300/30 hover:bg-amber-300/5"}`}
            >
              <Crown className="h-4 w-4 shrink-0" />
              <span className={menuCollapsed ? "hidden" : ""}>J神嚴選</span>
            </button>
            <button
              type="button"
              title="即時桌況"
              onClick={() => setActiveMenu("tables")}
              className={`flex items-center rounded-lg border px-3 py-3 text-sm transition ${menuCollapsed ? "justify-center" : "gap-3"} ${activeMenu === "tables" ? "border-cyan-400/45 bg-cyan-400/10 font-medium text-cyan-100" : "border-transparent text-slate-400 hover:border-cyan-400/30 hover:bg-cyan-400/5"}`}
            >
              <LayoutGrid className="h-4 w-4 shrink-0" />
              <span className={menuCollapsed ? "hidden" : ""}>即時桌況</span>
            </button>
            <button
              type="button"
              title="關注牌桌"
              onClick={() => setActiveMenu("compare")}
              className={`flex items-center rounded-lg border px-3 py-3 text-sm transition ${menuCollapsed ? "justify-center" : "gap-3"} ${activeMenu === "compare" ? "border-cyan-400/55 bg-cyan-400/10 font-medium text-cyan-100" : "border-transparent text-slate-400 hover:border-cyan-400/30 hover:bg-cyan-400/5"}`}
            >
              <LayoutGrid className="h-4 w-4 shrink-0" />
              <span className={menuCollapsed ? "hidden" : ""}>關注牌桌</span>
            </button>
            <button
              type="button"
              title="回歸測試"
              onClick={() => {
                disconnect();
                setActiveMenu("regression");
              }}
              className={`flex items-center rounded-lg border px-3 py-3 text-sm transition ${menuCollapsed ? "justify-center" : "gap-3"} ${activeMenu === "regression" ? "border-cyan-400/55 bg-cyan-400/10 font-medium text-cyan-100" : "border-transparent text-slate-400 hover:border-cyan-400/30 hover:bg-cyan-400/5"}`}
            >
              <CircleDot className="h-4 w-4 shrink-0" />
              <span className={menuCollapsed ? "hidden" : ""}>回歸測試</span>
            </button>
            <button
              type="button"
              title="獎池"
              onClick={() => {
                disconnect();
                setActiveMenu("payout");
              }}
              className={`flex items-center rounded-lg border px-3 py-3 text-sm transition ${menuCollapsed ? "justify-center" : "gap-3"} ${activeMenu === "payout" ? "border-cyan-400/45 bg-cyan-400/10 font-medium text-cyan-100" : "border-transparent text-slate-400 hover:border-cyan-400/30 hover:bg-cyan-400/5"}`}
            >
              <Gift className="h-4 w-4 shrink-0" />
              <span className={menuCollapsed ? "hidden" : ""}>獎池</span>
            </button>
            <div className="hidden lg:block">
              {!menuCollapsed && <PoolMenuCards />}
            </div>
            <div className="hidden lg:block">
              <OnlineUsersCard collapsed={menuCollapsed} />
            </div>
          </nav>
        </aside>

        <nav aria-label="手機版主選單" className="fixed inset-x-0 bottom-0 z-40 grid grid-cols-5 border-t border-[#86632f]/45 bg-[#0a0806]/95 px-1 pt-2 pb-[calc(0.5rem+env(safe-area-inset-bottom))] backdrop-blur lg:hidden">
          {([
            { key: "curated", label: "J神嚴選", icon: Crown },
            { key: "tables", label: "即時桌況", icon: LayoutGrid },
            { key: "compare", label: "關注牌桌", icon: LayoutGrid },
            { key: "regression", label: "回歸測試", icon: CircleDot },
            { key: "payout", label: "獎池", icon: Gift },
          ] as const).map(({ key, label, icon: Icon }) => (
            <button
              key={key}
              type="button"
              aria-current={activeMenu === key ? "page" : undefined}
              onClick={() => {
                if (key === "regression" || key === "payout") disconnect();
                setActiveMenu(key);
              }}
              className={`flex min-w-0 flex-col items-center justify-center gap-1 rounded-lg px-0.5 py-1 text-[10px] leading-tight ${activeMenu === key ? "bg-amber-300/10 text-amber-100" : "text-slate-400"}`}
            >
              <Icon className="h-5 w-5" />
              <span className="whitespace-nowrap">{label}</span>
            </button>
          ))}
        </nav>

        <div className="min-w-0 px-4 py-5 sm:px-7 sm:py-8 lg:px-8">
          <div className="min-w-0">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
              {activeMenu === "tables" && (
                <div role="tablist" aria-label="平台" className="flex gap-2">
                  {(["MT", "DG", "AB"] as const).map((value) => (
                    <button
                      key={value}
                      role="tab"
                      type="button"
                      aria-selected={platform === value}
                      aria-controls="platform-content"
                      id={`platform-${value}`}
                      onClick={() => {
                        if (platform !== value) {
                          setStatus("connecting");
                          setPlatform(value);
                        }
                      }}
                      className={`rounded-lg border px-6 py-2 font-bold ${platform === value ? "border-cyan-400 bg-cyan-700 text-white" : "border-slate-600 text-slate-400"}`}
                    >
                      {value === "AB" ? "歐博" : value}
                    </button>
                  ))}
                </div>
              )}
              <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
                <ContactLinks />
                <button
                  type="button"
                  onClick={logout}
                  disabled={loggingOut}
                  className="flex h-10 items-center gap-2 rounded-lg border border-slate-600 px-4 text-sm text-white hover:bg-white/10 disabled:opacity-50"
                >
                  <LogOut className="h-4 w-4" />
                  {loggingOut ? "登出中…" : "登出"}
                </button>
                {logoutError && (
                  <span role="alert" className="text-sm text-rose-300">
                    {logoutError}
                  </span>
                )}
              </div>
            </div>
            {/* Collector A owns the upstream DG session.  It must not also mount a
            viewer subscription here: doing so creates a second DG socket from
            the same browser and can make the shared feed reset/reconnect. */}
            {isAuthenticated && !mtCollectorMode && (
              <div
                className={
                  activeMenu === "tables" && platform === "DG" ? "" : "hidden"
                }
                aria-hidden={activeMenu !== "tables" || platform !== "DG"}
              >
                <DgSharedMonitor
                  tables={tablesByPlatform.DG}
                  connected={connectedByPlatform.DG}
                  message={dgMessage}
                  updatedAt={dgUpdatedAt}
                  onFocusTable={focusTable}
                  cardColumns={cardsPerRow}
                  onCardColumnsChange={setCardsPerRow}
                />
              </div>
            )}
            {isAuthenticated && !mtCollectorMode && (
              <div
                className={
                  activeMenu === "tables" && platform === "AB" ? "" : "hidden"
                }
                aria-hidden={activeMenu !== "tables" || platform !== "AB"}
              >
                <DgSharedMonitor
                  tables={tablesByPlatform.AB}
                  connected={connectedByPlatform.AB}
                  message={abMessage}
                  updatedAt={abUpdatedAt}
                  onFocusTable={focusTable}
                  cardColumns={cardsPerRow}
                  onCardColumnsChange={setCardsPerRow}
                  platformLabel="歐博"
                />
              </div>
            )}
            {/* Collector A opens the official DG game URL in the relay worker.
            Viewer tabs subscribe to that shared feed without opening DG. */}
            {isAuthenticated && mtCollectorMode && mtDemand && dgGameUrl && (
              <div className="hidden" aria-hidden="true">
                <DgMonitor
                  gameUrl={dgGameUrl}
                  collector
                  onStatus={handleCollectorDgStatus}
                  onTables={handleCollectorDgTables}
                  cardColumns={cardsPerRow}
                  onCardColumnsChange={setCardsPerRow}
                />
              </div>
            )}
            {/* Collector A keeps one shared AB subscription alive just like MT.
            Viewer tabs do not open another official session; they subscribe
            to the relay's cached feed. */}
            {ENABLE_BROWSER_AB &&
              isAuthenticated &&
              mtCollectorMode &&
              abGameUrl && (
                <div className="hidden" aria-hidden="true">
                  <AbMonitor
                    gameUrl={abGameUrl}
                    collector
                    onStatus={handleAbStatus}
                    onTables={handleAbTables}
                    cardColumns={cardsPerRow}
                    onCardColumnsChange={setCardsPerRow}
                  />
                </div>
              )}
            {activeMenu === "curated" ? (
              <JshenPicks tablesByPlatform={tablesByPlatform} connectedByPlatform={connectedByPlatform} cardsPerRow={cardsPerRow} onCardsPerRowChange={setCardsPerRow} onFocusTable={focusTable} />
            ) : activeMenu === "regression" ? (
              <RegressionTest />
            ) : activeMenu === "payout" ? (
              <PayoutFeature />
            ) : activeMenu === "compare" ? (
              <>
                {focusedSyncError && (
                  <p role="alert" className="mb-2 text-sm text-amber-200">
                    {focusedSyncError}{" "}
                    {focusedNeedsSave.current && (
                      <button
                        type="button"
                        onClick={() =>
                          updateFocusedTables(focusedTablesRef.current)
                        }
                        className="underline"
                      >
                        重試儲存
                      </button>
                    )}
                  </p>
                )}
                <FocusedTableCompare
                  tablesByPlatform={tablesByPlatform}
                  connectedByPlatform={connectedByPlatform}
                  selected={focusedTables}
                  onSelectedChange={updateFocusedTables}
                  cardsPerRow={cardsPerRow}
                  onCardsPerRowChange={setCardsPerRow}
                  onFocusTable={focusTable}
                />
                <div className="hidden" aria-hidden="true">
                  {ENABLE_BROWSER_AB && hasFocusedAb && (
                    <AbMonitor
                      gameUrl={abGameUrl}
                      onStatus={handleAbStatus}
                      onTables={handleAbTables}
                      cardColumns={cardsPerRow}
                      onCardColumnsChange={setCardsPerRow}
                    />
                  )}
                </div>
              </>
            ) : (
              <div
                id="platform-content"
                role="tabpanel"
                aria-labelledby={`platform-${platform}`}
              >
                <h1 className="sr-only">
                  {platform === "AB" ? "歐博" : platform} · 即時桌況
                </h1>

                {ENABLE_BROWSER_AB && platform === "AB" && (
                  <AbMonitor
                    gameUrl={abGameUrl}
                    onStatus={handleAbStatus}
                    onTables={handleAbTables}
                    onFocusTable={focusTable}
                    cardColumns={cardsPerRow}
                    onCardColumnsChange={setCardsPerRow}
                  />
                )}
                {platform === "MT" && (
                  <>
                    <section className="overflow-hidden rounded-2xl border border-[#86632f]/35 bg-[#0d0b08]/92">
                      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-[#5d451f]/60 px-6 py-4">
                        <div>
                          <h2 className="text-lg font-semibold">
                            即時桌況{" "}
                            <span className="ml-2 rounded-md border px-2 py-0.5 text-xs">
                              {tables.length} 桌
                            </span>
                          </h2>
                          <p className="mt-1 text-xs">
                            {status === "connected" && tableUpdatedAt
                              ? `最後更新 ${tableUpdatedAt}`
                              : mtMessage}
                          </p>
                        </div>
                        <CardLayoutSelect
                          value={cardsPerRow}
                          onChange={setCardsPerRow}
                        />
                      </header>
                      <div
                        className={`grid w-full min-w-0 gap-3 bg-transparent p-2 ${cardGridColumns[cardsPerRow]}`}
                      >
                        {tables.map((table) => (
                          <BaccaratTableCard
                            key={table.id}
                            table={table}
                            connected={status === "connected"}
                            onFocusTable={focusTable}
                            platformLabel="MT"
                          />
                        ))}
                      </div>
                    </section>
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </main>
    </AiObservationProvider>
  );
}
