import { readCollectorSession, readSession } from '@/lib/monitor-session';
import { sharedMtDemand, touchSharedMtViewer, writeSharedFeed, readSharedFeed } from '@/lib/shared-feed-store';

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object';

export async function POST(request: Request) {
  const body = await request.json().catch(() => null) as unknown;
  if (!isRecord(body) || (body.type !== 'snapshot' && body.type !== 'status' && body.type !== 'presence')) return Response.json({ message: '共享桌況資料格式不正確。' }, { status: 400 });
  const collector = body.collector === true;
  const session = await (collector ? readCollectorSession : readSession)(request);
  if (!session) return Response.json({ message: collector ? '採集端尚未登入。' : '請先登入系統。' }, { status: 401 });
  try {
    if (body.type === 'presence') {
      const viewerId = typeof body.viewerId === 'string' && body.viewerId.trim() ? body.viewerId.trim().slice(0, 120) : session.accountId || session.accountUsername || request.headers.get('x-viewer-id') || 'viewer';
      return Response.json(await touchSharedMtViewer(viewerId, body.online !== false), { headers: { 'Cache-Control': 'no-store' } });
    }
    if (!collector) return Response.json({ message: '僅採集端可寫入 MT 共享資料。' }, { status: 403 });
    if (body.type === 'snapshot' && (!Array.isArray(body.tables) || body.tables.length > 300 || JSON.stringify(body.tables).length > 1_500_000)) return Response.json({ message: '共享桌況快照格式不正確。' }, { status: 400 });
    return Response.json(await writeSharedFeed('MT', body), { headers: { 'Cache-Control': 'no-store' } });
  } catch {
    return Response.json({ message: '共享桌況儲存服務暫時無法使用。' }, { status: 503 });
  }
}

export async function GET(request: Request) {
  const searchParams = new URL(request.url).searchParams;
  const collector = searchParams.get('role') === 'collector';
  const session = await (collector ? readCollectorSession : readSession)(request);
  if (!session) return Response.json({ message: collector ? '採集端尚未登入。' : '請先登入系統。' }, { status: 401 });
  try {
    if (collector) return Response.json(await sharedMtDemand(), { headers: { 'Cache-Control': 'no-store' } });
    if (searchParams.get('poll') === '1') {
      const viewerId = searchParams.get('viewerId')?.trim().slice(0, 120) || session.accountId || session.accountUsername || request.headers.get('x-viewer-id') || 'viewer';
      await touchSharedMtViewer(viewerId, true);
    }
    return Response.json(await readSharedFeed('MT'), { headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate', Connection: 'close' } });
  } catch {
    return Response.json({ message: '共享桌況儲存服務暫時無法使用。' }, { status: 503 });
  }
}
