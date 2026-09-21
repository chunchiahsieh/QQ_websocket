import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

async function loadRoute(file, dependencies) {
  const source = await readFile(new URL(file, import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} };
  runInNewContext(compiled, {
    module, exports: module.exports, Response,
    require: name => {
      assert.ok(Object.hasOwn(dependencies, name), `Unexpected route dependency ${name}`);
      return dependencies[name];
    },
  });
  return module.exports;
}

let authenticated = false;
let readPlatform;
const viewer = await loadRoute('../app/api/ab/shared-feed/route.ts', {
  '@/lib/monitor-session': { readSession: async () => authenticated },
  '@/lib/shared-feed-store': { readSharedFeed: async platform => {
    readPlatform = platform;
    return { type: 'snapshot', tables: [{ id: 'AB:10' }] };
  } },
});
assert.equal((await viewer.GET(new Request('https://example.test/api/ab/shared-feed'))).status, 401, 'AB feed requires viewer login');
authenticated = true;
const current = await viewer.GET(new Request('https://example.test/api/ab/shared-feed'));
assert.equal(current.status, 200);
assert.equal(readPlatform, 'AB', 'AB viewer reads only the AB persisted feed');
assert.equal((await current.json()).tables[0].id, 'AB:10');
assert.match(current.headers.get('Cache-Control'), /no-store/, 'AB snapshots are never browser-cached');

let ingestAuthorized = false;
let written;
const ingest = await loadRoute('../app/api/collector/ingest/[platform]/route.ts', {
  '@/lib/collector-ingest': { isCollectorIngestAuthorized: () => ingestAuthorized },
  '@/lib/shared-feed-store': { writeSharedFeed: async (platform, body) => {
    written = { platform, body };
    return { ok: true, accepted: true };
  } },
});
const request = () => new Request('https://example.test/api/collector/ingest/AB', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ type: 'snapshot', collectorId: 'windows-test', sequence: 1, tables: [{ id: 'AB:10' }] }),
});
const context = { params: Promise.resolve({ platform: 'ab' }) };
assert.equal((await ingest.POST(request(), context)).status, 401, 'AB upload requires collector key');
ingestAuthorized = true;
const uploaded = await ingest.POST(request(), context);
assert.equal(uploaded.status, 200, 'AB HTTP fallback accepts a valid snapshot');
assert.equal((await uploaded.json()).accepted, true);
assert.equal(written.platform, 'AB');
assert.equal(written.body.tables[0].id, 'AB:10');
assert.equal(written.body.collectorId, 'windows-test');

console.log('PASS: AB authenticated public ingest and viewer read paths');
