import { accountAdminBaseUrl } from '@/lib/account-admin-url';

// Same-site MVC gateway. The C# service remains private on Render's private
// network in production and on loopback during local development.
async function proxy(request: Request) {
  const url = new URL(request.url);
  const suffix = url.pathname.replace(/^\/admin/i, '').replace(/\/$/, '');
  const action = suffix === '' ? 'Index' : suffix.slice(1);
  const allowed = request.method === 'POST' ? ['Login', 'Logout', 'Create', 'Update', 'Delete', 'SavePayout', 'Password'] : ['Index', 'Login', 'Error'];
  const canonical = allowed.find(value => value.toLowerCase() === action.toLowerCase());
  if (!canonical) return new Response('Not found', { status: 404 });
  if (request.method === 'POST' && request.headers.get('origin') !== url.origin)
    return new Response('來源不符', { status: 403 });
  const headers = new Headers();
  const cookies = request.headers.get('cookie')?.split(';').filter(pair => {
    const name = pair.trim().split('=')[0];
    return name === 'account_admin' || name.startsWith('.AspNetCore.Antiforgery.') || name === '.AspNetCore.Mvc.CookieTempDataProvider';
  }).join(';');
  if (cookies) headers.set('cookie', cookies);
  if (request.headers.has('content-type')) headers.set('content-type', request.headers.get('content-type')!);
  try {
    const body = request.method === 'POST' ? await request.text() : undefined;
    if (body && body.length > 16384) return new Response('Request too large', { status: 413 });
    const upstream = await fetch(new URL(`/Admin/${canonical}`, accountAdminBaseUrl()), {
      method: request.method, headers, body, redirect: 'manual', signal: AbortSignal.timeout(10000),
    });
    const output = new Headers({ 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY', 'X-Content-Type-Options': 'nosniff' });
    for (const name of ['content-type', 'content-security-policy']) {
      if (upstream.headers.has(name)) output.set(name, upstream.headers.get(name)!);
    }
    for (const cookie of upstream.headers.getSetCookie()) output.append('Set-Cookie', cookie);
    const location = upstream.headers.get('location');
    if (location) {
      const target = new URL(location, 'http://localhost');
      output.set('Location', target.pathname === '/' ? '/admin' : target.pathname.replace(/^\/Admin/i, '/admin'));
    }
    const html = (await upstream.text()).replaceAll('/Admin/', '/admin/');
    return new Response(html, { status: upstream.status, headers: output });
  } catch {
    return new Response('管理服務尚未啟動，請啟動 C# AccountAdmin 服務後重新整理。', {
      status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
    });
  }
}
export const GET = proxy;
export const POST = proxy;
