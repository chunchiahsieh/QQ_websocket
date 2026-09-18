export async function POST(request: Request) {
  const origin = request.headers.get('origin');
  if (origin && origin !== new URL(request.url).origin) {
    return Response.json({ message: '來源不符。' }, { status: 403 });
  }
  return Response.json({ ok: true }, { headers: {
    'Cache-Control': 'no-store',
    'Set-Cookie': `monitor_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT${new URL(request.url).protocol === 'https:' ? '; Secure' : ''}`,
  } });
}
