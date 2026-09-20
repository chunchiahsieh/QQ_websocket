import { readCollectorSession, readSession } from '@/lib/monitor-session';
import { currentDgFeedMessage, dgRoomForSession, publishDgFeed, type SharedDgMessage } from '@/lib/dg-shared-feed';
import { runtimeEnv } from '@/lib/runtime-env';

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object';

export async function POST(request: Request) {
  const body = await request.json().catch(() => null) as unknown;
  if (!isRecord(body) || (body.type !== 'snapshot' && body.type !== 'status')) {
    return Response.json({ message: 'DG 共享桌況資料格式不正確。' }, { status: 400 });
  }
  // DG snapshots may only be supplied by collector A. Viewer browsers are
  // deliberately read-only, otherwise each viewer would restart the relay.
  if (body.collector !== true) return Response.json({ message: '僅採集端可寫入 DG 共享資料。' }, { status: 403 });
  const session = await readCollectorSession(request);
  if (!session) return Response.json({ message: '採集端尚未登入。' }, { status: 401 });
  const room = dgRoomForSession(session, runtimeEnv('DG_SHARED_FEED_ROOM'));
  const receivedAt = typeof body.receivedAt === 'number' && Number.isFinite(body.receivedAt) ? body.receivedAt : Date.now();
  const sequence = typeof body.sequence === 'number' && Number.isSafeInteger(body.sequence) && body.sequence >= 0 ? body.sequence : undefined;
  const collectorId = typeof body.collectorId === 'string' && body.collectorId.length > 0 && body.collectorId.length <= 120 ? body.collectorId : undefined;
  if (body.type === 'snapshot') {
    if (!Array.isArray(body.tables) || body.tables.length > 300 || JSON.stringify(body.tables).length > 1_500_000) {
      return Response.json({ message: 'DG 共享桌況快照格式不正確。' }, { status: 400 });
    }
    const accepted = publishDgFeed(room, { type: 'snapshot', tables: body.tables as SharedDgMessage['tables'], receivedAt, collectorId, sequence });
    return Response.json({ ok: true, accepted }, { headers: { 'Cache-Control': 'no-store' } });
  }
  const status = body.status === 'connected' || body.status === 'connecting' || body.status === 'offline' ? body.status : 'connecting';
  publishDgFeed(room, { type: 'status', status, message: typeof body.message === 'string' ? body.message.slice(0, 180) : undefined, receivedAt, collectorId, sequence });
  return Response.json({ ok: true }, { headers: { 'Cache-Control': 'no-store' } });
}

export async function GET(request: Request) {
  const session = await readSession(request);
  if (!session) return Response.json({ message: '請先登入系統。' }, { status: 401 });
  const room = dgRoomForSession(session, runtimeEnv('DG_SHARED_FEED_ROOM'));
  return Response.json(currentDgFeedMessage(room), { headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate', Connection: 'close' } });
}
