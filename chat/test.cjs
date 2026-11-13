'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, randomBytes, pbkdf2Sync, createHash } = require('node:crypto');
const path = require('node:path');
const { readFileSync } = require('node:fs');
const { unstable_dev } = require('wrangler');
const { Miniflare, convertV4MiniflareOptions } = require('miniflare');

// Run with node --test chat/test.cjs after npm ci --prefix chat.
// Each run starts a fresh local room with a temporary moderation key.
async function connect(url, token, station) {
  const socket = new WebSocket(url);
  const received = [];
  const waiting = new Map();
  socket.addEventListener('message', event => {
    const packet = JSON.parse(event.data);
    const resolve = waiting.get(packet.type);
    if (resolve) resolve(packet);
    else received.push(packet);
  });
  function next(type) {
    const index = received.findIndex(packet => packet.type === type);
    if (index >= 0) return Promise.resolve(received.splice(index, 1)[0]);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiting.delete(type);
        reject(new Error('Did not receive ' + type));
      }, 5000);
      waiting.set(type, packet => {
        clearTimeout(timer);
        waiting.delete(type);
        resolve(packet);
      });
    });
  }
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, {once:true});
    socket.addEventListener('error', reject, {once:true});
  });
  const send = packet => socket.send(JSON.stringify(packet));
  send({type:'join',token,station});
  return {socket, send, next, identity:await next('welcome')};
}

test('global room preserves identities, distributes messages, and applies moderation', {timeout:45000}, async t => {
  const key = randomUUID();
  const worker = await unstable_dev(path.join(__dirname,'worker.js'), {
    config:path.join(__dirname,'wrangler.jsonc'), ip:'127.0.0.1', port:0, inspectorPort:0,
    local:true, persist:false, logLevel:'error', vars:{MODERATOR_KEY:key},
    experimental:{disableExperimentalWarning:true, disableDevRegistry:true, watch:false, enableContainers:false}
  });
  const clients = [];
  t.after(async () => {
    for (const {socket} of clients) socket.close();
    await worker.stop();
  });
  const room = 'ws://127.0.0.1:' + worker.port + '/room';
  async function join(token) {
    const client = await connect(room,token);
    clients.push(client);
    return client;
  }
  const first = await join(), second = await join();
  assert.notEqual(first.identity.author, second.identity.author);
  assert.notEqual(first.identity.token, second.identity.token);

  first.send({type:'rename',name:'야간 청취자'});
  assert.equal((await first.next('renamed')).nickname, '야간 청취자');
  first.send({type:'post',body:'밤 방송'});
  const custom = (await second.next('message')).message;
  assert.deepEqual((await first.next('message')).message, custom);
  assert.equal(custom.name, '야간 청취자');
  first.send({type:'post',body:'중복 전송'});
  assert.equal((await first.next('error')).text, '잠시 후 다시 보내 주세요.');

  second.send({type:'rename',name:'Ano'+first.identity.author});
  assert.ok((await second.next('error')).text);
  second.send({type:'post',body:'안녕하세요'});
  const anonymous = (await first.next('message')).message;
  assert.equal(anonymous.name, 'Ano'+second.identity.author);
  assert.equal(anonymous.body, '안녕하세요');
  const closed = new Promise(resolve => first.socket.addEventListener('close',resolve,{once:true}));
  first.socket.close();
  await closed;
  const returned = await join(first.identity.token);
  assert.equal(returned.identity.author,first.identity.author);
  assert.equal(returned.identity.nickname,'야간 청취자');
  assert.ok(returned.identity.history.some(message => message.n === anonymous.n));

  const admin = (command, auth) => worker.fetch('/moderate', {
    method:'POST', headers:auth ? {Authorization:'Bearer '+auth} : {}, body:JSON.stringify(command)
  });
  assert.equal((await admin({action:'reports'})).status,403);
  returned.send({type:'report',n:anonymous.n});
  assert.ok((await returned.next('notice')).text);
  assert.ok((await (await admin({action:'reports'},key)).json()).some(item => item.n===anonymous.n));
  assert.equal((await admin({action:'remove',message:anonymous.n},key)).status,204);
  assert.equal((await second.next('remove')).n,anonymous.n);
  assert.equal((await returned.next('remove')).n,anonymous.n);
  const afterRemoval = await join(second.identity.token);
  assert.ok(!afterRemoval.identity.history.some(message => message.n === anonymous.n));
});

test('station presence, verified admin session, report snapshots and room policy', {timeout:45000}, async t => {
  const id = randomUUID(), password = randomUUID();
  const proof = pbkdf2Sync(password, 'Allradione admin login v1:'+id, 600000, 32, 'sha256').toString('base64');
  const verifier = require('./set-admin.cjs').makeVerifier(id,password);
  const worker = await unstable_dev(path.join(__dirname,'worker.js'), {
    config:path.join(__dirname,'wrangler.jsonc'), ip:'127.0.0.1', port:0, inspectorPort:0,
    local:true, persist:false, logLevel:'error', vars:{ADMIN_VERIFIER:verifier},
    experimental:{disableExperimentalWarning:true, disableDevRegistry:true, watch:false, enableContainers:false}
  });
  const clients = [];
  t.after(async () => {
    for (const {socket} of clients) socket.close();
    await worker.stop();
  });
  async function join(token, station) {
    const client = await connect('ws://127.0.0.1:'+worker.port+'/room',token,station);
    clients.push(client);
    return client;
  }
  const admin = await join();
  const station = {name:'밤 방송',countrycode:'KR'};
  const listener = await join(undefined,{...station,countrycode:'kr',url:'private audio address'});
  assert.deepEqual((await admin.next('presence')).station,station);
  assert.deepEqual(listener.identity.presence,[{author:listener.identity.author,station}]);
  assert.deepEqual(listener.identity.policy,{slowSeconds:2,lockUntil:0});
  for (const name of ['관리자','관\u200d리자','管理者','Ａｄｍｉｎ']) {
    listener.send({type:'rename',name});
    assert.equal((await listener.next('error')).scope,'rename');
  }
  listener.send({type:'adminPolicy',lockMinutes:-1});
  assert.equal((await listener.next('error')).scope,'admin');
  listener.send({type:'adminReports'});
  assert.equal((await listener.next('error')).scope,'admin');

  admin.send({type:'adminLogin',id,password});
  assert.equal((await admin.next('error')).scope,'login');
  admin.send({type:'adminLogin',id,proof:randomBytes(32).toString('base64')});
  assert.equal((await admin.next('error')).scope,'login');
  admin.send({type:'adminLogin',id,proof});
  const session = await admin.next('adminSession');
  assert.equal(session.active,true);
  assert.equal(session.nickname,'관리자');
  assert.equal(admin.identity.adminResume,true);
  assert.match(session.resumeToken,/^[0-9a-f]{64}$/);
  assert.ok(session.expiresAt > Date.now() && session.expiresAt <= Date.now()+3600000);

  admin.send({type:'adminPolicy',slowSeconds:0,lockMinutes:7});
  const locked = (await listener.next('policy')).policy;
  assert.ok(locked.lockUntil > Date.now()+6*60000);
  assert.equal(locked.slowSeconds,0);
  admin.send({type:'adminPolicy',slowSeconds:10});
  assert.equal((await listener.next('policy')).policy.lockUntil,locked.lockUntil);
  listener.send({type:'post',body:'잠금'});
  assert.equal((await listener.next('error')).scope,'post');
  admin.send({type:'adminPolicy',lockMinutes:-1});
  assert.equal((await listener.next('policy')).policy.lockUntil,-1);
  admin.send({type:'post',body:'잠금'});
  assert.equal((await admin.next('error')).scope,'post');
  admin.send({type:'adminPolicy',lockMinutes:0,slowSeconds:0});
  assert.equal((await listener.next('policy')).policy.lockUntil,0);

  admin.send({type:'post',body:'공지'});
  const announcement = (await listener.next('message')).message;
  assert.equal(announcement.name,'관리자');
  assert.equal(announcement.admin,true);
  await admin.next('message');

  listener.send({type:'rename',name:'청취자'});
  await listener.next('renamed');
  listener.send({type:'post',body:'신고된 원문 <원본>',admin:true,name:'관리자'});
  const original = (await admin.next('message')).message;
  assert.equal(original.admin,false);
  assert.equal(original.name,'청취자');
  assert.deepEqual(original.station,station);
  listener.send({type:'report',n:original.n});
  assert.equal((await listener.next('error')).scope,'report');
  for (let i=0; i<2; i++) {
    admin.send({type:'report',n:original.n,body:'바뀐 글',name:'바뀐 이름'});
    await admin.next('notice');
  }
  listener.send({type:'rename',name:'다른 닉네임'});
  await listener.next('renamed');
  listener.send({type:'presence',station:null});
  assert.equal((await admin.next('presence')).station,null);
  admin.send({type:'adminReports'});
  const [report] = (await admin.next('reports')).items;
  assert.equal(report.reports,1);
  assert.equal(report.author,listener.identity.author);
  assert.equal(report.name,original.name);
  assert.equal(report.body,original.body);
  assert.equal(report.time,original.time);

  admin.send({type:'adminBan',author:listener.identity.author,minutes:13});
  const timed = (await listener.next('ban')).until;
  assert.ok(timed > Date.now()+12*60000);
  await admin.next('notice');
  listener.send({type:'post',body:'차단'});
  assert.equal((await listener.next('error')).scope,'post');
  const reconnected = await join(listener.identity.token);
  assert.equal(reconnected.identity.bannedUntil,timed);
  admin.send({type:'adminBan',author:listener.identity.author,minutes:-1});
  assert.equal((await reconnected.next('ban')).until,-1);
  assert.equal((await listener.next('ban')).until,-1);
  await admin.next('notice');
  admin.send({type:'adminReports'});
  assert.equal((await admin.next('reports')).items[0].bannedUntil,-1);
  admin.send({type:'adminBan',author:listener.identity.author,minutes:0});
  assert.equal((await listener.next('ban')).until,0);
  await admin.next('notice');
  listener.send({type:'post',body:'해제'});
  assert.equal((await admin.next('message')).message.body,'해제');

  const otherSession = await join(admin.identity.token);
  otherSession.send({type:'adminReports'});
  assert.equal((await otherSession.next('error')).scope,'admin');
  otherSession.send({type:'adminResume',resumeToken:admin.identity.token});
  assert.equal((await otherSession.next('adminSession')).active,false);
  listener.send({type:'adminResume',resumeToken:session.resumeToken});
  assert.equal((await listener.next('adminSession')).active,false);
  otherSession.send({type:'adminResume',resumeToken:session.resumeToken});
  const restored = await otherSession.next('adminSession');
  assert.equal(restored.active,true);
  assert.equal(restored.expiresAt,session.expiresAt);
  assert.equal(restored.resumeToken,undefined);
  otherSession.send({type:'adminReports'});
  assert.equal((await otherSession.next('reports')).items[0].n,original.n);
  admin.send({type:'adminLogout'});
  assert.equal((await admin.next('adminSession')).active,false);
  assert.equal((await otherSession.next('adminSession')).active,false);
  otherSession.send({type:'adminResume',resumeToken:session.resumeToken});
  assert.equal((await otherSession.next('adminSession')).active,false);
  admin.send({type:'adminBan',author:listener.identity.author,minutes:-1});
  assert.equal((await admin.next('error')).scope,'admin');
  for (let i=0;i<2;i++) {
    otherSession.send({type:'adminLogin',id,proof:randomBytes(32).toString('base64')});
    assert.equal((await otherSession.next('error')).scope,'login');
  }
  // A new visitor on the same network still shares the login attempt budget.
  const newcomer = await join();
  newcomer.send({type:'adminLogin',id,proof});
  assert.match((await newcomer.next('error')).text,/요청이 많/);
});

test('saved administrator credentials expire, rotate and revoke across reconnects', {timeout:45000}, async t => {
  const id = randomUUID(), password = randomUUID();
  const proof = pbkdf2Sync(password,'Allradione admin login v1:'+id,600000,32,'sha256').toString('base64');
  const verifier = require('./set-admin.cjs').makeVerifier(id,password);
  const config = secret => ({...convertV4MiniflareOptions({name:'session-test',script:readFileSync(path.join(__dirname,'worker.js'),'utf8'),
    modules:true,compatibilityDate:'2026-10-01',bindings:{ADMIN_VERIFIER:secret},cf:false,
    durableObjects:{ROOM:{className:'GlobalChat',useSQLite:true}},ratelimits:{JOINS:{namespace_id:'1001',simple:{limit:20,period:60}}}}),
    unsafeInspectDurableObjects:true});
  const mf = new Miniflare(config(verifier));
  const clients = [];
  t.after(async () => { for (const client of clients) client.socket.close(); await mf.dispose(); });
  const join = async token => {
    const client = await connect((await mf.ready).toString().replace(/^http:/,'ws:')+'room',token);
    clients.push(client);
    return client;
  };
  const disconnect = async client => {
    const closed = new Promise(resolve => client.socket.addEventListener('close',resolve,{once:true}));
    client.socket.close();
    await closed;
  };
  const authenticate = async (client,packet) => { client.send(packet); return client.next('adminSession'); };
  const login = client => authenticate(client,{type:'adminLogin',id,proof});
  const resume = (client,resumeToken) => authenticate(client,{type:'adminResume',resumeToken});
  const first = await join();
  const token = first.identity.token;
  const previous = await login(first);
  const current = await login(first);
  assert.notEqual(previous.resumeToken,current.resumeToken);
  const db = await mf.unsafeGetDurableObjectStorage('session-test','GlobalChat',{name:'global'});
  const rows = await db.exec('SELECT token_hash,expires FROM admin_sessions');
  assert.deepEqual(rows,[{token_hash:createHash('sha256').update(current.resumeToken).digest('hex'),expires:current.expiresAt}]);
  await disconnect(first);

  const peer = await join(token);
  assert.equal((await resume(peer,previous.resumeToken)).active,false);
  assert.equal((await resume(peer,current.resumeToken)).active,true);
  const fresh = await join(token);
  assert.equal((await authenticate(fresh,{type:'adminLogout',resumeToken:current.resumeToken})).active,false);
  assert.equal((await peer.next('adminSession')).active,false);
  assert.equal((await resume(peer,current.resumeToken)).active,false);

  const limited = await login(fresh);
  await db.exec('UPDATE admin_sessions SET expires=?',Date.now()-1);
  fresh.send({type:'adminReports'});
  assert.equal((await fresh.next('adminSession')).active,false);
  assert.equal((await fresh.next('error')).scope,'admin');
  assert.equal((await resume(peer,limited.resumeToken)).active,false);

  const last = await login(peer);
  await disconnect(peer);
  await disconnect(fresh);
  await mf.setOptions(config(verifier));
  const sameWorker = await join(token);
  assert.equal((await resume(sameWorker,last.resumeToken)).expiresAt,last.expiresAt);
  await disconnect(sameWorker);
  await mf.setOptions(config(require('./set-admin.cjs').makeVerifier(id,randomUUID())));
  const restarted = await join(token);
  assert.equal((await resume(restarted,last.resumeToken)).active,false);
});

test('upgrade a 0.2.4 SQLite room and retain reported text after public history expires', {timeout:30000}, async t => {
  const key = randomUUID();
  const token = randomUUID();
  const options = {name:'upgrade-test',modules:true,compatibilityDate:'2026-10-01',
    bindings:{MODERATOR_KEY:key},durableObjects:{ROOM:{className:'GlobalChat',useSQLite:true}},
    ratelimits:{JOINS:{namespace_id:'1001',simple:{limit:20,period:60}}}};
  const config = script => ({...convertV4MiniflareOptions({...options,script,cf:false}),unsafeInspectDurableObjects:true});
  const fixture = "import { DurableObject } from 'cloudflare:workers'; export class GlobalChat extends DurableObject {} export default {fetch(){return new Response()}}";
  const mf = new Miniflare(config(fixture));
  t.after(() => mf.dispose());
  const inspect = () => mf.unsafeGetDurableObjectStorage('upgrade-test','GlobalChat',{name:'global'});
  const old = await inspect();
  await old.exec('CREATE TABLE visitors(n INTEGER PRIMARY KEY AUTOINCREMENT,token TEXT UNIQUE,nickname TEXT,seen INTEGER,last_post INTEGER DEFAULT 0)');
  await old.exec('CREATE TABLE messages(n INTEGER PRIMARY KEY AUTOINCREMENT,author INTEGER,name TEXT,body TEXT,time INTEGER)');
  await old.exec('CREATE TABLE reports(message INTEGER,reporter INTEGER,time INTEGER,PRIMARY KEY(message,reporter))');
  const now = Date.now(), day = 86400000;
  await old.exec('INSERT INTO visitors(token,nickname,seen) VALUES(?,?,?)',token,'관리자',now);
  await old.exec('INSERT INTO messages(author,name,body,time) VALUES(1,?,?,?)','관리자','신고한 예전 글',now-day-1);
  await old.exec('INSERT INTO messages(author,name,body,time) VALUES(1,?,?,?)','관리자','어제 쓴 글',now-60000);
  await old.exec('INSERT INTO reports VALUES(1,2,?)',now-120000);
  await mf.setOptions(config(readFileSync(path.join(__dirname,'worker.js'),'utf8')));
  const client = await connect((await mf.ready).toString().replace(/^http:/,'ws:')+'room',token);
  t.after(() => client.socket.close());
  assert.equal(client.identity.author,1);
  assert.equal(client.identity.nickname,'');
  assert.deepEqual(client.identity.history.map(item => [item.name,item.admin,item.body]),[['Ano1',false,'어제 쓴 글']]);
  const readReports = async () => (await mf.dispatchFetch('http://localhost/moderate',{method:'POST',
    headers:{Authorization:'Bearer '+key},body:JSON.stringify({action:'reports'})})).json();
  assert.deepEqual((await readReports()).map(item=>[item.name,item.body]),[['Ano1','신고한 예전 글']]);
  const db = await inspect();
  await db.exec('UPDATE room_settings SET lock_until=? WHERE id=1',now-1);
  await db.exec('UPDATE visitors SET banned_until=? WHERE n=1',now-1);
  client.send({type:'post',body:'시간제한 종료'});
  assert.equal((await client.next('message')).message.name,'Ano1');
  await db.exec('UPDATE reports SET time=?',now-31*day);
  const next = await connect((await mf.ready).toString().replace(/^http:/,'ws:')+'room');
  t.after(() => next.socket.close());
  assert.deepEqual(await readReports(),[]);
  assert.equal(next.identity.policy.lockUntil,0);
});
