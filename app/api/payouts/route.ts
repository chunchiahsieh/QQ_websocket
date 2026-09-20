import { readSession } from '@/lib/monitor-session';
import { runtimeEnv } from '@/lib/runtime-env';
import { accountAdminBaseUrl } from '@/lib/account-admin-url';

const adminUrl = () => new URL('/internal/accounts/payouts', accountAdminBaseUrl());

export async function GET(request: Request) {
  const session = await readSession(request);
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    const internalKey = runtimeEnv('ACCOUNT_ADMIN_INTERNAL_KEY') || runtimeEnv('ADMIN_INTERNAL_KEY');
    if (internalKey) headers['X-Internal-Key'] = internalKey;
    const response = await fetch(adminUrl(), {
      method: 'POST', headers,
      body: JSON.stringify({ username: session?.accountUsername ?? null }),
      signal: AbortSignal.timeout(2500), cache: 'no-store',
    });
    if (!response.ok) return Response.json({ message: '派彩服務暫時無法取得資料。' }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
    const payload = await response.json() as { pools?: unknown; payouts?: unknown };
    return Response.json({ pools: payload.pools ?? [], payouts: session?.accountUsername ? (payload.payouts ?? []) : [], accountUsername: session?.accountUsername ?? null }, {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch {
    return Response.json({ message: '派彩服務暫時無法取得資料。' }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }
}
