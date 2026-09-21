import { readSession } from '@/lib/monitor-session';
import { dgLoginPacket, dgSocketUrl } from '@/lib/dg-client';
import { decodeDgPublicBean, DgTableAccumulator } from '@/lib/dg-protobuf';
import { connectDgLines } from '@/lib/dg-connection';

export async function GET(request: Request) {
  const session = await readSession(request);
  if (!session) return Response.json({ message: '請重新登入系統以取得獨立 DG 授權。' }, { status: 401 });
  const token = session.dgToken;
  if (!token) return Response.json({ message: session.dgError || '此次登入未取得 DG 授權，請重新登入。' }, { status: 503 });
  if (process.env.DG_RELAY_URL) {
    if (!process.env.DG_RELAY_API_KEY) return Response.json({ message: 'DG 服務尚未設定內部驗證金鑰。' }, { status: 503 });
    try {
      const response = await fetch(new URL('/api/dg/stream', process.env.DG_RELAY_URL), {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Relay-Key': process.env.DG_RELAY_API_KEY },
        body: JSON.stringify({ token }), signal: request.signal,
      });
      return new Response(response.body, { status: response.status, headers: {
        'Content-Type': response.headers.get('Content-Type') || 'application/json', 'Cache-Control': 'no-store',
      } });
    } catch { return Response.json({ message: '無法連接 DG 服務，請確認已啟動。' }, { status: 502 }); }
  }
  let upstream: WebSocket & { accept(): void };
  try {
    upstream = await connectDgLines(base => dgSocketUrl(base, token), request.signal);
  } catch (error) {
    return Response.json({ message: request.signal.aborted ? 'DG 連線已取消。' : error instanceof Error ? error.message : 'DG 連線失敗。' }, { status: 502 });
  }
  let stop = () => {};
  const tableState = new DgTableAccumulator();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      let authenticated = false;
      const encoder = new TextEncoder();
      const send = (data: unknown) => { if (!closed) controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`)); };
      const heartbeat = setInterval(() => send({ type: 'heartbeat' }), 15000);
      const timeout = setTimeout(() => { send({ type: 'error', message: 'DG 未回傳可用桌況，授權或封包協定尚待驗證。' }); stop(); }, 20000);
      stop = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat); clearTimeout(timeout);
        request.signal.removeEventListener('abort', stop);
        upstream.close();
        controller.close();
      };
      upstream.addEventListener('message', event => {
        try {
          if (!(event.data instanceof ArrayBuffer)) return;
          const packet = decodeDgPublicBean(event.data);
          const tables = tableState.accept(packet);
          if (tables.length) {
            authenticated = true; clearTimeout(timeout);
            send({ type: 'tables', tables });
          }
        } catch { send({ type: 'error', message: 'DG 封包解析失敗，未將未確認資料填入路單。' }); stop(); }
      });
      upstream.addEventListener('close', () => { send({ type: 'error', message: authenticated ? 'DG 連線已中斷。' : 'DG 授權未完成，連線已關閉。' }); stop(); });
      upstream.addEventListener('error', () => { send({ type: 'error', message: 'DG 上游連線異常。' }); stop(); });
      request.signal.addEventListener('abort', stop, { once: true });
      if (request.signal.aborted) { stop(); return; }
      send({ type: 'status', message: 'DG 已建立通道，等待授權與桌況資料…' });
      upstream.send(dgLoginPacket(token));
    },
    cancel() { stop(); },
  });
  return new Response(body, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' } });
}
