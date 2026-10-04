"use client";

import { FormEvent, useEffect, useRef, useState } from "react";
import { LogOut, Maximize2, Minimize2, PanelTopOpen } from "lucide-react";
import { dgGameUrlForTable } from "@/lib/dg-game-url";
import { mtGameUrlForTable } from "@/lib/mt-game-url";

type Platform = "MT" | "DG" | "歐博";
const openEvent = "jshen:open-floating-browser";
export function openFloatingBrowser(platform: Platform, tableId: string) {
  window.dispatchEvent(new CustomEvent(openEvent, { detail: { platform, tableId } }));
}
const platforms: Platform[] = ["MT", "DG", "歐博"];
const gameCodes: Record<Platform, string> = { MT: "MTLI", DG: "DGLI", 歐博: "AB01" };
const officialBase = "https://www.tz6868.com";
const lastUsernameKey = "jshen:tz-last-username";
const emptyUrls: Record<Platform, string> = { MT: "", DG: "", 歐博: "" };

function getToken(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const value = payload as { token?: unknown; access_token?: unknown; data?: { token?: unknown; access_token?: unknown } };
  return [value.data?.token, value.data?.access_token, value.token, value.access_token]
    .find((item): item is string => typeof item === "string" && item.trim().length > 0)?.trim() || "";
}

function getGameUrl(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const value = payload as { data?: { game_url?: unknown; url?: unknown }; raw?: { game_url?: unknown; url?: unknown } | string };
  const raw = value.raw;
  const candidates = [value.data?.game_url, value.data?.url, typeof raw === "string" ? raw : raw?.game_url, typeof raw === "string" ? undefined : raw?.url];
  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    try {
      const url = new URL(candidate.trim().replace(/\\\//g, "/"));
      if (url.protocol === "https:" && url.search) return url.href;
    } catch { /* Try the next official response field. */ }
  }
  return "";
}

async function getOfficialGameUrl(token: string, platform: Platform): Promise<string> {
  const response = await fetch(`${officialBase}/api/v2/game/${gameCodes[platform]}/login`, {
    method: "POST",
    mode: "cors",
    headers: { "Content-Type": "application/json", Accept: "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ game_return_url: `${officialBase}/`, game_kind: "", game_type: "", game_device: "Desktop" }),
  });
  const payload = await response.json().catch(() => null) as { code?: unknown } | null;
  if (response.status === 401 || response.status === 403 || [401, 403].includes(Number(payload?.code))) throw new Error("AUTH_EXPIRED");
  const url = getGameUrl(payload);
  if (!response.ok || (payload?.code != null && Number(payload.code) !== 200) || !url) throw new Error(`${platform} 遊戲網址取得失敗`);
  return url;
}

export function FloatingBrowser() {
  const [visible, setVisible] = useState(false);
  const [large, setLarge] = useState(false);
  const [platform, setPlatform] = useState<Platform>("MT");
  const [selectedTables, setSelectedTables] = useState<Record<Platform, string>>({ MT: "", DG: "", 歐博: "" });
  const [mtSelectionVersion, setMtSelectionVersion] = useState(0);
  const [dgSelectionVersion, setDgSelectionVersion] = useState(0);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [authenticated, setAuthenticated] = useState(false);
  const [urls, setUrls] = useState<Record<Platform, string>>(emptyUrls);
  const [errors, setErrors] = useState<Partial<Record<Platform, string>>>({});
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const token = useRef("");
  const deviceId = useRef("");
  const retrying = useRef<Partial<Record<Platform, boolean>>>({});

  useEffect(() => {
    try {
      setUsername(window.localStorage.getItem(lastUsernameKey) || "");
    } catch { /* Browser storage may be unavailable. */ }
    const handleOpen = (event: Event) => {
      const detail = (event as CustomEvent<{ platform?: Platform; tableId?: string }>).detail;
      if (detail?.platform && platforms.includes(detail.platform)) {
        setPlatform(detail.platform);
        if (detail.tableId) {
          setSelectedTables((current) => ({ ...current, [detail.platform!]: detail.tableId! }));
          if (detail.platform === "MT") setMtSelectionVersion((current) => current + 1);
          if (detail.platform === "DG") setDgSelectionVersion((current) => current + 1);
        }
      }
      setVisible(true);
    };
    window.addEventListener(openEvent, handleOpen);
    return () => window.removeEventListener(openEvent, handleOpen);
  }, []);

  const refresh = async (selected: Platform[] = platforms, activeToken = token.current) => {
    if (!activeToken) { setAuthenticated(false); setError("請輸入 TZ 帳號密碼"); return; }
    setBusy(true);
    const result = await Promise.allSettled(selected.map((item) => getOfficialGameUrl(activeToken, item)));
    if (token.current !== activeToken) return;
    if (result.some((item) => item.status === "rejected" && item.reason instanceof Error && item.reason.message === "AUTH_EXPIRED")) {
      token.current = "";
      setAuthenticated(false);
      setUrls(emptyUrls);
      setError("TZ 登入已失效，請重新輸入帳號密碼");
      setBusy(false);
      return;
    }
    const nextUrls: Partial<Record<Platform, string>> = {};
    const nextErrors: Partial<Record<Platform, string>> = {};
    result.forEach((item, index) => {
      const name = selected[index];
      if (item.status === "fulfilled") nextUrls[name] = item.value;
      else nextErrors[name] = `${name} 遊戲網址取得失敗`;
    });
    setUrls((current) => ({ ...current, ...Object.fromEntries(selected.map((name) => [name, nextUrls[name] || ""])) }));
    setErrors((current) => ({ ...current, ...Object.fromEntries(selected.map((name) => [name, nextErrors[name] || ""])) }));
    setBusy(false);
  };

  const login = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!username.trim() || !password) { setError("請輸入 TZ 帳號密碼"); return; }
    setBusy(true);
    setError("");
    try {
      if (!deviceId.current) {
        const bytes = new Uint8Array(16);
        crypto.getRandomValues(bytes);
        deviceId.current = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
      }
      const response = await fetch(`${officialBase}/api/v1/login`, {
        method: "POST",
        mode: "cors",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ username: username.trim(), password, device_id: deviceId.current }),
      });
      const payload = await response.json().catch(() => null);
      const memberToken = getToken(payload);
      if (!response.ok || !memberToken) throw new Error("TZ 登入失敗，請確認帳號密碼");
      token.current = memberToken;
      try {
        window.localStorage.setItem(lastUsernameKey, username.trim());
      } catch { /* Login still works without browser storage. */ }
      setAuthenticated(true);
      setPassword("");
      await refresh(platforms, memberToken);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "TZ 登入失敗");
    } finally {
      setBusy(false);
    }
  };

  const expand = () => {
    setVisible(true);
  };

  const logout = () => {
    token.current = "";
    setAuthenticated(false);
    setUrls(emptyUrls);
    setErrors({});
    setError("");
    setPassword("");
    setBusy(false);
  };

  return (
    <>
      {!visible && (
        <button type="button" onClick={expand} className="fixed bottom-24 right-5 z-50 flex items-center gap-2 rounded-full border border-cyan-400/60 bg-[#101a2b] px-4 py-3 text-sm font-medium text-cyan-100 shadow-xl hover:bg-[#193047] lg:bottom-5" aria-label="展開浮動視窗">
          <PanelTopOpen className="h-4 w-4" />浮動視窗
        </button>
      )}
      <section aria-label="浮動視窗" className={`fixed inset-0 z-50 flex h-dvh w-screen flex-col overflow-hidden bg-[#0e1727] text-white shadow-2xl lg:rounded-xl lg:border lg:border-cyan-400/60 ${visible ? "" : "hidden"} ${large ? "lg:inset-4 lg:h-auto lg:w-auto" : "lg:bottom-5 lg:left-auto lg:right-5 lg:top-auto lg:h-[min(72vh,650px)] lg:w-[min(92vw,760px)]"}`}>
        <div className="flex items-center justify-between border-b border-slate-600 px-3 py-2">
          <span className="text-sm font-semibold">TZ官網</span>
          <div className="flex items-center gap-1">
            {authenticated && <button type="button" onClick={logout} className="flex items-center gap-1 rounded p-2 text-sm hover:bg-white/10" aria-label="登出 TZ 官網"><LogOut className="h-4 w-4" />登出</button>}
            <button type="button" onClick={() => setVisible(false)} className="rounded p-2 hover:bg-white/10" aria-label="縮小浮動視窗"><Minimize2 className="h-4 w-4" /></button>
            <button type="button" onClick={() => setLarge((current) => !current)} className="hidden rounded p-2 hover:bg-white/10 lg:block" aria-label={large ? "還原浮動視窗" : "放大浮動視窗"}><Maximize2 className="h-4 w-4" /></button>
          </div>
        </div>
        {!authenticated ? (
          <form onSubmit={login} name="tz-login" className="flex flex-1 flex-col justify-center gap-3 p-5">
            <h2 className="text-base font-semibold">請輸入 TZ 帳號密碼</h2>
            <input id="tz-username" name="tz-username" value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="section-tz username" placeholder="TZ 帳號" aria-label="TZ 帳號" className="rounded border border-slate-600 bg-[#18243a] px-3 py-2 text-sm" />
            <input id="tz-password" name="tz-password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="section-tz current-password" placeholder="TZ 密碼" aria-label="TZ 密碼" className="rounded border border-slate-600 bg-[#18243a] px-3 py-2 text-sm" />
            <button type="submit" disabled={busy} className="rounded bg-cyan-700 px-3 py-2 text-sm hover:bg-cyan-600 disabled:opacity-50">{busy ? "登入中…" : "登入"}</button>
            {error && <p role="alert" className="text-xs text-rose-300">{error}</p>}
          </form>
        ) : (
          <>
            <div role="tablist" aria-label="遊戲平台" className="flex gap-1 border-b border-slate-700 p-2">
              {platforms.map((item) => (
                <button key={item} type="button" role="tab" aria-selected={platform === item} onClick={() => { setPlatform(item); setError(""); }} className={`rounded px-4 py-1.5 text-sm ${platform === item ? "bg-cyan-700 text-white" : "text-slate-300 hover:bg-white/10"}`}>{item}</button>
              ))}
            </div>
            <div className="flex items-center justify-between border-b border-slate-700 px-3 py-2 text-xs text-slate-300">
              <span>{busy ? "取得遊戲網址中…" : errors[platform] || (urls[platform] ? `${platform} 已連線` : `${platform} 等待連線`)}</span>
              <button type="button" disabled={busy} onClick={() => void refresh([platform])} className="rounded border border-slate-600 px-2 py-1 hover:bg-white/10 disabled:opacity-50">更新連結</button>
            </div>
            {error && <p role="alert" className="px-3 py-1 text-xs text-rose-300">{error}</p>}
            {platforms.map((item) => urls[item] ? (
              <iframe key={item === "MT" ? `MT-${mtSelectionVersion}` : item === "DG" ? `DG-${dgSelectionVersion}` : item} title={`${item} 遊戲內容`} src={item === "MT" ? mtGameUrlForTable(urls[item], selectedTables[item]) : item === "DG" ? dgGameUrlForTable(urls[item], selectedTables[item]) : urls[item]} allow="autoplay; fullscreen" allowFullScreen onError={() => {
                if (retrying.current[item]) return;
                retrying.current[item] = true;
                void refresh([item]).finally(() => { retrying.current[item] = false; });
              }} className={`min-h-0 flex-1 bg-white ${platform === item ? "" : "hidden"}`} />
            ) : platform === item ? (
              <div key={item} className="grid flex-1 place-items-center text-sm text-slate-400">{errors[item] || "取得遊戲網址中…"}</div>
            ) : null)}
          </>
        )}
      </section>
    </>
  );
}
