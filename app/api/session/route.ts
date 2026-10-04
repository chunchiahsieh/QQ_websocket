import { readSession } from '@/lib/monitor-session';

export async function GET(request: Request) {
  const session = await readSession(request);
  if (!session?.accountId || !session.accountUsername || session.accountStamp === 'collector') {
    return Response.json({ message: '尚未登入。' }, { status: 401, headers: { 'Cache-Control': 'no-store' } });
  }
  return Response.json(
    { username: session.accountUsername },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
