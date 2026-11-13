import { DurableObject } from 'cloudflare:workers';

const HISTORY = 80;
const DAY = 86400000;
const id = () => crypto.randomUUID();
const send = (socket, packet) => socket.send(JSON.stringify(packet));
const clean = (value, max) => typeof value === 'string'
  ? value.normalize('NFC').replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, ' ').trim().slice(0, max)
  : '';

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (path === '/health' && request.method === 'GET') return Response.json({service:'allradione-chat', version:1});
    if (path === '/moderate' && request.method === 'POST') {
      if (!env.MODERATOR_KEY || request.headers.get('Authorization') !== 'Bearer ' + env.MODERATOR_KEY) {
        return new Response(null, {status:403});
      }
    } else if (path === '/room' && request.method === 'GET' && request.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
      const limit = await env.JOINS.limit({key:request.headers.get('CF-Connecting-IP') || 'local'});
      if (!limit.success) return new Response(null, {status:429});
    } else {
      return new Response(null, {status:404});
    }
    return env.ROOM.getByName('global').fetch(request);
  }
};

export class GlobalChat extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS visitors (
      n INTEGER PRIMARY KEY AUTOINCREMENT, token TEXT UNIQUE, nickname TEXT, seen INTEGER, last_post INTEGER DEFAULT 0);
      CREATE TABLE IF NOT EXISTS messages (n INTEGER PRIMARY KEY AUTOINCREMENT, author INTEGER, name TEXT, body TEXT, time INTEGER);
      CREATE TABLE IF NOT EXISTS reports (message INTEGER, reporter INTEGER, time INTEGER, PRIMARY KEY(message, reporter));
      CREATE INDEX IF NOT EXISTS visitor_age ON visitors(seen);`);
  }
  prune(now) {
    this.sql.exec('DELETE FROM messages WHERE time < ? OR n <= (SELECT MAX(n) FROM messages) - ?', now - DAY, HISTORY);
    this.sql.exec('DELETE FROM reports WHERE message NOT IN (SELECT n FROM messages)');
    this.sql.exec('DELETE FROM visitors WHERE seen < ?', now - 30*DAY);
  }
  async alarm() {
    this.prune(Date.now());
    if (this.sql.exec('SELECT 1 FROM visitors LIMIT 1').toArray().length) {
      await this.ctx.storage.setAlarm(Date.now()+DAY);
    }
  }
  broadcast(packet) {
    for (const socket of this.ctx.getWebSockets()) {
      if (socket.deserializeAttachment()?.author) {
        try { send(socket, packet); } catch { /* Already disconnected */ }
      }
    }
  }
  async fetch(request) {
    if (new URL(request.url).pathname === '/moderate') {
      const {action, message} = await request.json().catch(() => ({}));
      if (action === 'reports') return Response.json(this.sql.exec(
        'SELECT m.n, m.name, m.body, count(*) AS reports FROM reports r JOIN messages m ON m.n=r.message GROUP BY m.n ORDER BY reports DESC').toArray());
      if (action !== 'remove' || !Number.isSafeInteger(message)) return new Response(null,{status:400});
      this.sql.exec('DELETE FROM messages WHERE n=?', message);
      this.sql.exec('DELETE FROM reports WHERE message=?', message);
      this.broadcast({type:'remove', n:message});
      return new Response(null, {status:204});
    }
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({joined:false});
    return new Response(null, {status:101, webSocket:client});
  }
  async webSocketMessage(socket, raw) {
    if (typeof raw !== 'string' || raw.length > 2400) return socket.close(1008,'Invalid message');
    let data;
    try { data = JSON.parse(raw); } catch { return socket.close(1008,'Invalid message'); }
    if (!data || typeof data !== 'object') return socket.close(1008,'Invalid message');
    const session = socket.deserializeAttachment();
    const now = Date.now();
    if (!session?.author) {
      if (data.type !== 'join') return socket.close(1008,'Join first');
      this.prune(now);
      let visitor = typeof data.token === 'string' && data.token.length === 36
        ? this.sql.exec('SELECT * FROM visitors WHERE token=?', data.token).toArray()[0] : null;
      if (!visitor) visitor = this.sql.exec(
        "INSERT INTO visitors(token,nickname,seen) VALUES(?,'',?) RETURNING *",id(),now).one();
      this.sql.exec('UPDATE visitors SET seen=? WHERE n=?',now,visitor.n);
      socket.serializeAttachment({author:visitor.n});
      send(socket,{type:'welcome', token:visitor.token, author:visitor.n, nickname:visitor.nickname,
        history:this.sql.exec('SELECT n,author,name,body,time FROM messages ORDER BY n').toArray()});
      if (await this.ctx.storage.getAlarm() === null) await this.ctx.storage.setAlarm(now+DAY);
      return;
    }
    const visitor = this.sql.exec('SELECT * FROM visitors WHERE n=?',session.author).toArray()[0];
    if (!visitor) return socket.close(1001,'Reconnect');
    if (data.type === 'rename') {
      const nickname = clean(data.name,20);
      if (/^ano\d+$/i.test(nickname)) return send(socket,{type:'error',text:'Ano 번호는 자동으로 지정됩니다.'});
      this.sql.exec('UPDATE visitors SET nickname=?, seen=? WHERE n=?',nickname,now,visitor.n);
      send(socket,{type:'renamed',nickname});
    } else if (data.type === 'report' && Number.isSafeInteger(data.n)) {
      this.sql.exec('INSERT OR IGNORE INTO reports SELECT n,?,? FROM messages WHERE n=?',visitor.n,now,data.n);
      send(socket,{type:'notice',text:'신고를 접수했습니다.'});
    } else if (data.type === 'post') {
      const body = clean(data.body,360);
      if (!body) return;
      if (now - visitor.last_post < 1400) return send(socket,{type:'error',text:'잠시 후 다시 보내 주세요.'});
      this.sql.exec('UPDATE visitors SET last_post=?, seen=? WHERE n=?',now,now,visitor.n);
      const message = this.sql.exec('INSERT INTO messages(author,name,body,time) VALUES(?,?,?,?) RETURNING *',
        visitor.n,visitor.nickname || 'Ano'+visitor.n,body,now).one();
      this.prune(now);
      this.broadcast({type:'message',message});
    }
  }
  webSocketClose(socket,code) { try { socket.close(code === 1000 ? 1000 : 1001); } catch {} }
  webSocketError(socket) { try { socket.close(1011); } catch {} }
}
