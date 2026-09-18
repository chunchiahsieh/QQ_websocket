import { readSession } from '@/lib/monitor-session';
import { browserRelayUrl } from '@/lib/relay-url';
import { runtimeEnv } from '@/lib/runtime-env';
import { isSameRequestOrigin } from '@/lib/request-origin';
import { readJsonResponse } from '@/lib/safe-response-json';

const RELAY_START_TIMEOUT_MS = 45000;

export async function POST(request: Request) {
  if (!isSameRequestOrigin(request)) return Response.json({ message: '來源不符。' }, { status: 403 });
  const session = await readSession(request);
  if (!session?.dgDirectLogin) return Response.json({ message: '請重新登入，以啟用 MT後台連線。' }, { status: 401 });
  const relayUrl = runtimeEnv('DG_RELAY_URL');
  const relayKey = runtimeEnv('DG_RELAY_API_KEY');
  const publicRelayUrl = runtimeEnv('DG_RELAY_PUBLIC_URL');
  if (!relayUrl || !relayKey)
    return Response.json({ message: 'MT服務尚未設定。' }, { status: 503 });
  try {
    const response = await fetch(new URL('/api/mt/start', relayUrl), {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Relay-Key': relayKey },
      body: JSON.stringify({ directLogin: true }), signal: AbortSignal.any([request.signal, AbortSignal.timeout(RELAY_START_TIMEOUT_MS)]),
    });
    const result = await readJsonResponse<{ ticket?: string; message?: string }>(response);
    if (!response.ok) {
      const upstreamJson = response.headers.get('content-type')?.toLowerCase().includes('json');
      const message = upstreamJson
        ? result.message || '無法建立 MT工作階段。'
        : 'MT Relay 正在啟動或暫時無法回應，請稍候再試。';
      return Response.json({ message }, { status: response.status });
    }
    // Prefer an explicitly configured public relay URL (for a reverse proxy or
    // a separate host). Otherwise derive the relay host from the URL the user
    // used to open the frontend, so LAN DHCP changes do not require edits.
    return Response.json({ ticket: result.ticket, wsUrl: browserRelayUrl(request, publicRelayUrl, '/ws/mt') }, { headers: { 'Cache-Control': 'no-store' } });
  } catch { return Response.json({ message: '無法連接 MT 服務，請確認已啟動。' }, { status: 502 }); }
}
