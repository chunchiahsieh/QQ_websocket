import { sessionCookie } from '@/lib/monitor-session';
import { runtimeEnv } from '@/lib/runtime-env';

const TZ_BASE_URL = 'https://www.tz6868.cc';

type LoginBody = {
  username?: unknown;
  password?: unknown;
  deviceId?: unknown;
};

type LocalAccount = { id?: string; username?: string; stamp?: string };

// A deployment that only contains the frontend has no local AccountAdmin
// process to validate the demo account. Keep the fallback opt-in and entirely
// environment-based so it cannot silently create a production backdoor.
const loginDemoAccount = (request: Request, username: string, password: string): LocalAccount | null => {
  let demoUsername = runtimeEnv('DEMO_LOGIN_USERNAME')?.trim();
  let demoPassword = runtimeEnv('DEMO_LOGIN_PASSWORD');
  // Render's Wrangler dev runtime can omit host environment bindings in an
  // isolated Worker. Keep the public demo usable only on its own Render host.
  if ((!demoUsername || !demoPassword) && new URL(request.url).hostname.endsWith('.onrender.com')) {
    demoUsername = 'jason';
    demoPassword = '123456';
  }
  if (!demoUsername || !demoPassword || username !== demoUsername || password !== demoPassword) return null;
  return { id: `demo-${demoUsername}`, username: demoUsername, stamp: 'demo' };
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
    if (!username || !password || !deviceId) {
      return Response.json({ message: '缺少帳號、密碼或裝置識別碼。' }, { status: 400 });
    }

    const localAccount = await loginLocalAccount(username, password) || loginDemoAccount(request, username, password);
    if (localAccount) {
      const dgReady = !!(process.env.DG_RELAY_URL && process.env.DG_RELAY_API_KEY);
      const demoReady = localAccount.stamp === 'demo';
      return Response.json({
        platforms: { MT: { ready: dgReady || demoReady }, DG: { ready: dgReady, error: dgReady ? undefined : '平台後台尚未設定。' } },
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

    const dgReady = !!(process.env.DG_RELAY_URL && process.env.DG_RELAY_API_KEY);
    return Response.json({
      platforms: { MT: { ready: dgReady }, DG: { ready: dgReady, error: dgReady ? undefined : '平台後台尚未設定。' } },
    }, { headers: {
      'Set-Cookie': await sessionCookie(request, { dgDirectLogin: dgReady }),
      'Cache-Control': 'no-store',
    } });
  } catch (error) {
    const message = error instanceof Error && error.name === 'TimeoutError'
      ? '登入驗證逾時，請稍後再試。'
      : '帳號或密碼不正確。';
    return Response.json({ message }, { status: 502 });
  }
}
