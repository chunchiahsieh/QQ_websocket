import { readCollectorSession, readSession } from '@/lib/monitor-session';
import { readSharedFeed, writeSharedFeed } from '@/lib/shared-feed-store';

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object';

export async function POST(request: Request) {
  const body = await request.json().catch(() => null) as unknown;
  if (!isRecord(body) || (body.type !== 'snapshot' && body.type !== 'status')) return Response.json({ message: 'DG 共享桌況資料格式不正確。' }, { status: 400 });
  if (body.collector !== true) return Response.json({ message: '僅採集端可寫入 DG 共享資料。' }, { status: 403 });
  if (!await readCollectorSession(request)) return Response.json({ message: '採集端尚未登入。' }, { status: 401 });
  if (body.type === 'snapshot' && (!Array.isArray(body.tables) || body.tables.length > 300 || JSON.stringify(body.tables).length > 1_500_000)) return Response.json({ message: 'DG 共享桌況快照格式不正確。' }, { status: 400 });
  try {
    return Response.json(await writeSharedFeed('DG', body), { headers: { 'Cache-Control': 'no-store' } });
  } catch {
    return Response.json({ message: '共享桌況儲存服務暫時無法使用。' }, { status: 503 });
  }
}

export async function GET(request: Request) {
  if (!await readSession(request)) return Response.json({ message: '請先登入系統。' }, { status: 401 });
  try {
    return Response.json(await readSharedFeed('DG'), { headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate', Connection: 'close' } });
  } catch {
    return Response.json({ message: '共享桌況儲存服務暫時無法使用。' }, { status: 503 });
  }
}
