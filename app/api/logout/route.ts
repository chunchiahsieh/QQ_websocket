import { isSameRequestOrigin } from '@/lib/request-origin';

export async function POST(request: Request) {
  if (!isSameRequestOrigin(request)) {
    return Response.json({ message: '來源不符。' }, { status: 403 });
  }
  const collector = new URL(request.url).searchParams.get('collector') === '1';
  const cookieName = collector ? 'monitor_collector_session' : 'monitor_session';
  return Response.json({ ok: true }, { headers: {
    'Cache-Control': 'no-store',
    'Set-Cookie': `${cookieName}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT${new URL(request.url).protocol === 'https:' ? '; Secure' : ''}`,
  } });
}
