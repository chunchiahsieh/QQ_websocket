import { isSameRequestOrigin } from '@/lib/request-origin';

/**
 * MT no longer launches a server-side browser. The frontend accepts the
 * short-lived launch URL and opens the official WebSocket in the user's
 * browser, so this endpoint remains only as a clear response for old clients.
 */
export async function POST(request: Request) {
  if (!isSameRequestOrigin(request)) return Response.json({ message: '來源不符。' }, { status: 403 });
  return Response.json({
    message: 'MT 已改由前端 WebSocket 連線，請在即時桌況貼上登入後的新授權網址。',
    mode: 'frontend-websocket',
  }, { status: 410, headers: { 'Cache-Control': 'no-store' } });
}
