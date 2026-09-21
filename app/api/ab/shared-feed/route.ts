import { readSession } from '@/lib/monitor-session';
import { readSharedFeed } from '@/lib/shared-feed-store';

// Viewers read only Render's persisted snapshot. The Windows collector is the
// sole AB producer and authenticates through /api/collector/ingest/AB (or WS).
export async function GET(request: Request) {
  if (!await readSession(request)) return Response.json({ message: '請先登入系統。' }, { status: 401 });
  try {
    return Response.json(await readSharedFeed('AB'), { headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate', Connection: 'close' } });
  } catch {
    return Response.json({ message: '共享桌況儲存服務暫時無法使用。' }, { status: 503 });
  }
}
