import { accountAdminBaseUrl } from '@/lib/account-admin-url';
import { runtimeEnv } from '@/lib/runtime-env';

export type SharedPlatform = 'MT' | 'DG' | 'AB';

const internalHeaders = () => {
  const key = runtimeEnv('ACCOUNT_ADMIN_INTERNAL_KEY') || runtimeEnv('ADMIN_INTERNAL_KEY');
  if (!key) throw new Error('共享桌況儲存服務尚未設定。');
  return { 'Content-Type': 'application/json', 'X-Internal-Key': key };
};

const internalUrl = (path: string) => new URL(path, accountAdminBaseUrl());

async function request(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  for (const [name, value] of Object.entries(internalHeaders())) headers.set(name, value);
  return fetch(internalUrl(path), {
    ...init,
    headers,
    cache: 'no-store',
    signal: AbortSignal.timeout(4_000),
  });
}

export async function writeSharedFeed(platform: SharedPlatform, payload: unknown) {
  const response = await request(`/internal/feeds/${platform}`, {
    method: 'POST', body: JSON.stringify(payload),
  });
  if (!response.ok) throw new Error(`shared feed write ${response.status}`);
  return response.json() as Promise<{ ok?: boolean; accepted?: boolean }>;
}

export async function readSharedFeed(platform: SharedPlatform) {
  const response = await request(`/internal/feeds/${platform}`);
  if (!response.ok) throw new Error(`shared feed read ${response.status}`);
  return response.json() as Promise<unknown>;
}

export async function readRoadHistory(platform: SharedPlatform, tableId: string) {
  const response = await request(`/internal/feeds/${platform}/history?tableId=${encodeURIComponent(tableId)}&limit=300`);
  if (!response.ok) throw new Error(`road history read ${response.status}`);
  return response.json() as Promise<{ segment: number; shoe: string; outcomes: { position: number; winner: '1' | '2' | '3'; observedAt: number }[] }>;
}

export async function touchSharedMtViewer(viewerId: string, online: boolean) {
  const response = await request('/internal/feeds/MT/presence', {
    method: 'POST', body: JSON.stringify({ viewerId, online }),
  });
  if (!response.ok) throw new Error(`shared feed presence ${response.status}`);
  return response.json() as Promise<{ viewerCount?: number; lastViewerAt?: number; idleForMs?: number; shouldCollect?: boolean }>;
}

export async function sharedMtDemand() {
  const response = await request('/internal/feeds/MT/demand');
  if (!response.ok) throw new Error(`shared feed demand ${response.status}`);
  return response.json() as Promise<{ viewerCount?: number; lastViewerAt?: number; idleForMs?: number; shouldCollect?: boolean }>;
}
