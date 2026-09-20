import { sessionCookie } from '@/lib/monitor-session';
import { runtimeEnv } from '@/lib/runtime-env';
import { accountAdminBaseUrl } from '@/lib/account-admin-url';
import { configuredCollectorCredentials, isConfiguredCollectorAccount } from '@/lib/collector-credentials';

type LoginBody = {
  username?: unknown;
  password?: unknown;
  deviceId?: unknown;
  collectorMode?: unknown;
};

type LocalAccount = { id?: string; username?: string; stamp?: string };

// Demo access is disabled unless an operator explicitly enables it. Production
// system users always come from AccountAdmin; they are never MT/DG accounts.
const loginDemoAccount = (username: string, password: string): LocalAccount | null => {
  if (runtimeEnv('ALLOW_DEMO_LOGIN') !== 'true') return null;
  const configuredUsername = runtimeEnv('DEMO_LOGIN_USERNAME')?.trim();
  const configuredPassword = runtimeEnv('DEMO_LOGIN_PASSWORD');
  const configuredMatch = Boolean(configuredUsername && configuredPassword)
    && username === configuredUsername
    && password === configuredPassword;
  if (!configuredMatch) return null;
  return { id: `demo-${configuredUsername}`, username: configuredUsername!, stamp: 'demo' };
};

const loginConfiguredCollectorAccount = (username: string, password: string, collectorMode: boolean): LocalAccount | null => {
  if (!collectorMode) return null;
  const configured = configuredCollectorCredentials();
  if (!configured || !isConfiguredCollectorAccount(username, password)) return null;
  return { id: `collector-${configured.username}`, username: configured.username, stamp: 'collector' };
};

const loginLocalAccount = async (username: string, password: string): Promise<LocalAccount | null> => {
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    // In the Render Worker these values are bindings, not process.env.
    // Using runtimeEnv keeps local Node and deployed Worker authentication on
    // the same path, instead of silently falling back to 127.0.0.1 in Render.
    const internalKey = runtimeEnv('ACCOUNT_ADMIN_INTERNAL_KEY') || runtimeEnv('ADMIN_INTERNAL_KEY');
    if (internalKey) headers['X-Internal-Key'] = internalKey;
    const response = await fetch(new URL('/internal/accounts/login', accountAdminBaseUrl()), {
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
        ...(collectorMode && localAccount.stamp === 'collector' ? { collectorCredentials: configuredCollectorCredentials() } : {}),
      }, { headers: {
          'Set-Cookie': await sessionCookie(request, {
            dgDirectLogin: dgReady || demoReady,
            accountId: localAccount.id,
            accountUsername: localAccount.username,
            accountStamp: localAccount.stamp,
          }, localAccount.stamp === 'collector' ? 30 * 24 * 60 * 60 : 3600),
        'Cache-Control': 'no-store',
      } });
    }

    // Do not fall back to MT/DG official authentication here. The account
    // management system is the sole authority for viewer access, while each
    // collector uses its own platform credentials and lifecycle.
    return Response.json({ message: '帳號或密碼不正確。' }, { status: 401 });
  } catch (error) {
    const message = error instanceof Error && error.name === 'TimeoutError'
      ? '登入驗證逾時，請稍後再試。'
      : '帳號或密碼不正確。';
    return Response.json({ message }, { status: 502 });
  }
}
