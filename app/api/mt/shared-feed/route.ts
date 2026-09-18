import { readSession } from '@/lib/monitor-session';
import { addMtSubscriber, getMtFeed, mtFeedInfo, mtRoomForSession, publishMtFeed, touchMtViewer, type SharedMtMessage } from '@/lib/mt-shared-feed';

const encoder = new TextEncoder();
const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object';

const event = (message: SharedMtMessage) => encoder.encode(`data: ${JSON.stringify(message)}\n\n`);

export async function POST(request: Request) {
  const session = await readSession(request);
  if (!session) return Response.json({ message: '請先登入系統。' }, { status: 401 });
  const body = await request.json().catch(() => null) as unknown;
  if (!isRecord(body) || (body.type !== 'snapshot' && body.type !== 'status' && body.type !== 'presence')) {
    return Response.json({ message: '共享桌況資料格式不正確。' }, { status: 400 });
  }

  const room = mtRoomForSession(session);
  const viewerId = typeof body.viewerId === 'string' && body.viewerId.trim()
    ? body.viewerId.trim().slice(0, 120)
    : session.accountId || session.accountUsername || request.headers.get('x-viewer-id') || 'viewer';
  if (body.type === 'presence') {
    touchMtViewer(room, viewerId, body.online !== false);
    return Response.json({ ok: true, ...mtFeedInfo(room) }, { headers: { 'Cache-Control': 'no-store' } });
  }

  const receivedAt = typeof body.receivedAt === 'number' && Number.isFinite(body.receivedAt) ? body.receivedAt : Date.now();
  if (body.type === 'snapshot') {
    if (!Array.isArray(body.tables) || body.tables.length > 300) {
      return Response.json({ message: '共享桌況快照格式不正確。' }, { status: 400 });
    }
    const encoded = JSON.stringify(body.tables);
    if (encoded.length > 1_500_000) return Response.json({ message: '共享桌況快照過大。' }, { status: 413 });
    publishMtFeed(room, { type: 'snapshot', tables: body.tables as SharedMtMessage['tables'], receivedAt });
  } else {
    const status = body.status === 'connected' || body.status === 'connecting' || body.status === 'offline' ? body.status : 'connecting';
    publishMtFeed(room, { type: 'status', status, message: typeof body.message === 'string' ? body.message.slice(0, 180) : undefined, receivedAt });
  }
  return Response.json({ ok: true, ...mtFeedInfo(room) }, { headers: { 'Cache-Control': 'no-store' } });
}

export async function GET(request: Request) {
  const session = await readSession(request);
  if (!session) return Response.json({ message: '請先登入系統。' }, { status: 401 });
  const room = mtRoomForSession(session);
  const role = new URL(request.url).searchParams.get('role') || 'viewer';
  if (role === 'collector') {
    return Response.json(mtFeedInfo(room), { headers: { 'Cache-Control': 'no-store' } });
  }
  const requestedViewerId = new URL(request.url).searchParams.get('viewerId');
  const viewerId = requestedViewerId?.trim().slice(0, 120) || session.accountId || session.accountUsername || request.headers.get('x-viewer-id') || 'viewer';
  let stop = () => {};
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const send = (message: SharedMtMessage) => { if (!closed) controller.enqueue(event(message)); };
      const heartbeat = setInterval(() => {
        if (!closed) controller.enqueue(encoder.encode(`: heartbeat ${Date.now()}\n\n`));
      }, 15000);
      const subscriber = { send, close: () => stop() };
      const remove = addMtSubscriber(room, subscriber, viewerId);
      const feed = getMtFeed(room);
      if (!feed.latest) send({ type: 'status', status: 'connecting', message: '等待 MT 即時資料…', receivedAt: Date.now() });
      stop = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        remove();
        request.signal.removeEventListener('abort', stop);
        try { controller.close(); } catch { /* already closed */ }
      };
      request.signal.addEventListener('abort', stop, { once: true });
      if (request.signal.aborted) stop();
    },
    cancel() { stop(); },
  });
  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
