export type PlatformAuthorization = { token: string; gameUrl?: string; error?: string };

export async function authorizeDgBackend(base: string, frontendMemberToken: string,
  credentials: { username?: string; password?: string; deviceId: string }, fetcher: typeof fetch = fetch): Promise<PlatformAuthorization> {
  if (!credentials.username && !credentials.password) return authorizePlatform(base, frontendMemberToken, 'DGLI', fetcher);
  if (!credentials.username || !credentials.password) return { token: '', error: 'DG 後台帳密設定不完整。' };
  try {
    const response = await fetcher(`${base}/api/v1/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ username: credentials.username, password: credentials.password, device_id: credentials.deviceId }),
      signal: AbortSignal.timeout(15000),
    });
    const data = await response.json().catch(() => null) as { token?: unknown; access_token?: unknown; data?: { token?: unknown; access_token?: unknown } } | null;
    const token = [data?.data?.token, data?.token, data?.data?.access_token, data?.access_token]
      .find((value): value is string => typeof value === 'string' && !!value.trim());
    if (!response.ok || !token) return { token: '', error: `DG 後台帳號登入失敗（HTTP ${response.status}）。未改用前台帳號。` };
    return authorizePlatform(base, token, 'DGLI', fetcher);
  } catch { return { token: '', error: 'DG 後台登入服務逾時或無法連線。' }; }
}

export function extractLaunchUrl(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return '';
  const data = payload as Record<string, any>;
  const candidates = [data.data?.game_url, data.data?.url, data.raw?.game_url, data.raw?.url, typeof data.raw === 'string' ? data.raw : '']
    .filter((v): v is string => typeof v === 'string').map(v => v.trim().replace(/\\\//g, '/').replace(/^['"]|['"]$/g, ''));
  for (const value of candidates) {
    try { const url = new URL(value); if (url.protocol === 'https:' && url.searchParams.get('token')) return url.toString(); } catch {}
  }
  const base = candidates.find(v => { try { return new URL(v).protocol === 'https:'; } catch { return false; } });
  const relative = candidates.find(v => /^[/?]/.test(v) && /[?&]token=/.test(v));
  if (base && relative) {
    try { const url = new URL(relative, new URL(base).origin); if (url.protocol === 'https:' && url.searchParams.get('token')) return url.toString(); } catch {}
  }
  return '';
}
export function extractLaunchToken(payload: unknown): string {
  const url = extractLaunchUrl(payload);
  return url ? new URL(url).searchParams.get('token')?.trim() || '' : '';
}

export async function authorizePlatform(base: string, memberToken: string, platform: 'MTLI' | 'DGLI', fetcher: typeof fetch = fetch): Promise<PlatformAuthorization> {
  const label = platform === 'MTLI' ? 'MT' : 'DG';
  try {
    const response = await fetcher(`${base}/api/v2/game/${platform}/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${memberToken}` },
      body: JSON.stringify({ game_return_url: base, game_kind: '', game_type: '', game_device: 'Desktop' }),
      signal: AbortSignal.timeout(15000),
    });
    const payload = await response.json().catch(() => null) as { code?: unknown } | null;
    const token = extractLaunchToken(payload);
    if (!response.ok || (payload?.code != null && Number(payload.code) !== 200) || !token)
      return { token: '', error: `${label} 授權未取得（HTTP ${response.status}），請重新登入或確認平台帳號權限。` };
    return { token, gameUrl: extractLaunchUrl(payload) };
  } catch { return { token: '', error: `${label} 授權服務逾時或無法連線，請重新登入。` }; }
}
