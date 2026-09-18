import { test } from 'node:test';
import assert from 'node:assert/strict';
import { authorizePlatform, authorizeDgBackend, extractLaunchToken } from '../lib/platform-authorization.ts';
import { sessionCookie, readSession } from '../lib/monitor-session.ts';
test('dedicated DG credentials never reuse front-end member token', async () => {
  const calls = [];
  const result = await authorizeDgBackend('https://example.com', 'frontend-token', { username: 'backend-test', password: 'test-password', deviceId: 'device' }, async (url, options) => {
    calls.push(url);
    if (url.endsWith('/api/v1/login')) return Response.json({ data: { token: 'backend-member' } });
    assert.equal(options.headers.Authorization, 'Bearer backend-member');
    return Response.json({ code: 200, data: { url: 'https://example.com/?token=dg-only' } });
  });
  assert.equal(result.token, 'dg-only'); assert.equal(calls.length, 2);
});
test('dedicated DG login failure never falls back to front-end account', async () => {
  let calls = 0;
  const result = await authorizeDgBackend('https://example.com', 'frontend-token', { username: 'backend-test', password: 'test-password', deviceId: 'device' }, async () => { calls++; return Response.json({}, {status:422}); });
  assert.equal(result.token, ''); assert.equal(calls, 1);
});

test('separate MT and DG endpoints return separate credentials', async () => {
  const calls = [];
  const fetcher = async (url, options) => {
    calls.push(url);
    assert.equal(options.headers.Authorization, 'Bearer member');
    return Response.json({ code: 200, data: { game_url: `https://example.com/?token=${url.includes('DGLI') ? 'dg-only' : 'mt-only'}` } });
  };
  const [mt, dg] = await Promise.all(['MTLI', 'DGLI'].map(platform => authorizePlatform('https://example.com', 'member', platform, fetcher)));
  assert.equal(mt.token, 'mt-only'); assert.equal(dg.token, 'dg-only'); assert.equal(calls.length, 2);
});
test('DG failure does not invalidate MT authorization', async () => {
  const fetcher = async url => url.includes('DGLI') ? Response.json({}, { status: 403 }) : Response.json({ data: { url: 'https://example.com/?token=mt' } });
  const [mt, dg] = await Promise.all(['MTLI', 'DGLI'].map(platform => authorizePlatform('https://example.com', 'member', platform, fetcher)));
  assert.equal(mt.token, 'mt'); assert.equal(dg.token, ''); assert.match(dg.error, /403/);
});
test('launch URL parsing rejects non-HTTPS and handles alternate candidates', () => {
  assert.equal(extractLaunchToken({ data: { url: 'http://example.com/?token=bad' } }), '');
  assert.equal(extractLaunchToken({ data: { game_url: 'https://example.com', url: '/game?token=dg' } }), 'dg');
});
test('direct DG permission is authenticated without carrying platform credentials', async () => {
  const cookie = await sessionCookie(new Request('https://localhost'), { dgDirectLogin: true });
  const session = await readSession(new Request('https://localhost', { headers: { cookie: cookie.split(';')[0] } }));
  assert.equal(session.dgDirectLogin, true);
  assert.equal(session.dgToken, undefined);
  assert.equal(session.dgGameUrl, undefined);
  assert.equal(await readSession(new Request('https://localhost')), null);
});

test('DG credentials are encrypted and session tampering is rejected', async () => {
  const cookie = await sessionCookie(new Request('https://localhost'), { dgToken: 'private-dg-token' });
  assert.ok(!cookie.includes('private-dg-token')); assert.match(cookie, /HttpOnly/); assert.match(cookie, /Secure/);
  const pair = cookie.split(';')[0];
  const req = value => new Request('https://localhost', { headers: { cookie: value } });
  assert.equal((await readSession(req(pair))).dgToken, 'private-dg-token');
  const tampered = pair.slice(0,-1) + (pair.endsWith('0') ? '1' : '0');
  assert.equal(await readSession(req(tampered)), null);
});
