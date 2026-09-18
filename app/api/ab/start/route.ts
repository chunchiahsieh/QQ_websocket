import { readSession } from '@/lib/monitor-session';
import { browserRelayUrl } from '@/lib/relay-url';

export async function POST(request: Request) {
  const origin = request.headers.get('origin');
  if (origin && origin !== new URL(request.url).origin) return Response.json({ message: '來源不符。' }, { status: 403 });
  const session = await readSession(request);
  if (!session?.dgDirectLogin) return Response.json({ message: '請重新登入，以啟用 歐博後台連線。' }, { status: 401 });
  if (!process.env.DG_RELAY_URL || !process.env.DG_RELAY_API_KEY)
    return Response.json({ message: 'C# 歐博瀏覽器服務尚未設定。' }, { status: 503 });
  try {
    const response = await fetch(new URL('/api/ab/start', process.env.DG_RELAY_URL), {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Relay-Key': process.env.DG_RELAY_API_KEY },
      body: JSON.stringify({ directLogin: true }), signal: AbortSignal.any([request.signal, AbortSignal.timeout(10000)]),
    });
    const result = await response.json() as { ticket?: string; message?: string };
    if (!response.ok) return Response.json({ message: result.message || '無法建立 歐博瀏覽器工作階段。' }, { status: response.status });
    return Response.json({ ticket: result.ticket, wsUrl: browserRelayUrl(request, process.env.DG_RELAY_PUBLIC_URL || process.env.DG_RELAY_URL, '/ws/ab') }, { headers: { 'Cache-Control': 'no-store' } });
  } catch { return Response.json({ message: '無法連接 C# 歐博服務，請確認已啟動。' }, { status: 502 }); }
}
