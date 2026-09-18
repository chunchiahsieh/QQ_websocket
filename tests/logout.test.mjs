import test from 'node:test';
import assert from 'node:assert/strict';
import { POST } from '../app/api/logout/route.ts';
test('logout expires the HttpOnly session and rejects foreign origins', async () => {
  const response=await POST(new Request('https://example.com/api/logout',{method:'POST',headers:{Origin:'https://example.com'}}));
  assert.equal(response.status,200);
  assert.match(response.headers.get('set-cookie'),/monitor_session=;/);
  assert.match(response.headers.get('set-cookie'),/Max-Age=0/);
  assert.match(response.headers.get('set-cookie'),/HttpOnly/);
  assert.match(response.headers.get('set-cookie'),/Secure/);
  assert.equal((await POST(new Request('https://example.com/api/logout',{method:'POST',headers:{Origin:'https://other.example'}}))).status,403);
});
