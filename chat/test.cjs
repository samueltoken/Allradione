'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const path = require('node:path');
const { unstable_dev } = require('wrangler');

// Run with node --test chat/test.cjs after npm ci --prefix chat.
// Each run starts a fresh local room with a temporary moderation key.
async function connect(url, token) {
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
  send({type:'join',token});
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
