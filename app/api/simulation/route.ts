import { accountAdminBaseUrl } from '@/lib/account-admin-url';
import { readSession } from '@/lib/monitor-session';
import { runtimeEnv } from '@/lib/runtime-env';

export async function GET(request: Request) {
  const session = await readSession(request);
  if (!session?.accountId) return Response.json({ message: '尚未登入。' }, { status: 401 });
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const internalKey = runtimeEnv('ACCOUNT_ADMIN_INTERNAL_KEY') || runtimeEnv('ADMIN_INTERNAL_KEY');
  if (internalKey) headers['X-Internal-Key'] = internalKey;
  try {
    const response = await fetch(new URL('/internal/accounts/simulation', accountAdminBaseUrl()), {
      method: 'POST', headers, body: '{}', cache: 'no-store', signal: AbortSignal.timeout(2500),
    });
    if (!response.ok) throw new Error('unavailable');
    const result = await response.json() as { control: Record<string, unknown>; lines: unknown[]; status: Record<string, unknown> };
    return Response.json({ ...result.control, lines: result.lines, status: result.status }, { headers: { 'Cache-Control': 'no-store' } });
  } catch {
    return Response.json({ message: '模擬控制服務暫時無法取得資料。' }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }
}
