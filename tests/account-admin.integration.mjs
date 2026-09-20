// Isolated MVC/JSON integration test: no platform accounts or production data.
import { spawn } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';
const directory = await mkdtemp(path.join(tmpdir(),'account-admin-test-'));
const password = randomBytes(24).toString('hex');
const apiKey = randomBytes(32).toString('hex');
const base='http://127.0.0.1:15092';
const child=spawn('dotnet',['backend/AccountAdmin/bin/Debug/net9.0/AccountAdmin.dll'],{
  env:{...process.env,ASPNETCORE_ENVIRONMENT:'Development',ADMIN_URLS:base,ADMIN_DATA_DIR:directory,
    ADMIN_BOOTSTRAP_USER:'admin',ADMIN_BOOTSTRAP_PASSWORD:password,ADMIN_INTERNAL_KEY:apiKey},stdio:'ignore'});
let cookies = new Map();
async function request(route, init={}) {
  const response=await fetch(base+route,{...init,redirect:'manual',headers:{Cookie:[...cookies].map(([k,v])=>`${k}=${v}`).join('; '),...init.headers}});
  for(const cookie of response.headers.getSetCookie()) { const pair=cookie.split(';')[0]; const at=pair.indexOf('='); cookies.set(pair.slice(0,at),pair.slice(at+1)); }
  return response;
}
async function page(route) {
  const response=await request(route); assert.equal(response.status,200);
  const html=await response.text(); const token=html.match(/name="__RequestVerificationToken"[^>]*value="([^"]+)"/)?.[1];
  return {html,token};
}
async function form(route,values,token) {
  return request(route,{method:'POST',body:new URLSearchParams({...values,...(token?{__RequestVerificationToken:token}:{})})});
}
async function api(route,body,key=apiKey) {
  return request('/internal/accounts/'+route,{method:'POST',headers:{'Content-Type':'application/json','X-Internal-Key':key},body:JSON.stringify(body)});
}
async function feed(route, init = {}) {
  return request('/internal/feeds/' + route, {
    ...init,
    headers: { 'Content-Type':'application/json', 'X-Internal-Key':apiKey, ...init.headers },
  });
}
try {
  for(let i=0;i<80;i++) {
    if(child.exitCode!==null) throw new Error('MVC exited during startup');
    try { if((await fetch(base+'/Admin/Login')).ok) break; } catch {}
    await new Promise(r=>setTimeout(r,100));
  }
  assert.equal((await request('/')).status,302,'Admin requires authentication');
  const login=await page('/Admin/Login'); assert.ok(login.token);
  assert.equal((await form('/Admin/Login',{username:'admin',password})).status,400,'CSRF required');
  assert.equal((await form('/Admin/Login',{username:'admin',password},login.token)).status,302);
  const dashboard=await page('/'); assert.match(dashboard.html,/使用者帳號管理/);
  await form('/Admin/Create',{username:'shorttest',password:'12345',expires:'2099-01-01T12:00'},dashboard.token);
  assert.ok((await page('/')).html.includes('role="alert"'),'Five-character password rejected');
  assert.equal((await form('/Admin/Create',{username:'member01',password,expires:'2099-01-01T12:00'},dashboard.token)).status,302);
  const duplicate=await form('/Admin/Create',{username:'MEMBER01',password,expires:'2099-01-01T12:00'},dashboard.token);
  assert.equal(duplicate.status,302); assert.ok((await page('/')).html.includes('role="alert"'),'Duplicate shows validation error');
  assert.equal((await api('login',{username:'member01',password},'bad')).status,401);
  const member=await (await api('login',{username:'member01',password})).json(); assert.ok(member.id); assert.ok(member.stamp);
  assert.equal(member.expiresAt,'2099-01-01T04:00:00+00:00','Taiwan time is stored in UTC');
  assert.equal((await (await api('validate',{id:member.id,stamp:member.stamp})).json()).valid,true);
  const firstSnapshot = { type:'snapshot', collector:true, collectorId:'test-collector', sequence:2, receivedAt:Date.now(), tables:[{id:'B01'}] };
  assert.equal((await feed('MT',{method:'POST',body:JSON.stringify(firstSnapshot)})).status,200);
  const shared = await (await feed('MT')).json();
  assert.equal(shared.type,'snapshot'); assert.equal(shared.tables[0].id,'B01');
  // A late packet from the same collector must not make a viewer go backward.
  const stale = { ...firstSnapshot, sequence:1, receivedAt:firstSnapshot.receivedAt + 1, tables:[{id:'OLD'}] };
  assert.equal((await (await feed('MT',{method:'POST',body:JSON.stringify(stale)})).json()).accepted,false);
  assert.equal((await (await feed('MT')).json()).tables[0].id,'B01');
  assert.equal((await feed('MT/presence',{method:'POST',body:JSON.stringify({viewerId:'viewer-a',online:true})})).status,200);
  assert.equal((await (await feed('MT/demand')).json()).shouldCollect,true);
  assert.equal((await feed('MT/presence',{method:'POST',body:JSON.stringify({viewerId:'viewer-a',online:false})})).status,200);
  await form('/Admin/Update',{id:member.id,expires:'2099-01-01T12:00'},dashboard.token);
  assert.equal((await api('login',{username:'member01',password})).status,401,'Disabled accounts cannot login');
  assert.equal((await (await api('validate',{id:member.id,stamp:member.stamp})).json()).valid,false,'Disable revokes stamp');
  await form('/Admin/Update',{id:member.id,enabled:'true',expires:'2000-01-01T12:00'},dashboard.token);
  assert.equal((await api('login',{username:'member01',password})).status,401,'Expired accounts cannot login');
  const newPassword='Ab1234'; // Six characters must now be accepted.
  await form('/Admin/Update',{id:member.id,enabled:'true',expires:'2099-01-01T12:00',password:newPassword},dashboard.token);
  assert.equal((await api('login',{username:'member01',password})).status,401,'Reset invalidates old password');
  assert.equal((await api('login',{username:'member01',password:newPassword})).status,200);
  const stored=await readFile(path.join(directory,'accounts.json'),'utf8');
  assert.ok(!stored.includes(password)&&!stored.includes(newPassword),'No plaintext passwords');
  assert.equal(JSON.parse(stored).Accounts.length,1);
  assert.ok((await readFile(path.join(directory,'accounts.json.bak'),'utf8')).length>0);
  for(const location of ['/accounts.json','/accounts.json.bak','/App_Data/accounts.json']) assert.equal((await request(location)).status,404);
  assert.equal((await form('/Admin/Logout',{},dashboard.token)).status,302);
  assert.equal((await request('/')).status,302);
  console.log('PASS: MVC login, CSRF, account CRUD, shared SQLite feed, demand heartbeat, duplicate detection, UTC expiry, disable/revoke, password reset, private JSON, atomic backup and logout');
} finally { child.kill(); }
