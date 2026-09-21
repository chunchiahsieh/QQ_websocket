import { isCollectorIngestAuthorized } from '@/lib/collector-ingest';
import { sharedMtDemand } from '@/lib/shared-feed-store';

export async function GET(request: Request) {
  if (!isCollectorIngestAuthorized(request)) return Response.json({ message: '採集端驗證失敗。' }, { status: 401 });
  try {
    return Response.json(await sharedMtDemand(), { headers: { 'Cache-Control': 'no-store' } });
  } catch {
    return Response.json({ message: '觀看需求服務暫時無法使用。' }, { status: 503 });
  }
}
