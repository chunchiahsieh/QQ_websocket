import { isCollectorIngestAuthorized } from '@/lib/collector-ingest';
import { writeSharedFeed } from '@/lib/shared-feed-store';

const platforms = new Set(['MT', 'DG']);
const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object';

export async function POST(request: Request, context: { params: Promise<{ platform: string }> }) {
  if (!isCollectorIngestAuthorized(request)) return Response.json({ message: '採集端驗證失敗。' }, { status: 401 });
  const platform = (await context.params).platform.toUpperCase();
  if (!platforms.has(platform)) return Response.json({ message: '不支援的平台。' }, { status: 404 });
  const body = await request.json().catch(() => null) as unknown;
  if (!isRecord(body) || (body.type !== 'snapshot' && body.type !== 'status')) return Response.json({ message: '共享桌況資料格式不正確。' }, { status: 400 });
  if (body.type === 'snapshot' && (!Array.isArray(body.tables) || body.tables.length > 300 || JSON.stringify(body.tables).length > 1_500_000))
    return Response.json({ message: '共享桌況快照格式不正確。' }, { status: 400 });
  if (body.type === 'status' && !['connected', 'connecting', 'offline'].includes(String(body.status)))
    return Response.json({ message: '共享桌況狀態不正確。' }, { status: 400 });
  try {
    return Response.json(await writeSharedFeed(platform as 'MT' | 'DG', {
      ...body,
      collector: true,
      collectorId: typeof body.collectorId === 'string' && body.collectorId.trim() ? body.collectorId.trim().slice(0, 120) : 'desktop-collector',
      receivedAt: typeof body.receivedAt === 'number' && Number.isFinite(body.receivedAt) ? body.receivedAt : Date.now(),
    }), { headers: { 'Cache-Control': 'no-store' } });
  } catch {
    return Response.json({ message: '共享桌況儲存服務暫時無法使用。' }, { status: 503 });
  }
}
