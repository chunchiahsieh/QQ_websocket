import { readSession } from '@/lib/monitor-session';
import { runtimeEnv } from '@/lib/runtime-env';
import { accountAdminBaseUrl } from '@/lib/account-admin-url';

async function forward(request: Request, tables?: string[]) {
  const session = await readSession(request);
  if (!session?.accountId || !session.accountStamp || session.accountStamp === 'collector')
    return Response.json({ message: '請先登入。' }, { status: 401 });
  if (tables && (tables.length > 100 || tables.some(item => typeof item !== 'string' || item.length > 128)))
    return Response.json({ message: '關注牌桌資料格式不正確。' }, { status: 400 });
  try {
    const key = runtimeEnv('ACCOUNT_ADMIN_INTERNAL_KEY') || runtimeEnv('ADMIN_INTERNAL_KEY');
    const response = await fetch(new URL('/internal/accounts/focused-tables', accountAdminBaseUrl()), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(key ? { 'X-Internal-Key': key } : {}) },
      body: JSON.stringify({ id: session.accountId, stamp: session.accountStamp, ...(tables ? { tables } : {}) }),
      signal: AbortSignal.timeout(5000), cache: 'no-store',
    });
    if (!response.ok) return Response.json({ message: '關注牌桌儲存服務暫時無法使用。' }, { status: response.status === 400 ? 400 : 503 });
    const payload = await response.json() as { tables?: string[] };
    return Response.json({ tables: payload.tables ?? [] }, { headers: { 'Cache-Control': 'no-store' } });
  } catch {
    return Response.json({ message: '關注牌桌儲存服務暫時無法使用。' }, { status: 503 });
  }
}

export const GET = (request: Request) => forward(request);
export async function PUT(request: Request) {
  let body: { tables?: unknown };
  try { body = await request.json(); } catch { return Response.json({ message: '資料格式不正確。' }, { status: 400 }); }
  if (!Array.isArray(body?.tables)) return Response.json({ message: '資料格式不正確。' }, { status: 400 });
  return forward(request, body.tables);
}
