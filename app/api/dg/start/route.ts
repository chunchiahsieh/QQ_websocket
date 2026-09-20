import { readCollectorSession, readSession } from '@/lib/monitor-session';
import { browserRelayUrl } from '@/lib/relay-url';
import { isSameRequestOrigin } from '@/lib/request-origin';
import { readJsonResponse } from '@/lib/safe-response-json';

const RELAY_START_TIMEOUT_MS = 45000;

export async function POST(request: Request) {
  if (!isSameRequestOrigin(request)) return Response.json({ message: '來源不符。' }, { status: 403 });
  if (!process.env.DG_RELAY_URL || !process.env.DG_RELAY_API_KEY)
    return Response.json({ message: 'DG 瀏覽器服務尚未設定。' }, { status: 503 });
  try {
    const input = await request.json().catch(() => ({})) as { gameUrl?: unknown; collector?: unknown };
    const collector = input.collector === true;
    const session = await (collector ? readCollectorSession : readSession)(request);
    if (!session?.dgDirectLogin) return Response.json({ message: collector ? '採集端尚未登入，以啟用 DG 連線。' : '請重新登入，以啟用 DG 後台連線。' }, { status: 401 });
    const gameUrl = typeof input.gameUrl === 'string' ? input.gameUrl.trim() : '';
    if (gameUrl.length > 4096) return Response.json({ message: 'DG 遊戲授權網址過長。' }, { status: 400 });
    const response = await fetch(new URL('/api/dg/start', process.env.DG_RELAY_URL), {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Relay-Key': process.env.DG_RELAY_API_KEY },
      body: JSON.stringify({ directLogin: true, gameUrl: gameUrl || undefined, collector }), signal: AbortSignal.any([request.signal, AbortSignal.timeout(RELAY_START_TIMEOUT_MS)]),
    });
    const result = await readJsonResponse<{ ticket?: string; message?: string }>(response);
    if (!response.ok) {
      const upstreamJson = response.headers.get('content-type')?.toLowerCase().includes('json');
      const message = upstreamJson
        ? result.message || '無法建立 DG 瀏覽器工作階段。'
        : 'DG Relay 正在啟動或暫時無法回應，請稍候再試。';
      return Response.json({ message }, { status: response.status });
    }
    return Response.json({ ticket: result.ticket, wsUrl: browserRelayUrl(request, process.env.DG_RELAY_PUBLIC_URL || process.env.DG_RELAY_URL, '/ws/dg') }, { headers: { 'Cache-Control': 'no-store' } });
  } catch { return Response.json({ message: '無法連接 DG 服務，請確認已啟動。' }, { status: 502 }); }
}
