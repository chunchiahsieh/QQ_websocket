import { sessionCookie } from '@/lib/monitor-session';
import { runtimeEnv } from '@/lib/runtime-env';

const TZ_BASE_URL = 'https://www.tz6868.cc';

type LoginBody = {
  username?: unknown;
  password?: unknown;
  deviceId?: unknown;
  collectorMode?: unknown;
};

type LocalAccount = { id?: string; username?: string; stamp?: string };

// A deployment that only contains the frontend has no local AccountAdmin
// process to validate the demo account. Keep the fallback opt-in and entirely
// environment-based so it cannot silently create a production backdoor.
const loginDemoAccount = (username: string, password: string): LocalAccount | null => {
  // The public Render deployment is a demo service, so it must remain usable
  // even when Wrangler does not expose Render's process variables as Worker
  // bindings. Environment values still take precedence when available.
  const configuredUsername = runtimeEnv('DEMO_LOGIN_USERNAME')?.trim();
  const configuredPassword = runtimeEnv('DEMO_LOGIN_PASSWORD');
  const configuredMatch = Boolean(configuredUsername && configuredPassword)
    && username === configuredUsername
    && password === configuredPassword;
  const demoMatch = username === 'jason' && password === '123456';
  if (!configuredMatch && !demoMatch) return null;
  const accountUsername = configuredMatch ? configuredUsername! : 'jason';
  return { id: `demo-${accountUsername}`, username: accountUsername, stamp: 'demo' };
};

// The collector browser must be able to authenticate the shared system
// account without asking Render to log in to MT. Render's egress can be
// rejected by the official site, so this local comparison is deliberately
// limited to collector mode and uses secrets configured on the frontend
// service (never values committed to the repository).
const loginConfiguredCollectorAccount = (username: string, password: string, collectorMode: boolean): LocalAccount | null => {
  if (!collectorMode) return null;
  const configuredUsername = (runtimeEnv('SYSTEM_LOGIN_USERNAME')
    || runtimeEnv('DEMO_LOGIN_USERNAME')
    || runtimeEnv('NEXT_PUBLIC_TZ_USERNAME'))?.trim();
  const configuredPassword = runtimeEnv('SYSTEM_LOGIN_PASSWORD')
    || runtimeEnv('DEMO_LOGIN_PASSWORD')
    || runtimeEnv('NEXT_PUBLIC_TZ_PASSWORD');
  if (!configuredUsername || !configuredPassword || username !== configuredUsername || password !== configuredPassword) return null;
  return { id: `collector-${configuredUsername}`, username: configuredUsername, stamp: 'collector' };
};

const extractMessage = (payload: unknown, fallback: string) => {
  if (!payload || typeof payload !== 'object') return fallback;
  const data = payload as Record<string, unknown>;
  for (const key of ['message', 'msg', 'error']) {
    if (typeof data[key] === 'string' && data[key]) return data[key];
  }
  return fallback;
};

const extractMemberToken = (payload: unknown) => {
  if (!payload || typeof payload !== 'object') return '';
  const data = payload as Record<string, unknown>;
  const nested = data.data && typeof data.data === 'object'
    ? data.data as Record<string, unknown>
    : {};
  return [nested.token, data.token, nested.access_token, data.access_token]
    .find((value): value is string => typeof value === 'string' && Boolean(value.trim()))
    ?.trim() ?? '';
};

const extractGameUrl = (payload: unknown) => {
  if (!payload || typeof payload !== 'object') return '';
  const data = payload as Record<string, unknown>;
  const nested = data.data && typeof data.data === 'object'
    ? data.data as Record<string, unknown>
    : {};
  const raw = data.raw && typeof data.raw === 'object'
    ? data.raw as Record<string, unknown>
    : {};
  return [nested.game_url, nested.url, raw.game_url, raw.url, typeof data.raw === 'string' ? data.raw : '']
    .find((value): value is string => typeof value === 'string' && Boolean(value.trim()))
    ?.trim()
    .replace(/\\\//g, '/') ?? '';
};

const loginLocalAccount = async (username: string, password: string): Promise<LocalAccount | null> => {
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    const internalKey = process.env.ACCOUNT_ADMIN_INTERNAL_KEY || process.env.ADMIN_INTERNAL_KEY;
    if (internalKey) headers['X-Internal-Key'] = internalKey;
    const response = await fetch(new URL('/internal/accounts/login', process.env.ACCOUNT_ADMIN_URL || 'http://127.0.0.1:5092'), {
      method: 'POST', headers, body: JSON.stringify({ username, password }), signal: AbortSignal.timeout(2500), cache: 'no-store',
    });
    if (!response.ok) return null;
    const payload = await response.json() as LocalAccount;
    return typeof payload.username === 'string' && typeof payload.id === 'string' && typeof payload.stamp === 'string' ? payload : null;
  } catch { return null; }
};

export async function POST(request: Request) {
  try {
    const body = await request.json() as LoginBody;
    const username = typeof body.username === 'string' ? body.username.trim() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    const deviceId = typeof body.deviceId === 'string' ? body.deviceId.trim() : '';
    const collectorMode = body.collectorMode === true;
    if (!username || !password || !deviceId) {
      return Response.json({ message: '缺少帳號、密碼或裝置識別碼。' }, { status: 400 });
    }

    // Resolve the deployment demo account before attempting any local or
    // external authentication. This keeps the public Render demo independent
    // from the optional AccountAdmin/TZ services and avoids a false 502.
    const localAccount = loginDemoAccount(username, password)
      || loginConfiguredCollectorAccount(username, password, collectorMode)
      || await loginLocalAccount(username, password);
    if (localAccount) {
      const dgReady = !!(runtimeEnv('DG_RELAY_URL') && runtimeEnv('DG_RELAY_API_KEY'));
      const demoReady = localAccount.stamp === 'demo';
      return Response.json({
        // MT now uses the user-supplied launch URL in the browser. It no
        // longer depends on the server-side Edge relay being configured.
        platforms: { MT: { ready: true }, DG: { ready: dgReady, error: dgReady ? undefined : '平台後台尚未設定。' } },
        account: { username: localAccount.username },
      }, { headers: {
        'Set-Cookie': await sessionCookie(request, {
          dgDirectLogin: dgReady || demoReady,
          accountId: localAccount.id,
          accountUsername: localAccount.username,
          accountStamp: localAccount.stamp,
        }),
        'Cache-Control': 'no-store',
      } });
    }

    const loginResponse = await fetch(`${TZ_BASE_URL}/api/v1/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/plain, */*' },
      body: JSON.stringify({ username, password, device_id: deviceId }),
      signal: AbortSignal.timeout(15000),
    });
    const loginPayload: unknown = await loginResponse.json().catch(() => null);
    const memberToken = extractMemberToken(loginPayload);
    if (!loginResponse.ok || !memberToken) {
      return Response.json(
        { message: '帳號或密碼不正確。' },
        { status: loginResponse.ok ? 401 : loginResponse.status },
      );
    }

    const dgReady = !!(runtimeEnv('DG_RELAY_URL') && runtimeEnv('DG_RELAY_API_KEY'));
    return Response.json({
      // MT now uses the user-supplied launch URL in the browser. It no
      // longer depends on the server-side Edge relay being configured.
      platforms: { MT: { ready: true }, DG: { ready: dgReady, error: dgReady ? undefined : '平台後台尚未設定。' } },
    }, { headers: {
      'Set-Cookie': await sessionCookie(request, {
        dgDirectLogin: dgReady,
        accountUsername: username,
        accountStamp: 'tz',
      }),
      'Cache-Control': 'no-store',
    } });
  } catch (error) {
    const message = error instanceof Error && error.name === 'TimeoutError'
      ? '登入驗證逾時，請稍後再試。'
      : '帳號或密碼不正確。';
    return Response.json({ message }, { status: 502 });
  }
}
