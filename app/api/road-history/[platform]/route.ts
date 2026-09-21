import { readSession } from '@/lib/monitor-session';
import { readRoadHistory, type SharedPlatform } from '@/lib/shared-feed-store';

export async function GET(request: Request, context: { params: Promise<{ platform: string }> }) {
  if (!await readSession(request)) return Response.json({ message: '請先登入系統。' }, { status: 401 });
  const { platform } = await context.params;
  const tableId = new URL(request.url).searchParams.get('tableId')?.trim();
  if (!['MT', 'DG', 'AB'].includes(platform) || !tableId || tableId.length > 120) return Response.json({ message: '參數不正確。' }, { status: 400 });
  try {
    return Response.json(await readRoadHistory(platform as SharedPlatform, tableId), { headers: { 'Cache-Control': 'no-store' } });
  } catch {
    return Response.json({ message: '歷史資料暫時無法使用。' }, { status: 503 });
  }
}
