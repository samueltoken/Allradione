import { DurableObject } from 'cloudflare:workers';

const HISTORY = 80;
const DAY = 86400000;
const SESSION_LIFETIME = 60 * 60000;
const ADMIN_NAME = '관리자';
const encoder = new TextEncoder();
const send = (socket, packet) => socket.send(JSON.stringify(packet));
const fail = (socket, scope, text) => send(socket, {type:'error', scope, text});
const clean = (value, max) => typeof value === 'string'
  ? value.normalize('NFC').replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, ' ').trim().slice(0, max)
  : '';
const reserved = name => /^(관리자|운영자|admin|administrator|moderator|管理者|管理員|管理员|管理員さん|管理人|administrateur|administrador|amministratore|администратор)$/i.test(
  (name || '').normalize('NFKC').replace(/[\s\p{Cf}]/gu, ''));
const publicName = nickname => reserved(nickname) ? '' : nickname || '';
const currentUntil = (value, now) => value === -1 || value > now ? value : 0;
const validMinutes = value => Number.isSafeInteger(value) && value >= -1 && value <= 5256000;
const until = (minutes, now) => minutes > 0 ? now + minutes * 60000 : minutes;
const unbase64 = value => Uint8Array.from(atob(value), c => c.charCodeAt(0));
const hex = bytes => Array.from(bytes, byte => byte.toString(16).padStart(2,'0')).join('');
const digest = async value => hex(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value))));
const validResumeToken = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);

function stationInfo(value) {
  const name = clean(value?.name, 100);
  const countrycode = clean(value?.countrycode, 3).toUpperCase();
  return name ? {name, countrycode:/^[A-Z]{2}$/.test(countrycode) ? countrycode : ''} : null;
}

function messageInfo(row) {
  const {admin, station_name, country_code, ...message} = row;
  return {...message, admin:!!admin, name:admin ? ADMIN_NAME : publicName(message.name) || 'Ano' + message.author,
    station:station_name ? {name:station_name, countrycode:country_code || ''} : null};
}

async function verifyLogin(secret, id, proof) {
  if (!secret || typeof id !== 'string' || !id.length || id.length > 128 ||
      typeof proof !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(proof)) return false;
  try {
    const config = JSON.parse(secret);
    if (config.v !== 1 || config.iterations !== 100000) return false;
    const salt = unbase64(config.salt);
    const hash = unbase64(config.hash);
    if (salt.length !== 32 || hash.length !== 32) return false;
    const key = await crypto.subtle.importKey('raw', encoder.encode(JSON.stringify([id,proof])), 'PBKDF2', false, ['deriveBits']);
    const actual = await crypto.subtle.deriveBits({name:'PBKDF2', salt, iterations:100000, hash:'SHA-256'}, key, 256);
    return crypto.subtle.timingSafeEqual(hash, actual);
  } catch { return false; }
}

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (path === '/health' && request.method === 'GET') return Response.json({service:'allradione-chat', version:2});
    if (path === '/moderate' && request.method === 'POST') {
      if (!env.MODERATOR_KEY) return new Response(null, {status:403});
      const hashes = await Promise.all([request.headers.get('Authorization') || '', 'Bearer ' + env.MODERATOR_KEY]
        .map(value => crypto.subtle.digest('SHA-256', encoder.encode(value))));
      if (!crypto.subtle.timingSafeEqual(...hashes)) return new Response(null, {status:403});
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
    ctx.blockConcurrencyWhile(async () => {
      this.verifierHash = env.ADMIN_VERIFIER ? await digest(env.ADMIN_VERIFIER) : '';
    });
    // Create the 0.2.4 base first so existing and brand-new rooms use the same migration.
    ctx.storage.transactionSync(() => {
      this.sql.exec(`CREATE TABLE IF NOT EXISTS visitors (
        n INTEGER PRIMARY KEY AUTOINCREMENT, token TEXT UNIQUE, nickname TEXT, seen INTEGER, last_post INTEGER DEFAULT 0);
        CREATE TABLE IF NOT EXISTS messages (n INTEGER PRIMARY KEY AUTOINCREMENT, author INTEGER, name TEXT, body TEXT, time INTEGER);
        CREATE TABLE IF NOT EXISTS reports (message INTEGER, reporter INTEGER, time INTEGER, PRIMARY KEY(message, reporter));
        CREATE INDEX IF NOT EXISTS visitor_age ON visitors(seen);
        CREATE TABLE IF NOT EXISTS room_settings (id INTEGER PRIMARY KEY, slow_seconds INTEGER, lock_until INTEGER, network_salt TEXT);
        CREATE TABLE IF NOT EXISTS admin_sessions (
          author INTEGER PRIMARY KEY, token_hash TEXT NOT NULL, expires INTEGER NOT NULL, verifier_hash TEXT NOT NULL);
      `);
      if (!this.sql.exec('SELECT id FROM room_settings LIMIT 1').toArray().length) {
        this.sql.exec(`ALTER TABLE visitors ADD COLUMN banned_until INTEGER DEFAULT 0;
          ALTER TABLE messages ADD COLUMN admin INTEGER DEFAULT 0;
          ALTER TABLE messages ADD COLUMN station_name TEXT;
          ALTER TABLE messages ADD COLUMN country_code TEXT;
          CREATE TABLE report_snapshots (n INTEGER PRIMARY KEY, author INTEGER, name TEXT, body TEXT, time INTEGER, admin INTEGER);
          INSERT INTO report_snapshots SELECT DISTINCT m.n,m.author,m.name,m.body,m.time,0 FROM messages m JOIN reports r ON m.n=r.message;
          CREATE INDEX report_time ON reports(time);
          CREATE INDEX reporter_time ON reports(reporter,time);
          CREATE TABLE limits (bucket TEXT PRIMARY KEY, expires INTEGER, count INTEGER);
        `);
        this.sql.exec('INSERT INTO room_settings VALUES(1,2,0,?)',crypto.randomUUID());
      }
    });
  }

  policy(now) {
    const row = this.sql.exec('SELECT slow_seconds,lock_until FROM room_settings WHERE id=1').one();
    return {slowSeconds:row.slow_seconds, lockUntil:currentUntil(row.lock_until,now)};
  }

  pruneHistory(now) {
    this.sql.exec('DELETE FROM messages WHERE time < ? OR n <= (SELECT MAX(n) FROM messages) - ?', now - DAY, HISTORY);
  }

  prune(now) {
    this.pruneHistory(now);
    this.sql.exec('DELETE FROM reports WHERE time < ?', now - 30 * DAY);
    this.sql.exec('DELETE FROM report_snapshots WHERE n NOT IN (SELECT message FROM reports)');
    this.sql.exec('DELETE FROM visitors WHERE seen < ? AND banned_until != -1 AND banned_until <= ?', now - 30 * DAY, now);
    this.sql.exec('DELETE FROM limits WHERE expires <= ?',now);
    this.sql.exec('DELETE FROM admin_sessions WHERE expires <= ? OR verifier_hash != ?',now,this.verifierHash);
  }

  async alarm() {
    const now = Date.now();
    let next = now + DAY;
    for (const socket of this.ctx.getWebSockets()) {
      const session = socket.deserializeAttachment();
      if (!session?.author) {
        if (session?.joinDeadline > now) next = Math.min(next,session.joinDeadline);
        else { try { socket.close(1008,'Join timed out'); } catch {} }
      }
    }
    this.prune(now);
    if (next < now + DAY || this.sql.exec('SELECT 1 FROM visitors LIMIT 1').toArray().length) {
      await this.ctx.storage.setAlarm(next);
    }
  }

  broadcast(packet) {
    for (const socket of this.ctx.getWebSockets()) {
      if (socket.deserializeAttachment()?.author) {
        try { send(socket, packet); } catch { /* Socket closed during broadcast. */ }
      }
    }
  }

  presence(exclude) {
    const authors = new Map();
    for (const other of this.ctx.getWebSockets()) {
      if (other === exclude) continue;
      const session = other.deserializeAttachment();
      if (!session?.author || !session.station) continue;
      const previous = authors.get(session.author);
      if (!previous || previous.stationTime <= session.stationTime) authors.set(session.author, session);
    }
    return authors;
  }

  publishPresence(author, exclude) {
    this.broadcast({type:'presence', author, station:this.presence(exclude).get(author)?.station || null});
  }

  reports() {
    return this.sql.exec(`SELECT s.*, count(*) AS reports, max(r.time) AS reportedAt,
      coalesce(v.banned_until,0) AS bannedUntil FROM report_snapshots s JOIN reports r ON r.message=s.n
      LEFT JOIN visitors v ON v.n=s.author WHERE r.time >= ? GROUP BY s.n ORDER BY reportedAt DESC,s.n DESC LIMIT 500`,Date.now()-30*DAY).toArray()
      .map(row => ({...row, admin:!!row.admin, name:row.admin ? ADMIN_NAME : publicName(row.name) || 'Ano' + row.author,
        bannedUntil:currentUntil(row.bannedUntil,Date.now())}));
  }

  async fetch(request) {
    if (new URL(request.url).pathname === '/moderate') {
      const command = await request.json().catch(() => null);
      if (command?.action === 'reports') return Response.json(this.reports());
      if (command?.action !== 'remove' || !Number.isSafeInteger(command.message)) return new Response(null,{status:400});
      this.ctx.storage.transactionSync(() => {
        this.sql.exec('DELETE FROM messages WHERE n=?',command.message);
        this.sql.exec('DELETE FROM reports WHERE message=?',command.message);
        this.sql.exec('DELETE FROM report_snapshots WHERE n=?',command.message);
      });
      this.broadcast({type:'remove',n:command.message});
      return new Response(null,{status:204});
    }
    const salt = this.sql.exec('SELECT network_salt FROM room_settings WHERE id=1').one().network_salt;
    const ip = request.headers.get('CF-Connecting-IP') || 'local';
    const digest = await crypto.subtle.digest('SHA-256', encoder.encode(salt + ':' + ip));
    const network = btoa(String.fromCharCode(...new Uint8Array(digest)));
    if (this.ctx.getWebSockets(network).length >= 32) return new Response(null,{status:429});
    if (this.ctx.getWebSockets().length >= 1000) return new Response(null,{status:503});
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server,[network]);
    const joinDeadline = Date.now() + 20000;
    server.serializeAttachment({network,joinDeadline});
    const alarm = await this.ctx.storage.getAlarm();
    if (alarm === null || alarm > joinDeadline) await this.ctx.storage.setAlarm(joinDeadline);
    return new Response(null, {status:101, webSocket:client});
  }

  async join(socket, session, data, now) {
    if (session.joinDeadline && now > session.joinDeadline) return socket.close(1008,'Join timed out');
    this.pruneHistory(now);
    let visitor = typeof data.token === 'string' && data.token.length === 36
      ? this.sql.exec('SELECT * FROM visitors WHERE token=?', data.token).toArray()[0] : null;
    if (visitor && visitor.seen < now-30*DAY && !currentUntil(visitor.banned_until,now)) visitor = null;
    if (!visitor) visitor = this.sql.exec(
      "INSERT INTO visitors(token,nickname,seen) VALUES(?,'',?) RETURNING *",crypto.randomUUID(),now).one();
    const nickname = publicName(visitor.nickname);
    this.sql.exec('UPDATE visitors SET seen=?,nickname=? WHERE n=?',now,nickname,visitor.n);
    const bannedUntil = currentUntil(visitor.banned_until,now);
    const station = bannedUntil ? null : stationInfo(data.station);
    socket.serializeAttachment({...session,author:visitor.n,station,stationTime:now});
    const presence = Array.from(this.presence().values(), entry => ({author:entry.author,station:entry.station}));
    send(socket,{type:'welcome',token:visitor.token,author:visitor.n,nickname,history:this.sql.exec('SELECT * FROM messages ORDER BY n').toArray().map(messageInfo),
      policy:this.policy(now),bannedUntil,presence,adminResume:true});
    if (station) this.publishPresence(visitor.n);
    if (await this.ctx.storage.getAlarm() === null) await this.ctx.storage.setAlarm(now+DAY);
  }

  takeLimit(bucket, max, windowMs, now) {
    const row = this.sql.exec('SELECT count,expires FROM limits WHERE bucket=?',bucket).toArray()[0];
    if (row && row.expires > now && row.count >= max) return false;
    if (!row || row.expires <= now) {
      this.sql.exec('INSERT OR REPLACE INTO limits(bucket,expires,count) VALUES(?,?,1)',bucket,now+windowMs);
    } else {
      this.sql.exec('UPDATE limits SET count=count+1 WHERE bucket=?',bucket);
    }
    return true;
  }

  savedSession(author, tokenHash, now) {
    if (!tokenHash || !this.verifierHash) return;
    return this.sql.exec(`SELECT s.expires FROM admin_sessions s JOIN visitors v ON v.n=s.author
      WHERE s.author=? AND s.token_hash=? AND s.expires>? AND s.verifier_hash=?
      AND v.banned_until != -1 AND v.banned_until <= ?`,author,tokenHash,now,this.verifierHash,now).toArray()[0];
  }

  startAttempt(socket, session) {
    const attempt = crypto.randomUUID();
    socket.serializeAttachment({...session,attempt});
    return attempt;
  }

  finishAttempt(socket, attempt) {
    const latest = socket.deserializeAttachment();
    if (latest?.attempt !== attempt) return;
    delete latest.attempt;
    socket.serializeAttachment(latest);
    return latest;
  }

  activate(socket, session, sessionHash, expiresAt, resumeToken) {
    socket.serializeAttachment({...session,sessionHash,expiresAt});
    send(socket,{type:'adminSession',active:true,resumeToken,expiresAt,nickname:ADMIN_NAME,policy:this.policy(Date.now())});
  }

  async login(socket, session, data, visitor, now) {
    if (!session.network || !this.takeLimit('login:' + session.network, 5, 10 * 60000, now) ||
        !this.takeLimit('login:global', 30, 60000, now)) {
      return fail(socket,'login','로그인 요청이 많습니다. 잠시 후 다시 시도해 주세요.');
    }
    const attempt = this.startAttempt(socket,session);
    const valid = await verifyLogin(this.env.ADMIN_VERIFIER,data.id,data.proof);
    const token = valid ? hex(crypto.getRandomValues(new Uint8Array(32))) : '';
    const sessionHash = valid ? await digest(token) : '';
    const latest = this.finishAttempt(socket,attempt);
    if (!latest) return;
    const current = this.sql.exec('SELECT banned_until FROM visitors WHERE n=?',visitor.n).toArray()[0];
    if (!valid || !current || currentUntil(current.banned_until,Date.now())) {
      return fail(socket,'login','관리자 로그인 정보를 확인해 주세요.');
    }
    const expiresAt = Date.now() + SESSION_LIFETIME;
    const previous = this.sql.exec('SELECT token_hash FROM admin_sessions WHERE author=?',visitor.n).toArray()[0];
    if (previous) this.revoke(socket,visitor,previous.token_hash);
    this.sql.exec('INSERT OR REPLACE INTO admin_sessions(author,token_hash,expires,verifier_hash) VALUES(?,?,?,?)',
      visitor.n,sessionHash,expiresAt,this.verifierHash);
    this.activate(socket,latest,sessionHash,expiresAt,token);
  }

  async resume(socket, session, data, visitor) {
    const attempt = this.startAttempt(socket,session);
    const sessionHash = validResumeToken(data.resumeToken) ? await digest(data.resumeToken) : '';
    const latest = this.finishAttempt(socket,attempt);
    if (!latest) return;
    const now = Date.now();
    const saved = this.savedSession(visitor.n,sessionHash,now);
    if (!saved) return this.clearAdmin(socket,latest,visitor);
    this.activate(socket,latest,sessionHash,saved.expires);
  }

  clearAdmin(socket, session, visitor) {
    delete session.sessionHash;
    delete session.expiresAt;
    delete session.attempt;
    socket.serializeAttachment(session);
    send(socket,{type:'adminSession',active:false,nickname:publicName(visitor.nickname)});
  }

  revoke(socket, visitor, sessionHash) {
    const removed = this.sql.exec('DELETE FROM admin_sessions WHERE author=? AND token_hash=? RETURNING author',visitor.n,sessionHash).toArray();
    if (!removed.length) return;
    for (const peer of this.ctx.getWebSockets()) {
      if (peer === socket) continue;
      const session = peer.deserializeAttachment();
      if (session?.author === visitor.n && session.sessionHash === sessionHash) {
        try { this.clearAdmin(peer,session,visitor); } catch { /* Peer already closed. */ }
      }
    }
  }

  async logout(socket, session, visitor, resumeToken) {
    if (session.sessionHash) {
      this.revoke(socket,visitor,session.sessionHash);
    } else if (validResumeToken(resumeToken)) {
      const attempt = this.startAttempt(socket,session);
      this.revoke(socket,visitor,await digest(resumeToken));
      session = this.finishAttempt(socket,attempt);
      if (!session) return;
    }
    this.clearAdmin(socket,session,visitor);
  }

  setPolicy(socket, data, now) {
    const {slowSeconds,lockMinutes} = data;
    if ((slowSeconds === undefined && lockMinutes === undefined) ||
        (slowSeconds !== undefined && (!Number.isSafeInteger(slowSeconds) || slowSeconds < 0 || slowSeconds > 3600)) ||
        (lockMinutes !== undefined && !validMinutes(lockMinutes))) return fail(socket,'admin','설정 값을 확인해 주세요.');
    const values = this.policy(now);
    this.sql.exec('UPDATE room_settings SET slow_seconds=?,lock_until=? WHERE id=1',
      slowSeconds ?? values.slowSeconds, lockMinutes === undefined ? values.lockUntil : until(lockMinutes,now));
    this.broadcast({type:'policy',policy:this.policy(now)});
  }

  setBan(socket, session, data, now) {
    if (!Number.isSafeInteger(data.author) || data.author < 1 || !validMinutes(data.minutes)) {
      return fail(socket,'admin','차단 대상과 기간을 확인해 주세요.');
    }
    const peers = this.ctx.getWebSockets().filter(peer => peer.deserializeAttachment()?.author === data.author);
    if (session.author === data.author || peers.some(peer => this.savedSession(data.author,peer.deserializeAttachment().sessionHash,now))) {
      return fail(socket,'admin','접속 중인 관리자는 차단할 수 없습니다.');
    }
    const end = until(data.minutes,now);
    const changed = this.sql.exec('UPDATE visitors SET banned_until=? WHERE n=? RETURNING n',end,data.author).toArray();
    if (!changed.length) return fail(socket,'admin','해당 사용자를 찾을 수 없습니다.');
    if (end) this.sql.exec('DELETE FROM admin_sessions WHERE author=?',data.author);
    for (const peer of peers) {
      try {
        if (end) peer.serializeAttachment({...peer.deserializeAttachment(),station:null,attempt:null,sessionHash:null,expiresAt:0});
        send(peer,{type:'ban',until:end});
      } catch { /* Another connection may already have closed. */ }
    }
    if (end && peers.length) this.publishPresence(data.author);
    send(socket,{type:'notice',text:end ? '사용자를 차단했습니다.' : '차단을 해제했습니다.'});
  }

  report(socket, visitor, number, now) {
    const message = Number.isSafeInteger(number) ? this.sql.exec('SELECT * FROM messages WHERE n=?',number).toArray()[0] : null;
    if (!message || message.author === visitor.n) return fail(socket,'report','다른 사용자의 최근 메시지를 선택해 주세요.');
    const duplicate = this.sql.exec('SELECT 1 FROM reports WHERE message=? AND reporter=?',number,visitor.n).toArray().length;
    if (!duplicate) {
      const today = this.sql.exec('SELECT count(*) AS count FROM reports WHERE reporter=? AND time>?',visitor.n,now-DAY).one().count;
      if (today >= 20) return fail(socket,'report','오늘의 신고 한도에 도달했습니다.');
      this.ctx.storage.transactionSync(() => {
        this.sql.exec('INSERT OR IGNORE INTO report_snapshots VALUES(?,?,?,?,?,?)',message.n, message.author, message.name, message.body, message.time, message.admin);
        this.sql.exec('INSERT INTO reports VALUES(?,?,?)',number,visitor.n,now);
      });
    }
    send(socket,{type:'notice',text:'신고를 접수했습니다.'});
  }

  post(socket, session, visitor, data, now) {
    const body = clean(data.body,360);
    if (!body) return;
    const policy = this.policy(now);
    if (policy.lockUntil) return fail(socket,'post','전체 채팅 입력이 잠겨 있습니다.');
    if (now - visitor.last_post < policy.slowSeconds * 1000 ||
        !this.takeLimit('post:' + (session.network || visitor.n), 45, 10000, now)) {
      return fail(socket,'post','잠시 후 다시 보내 주세요.');
    }
    if (Object.hasOwn(data,'station')) this.updateStation(socket,session,data.station,now);
    const station = session.station;
    const admin = session.expiresAt > now;
    this.sql.exec('UPDATE visitors SET last_post=?, seen=? WHERE n=?',now,now,visitor.n);
    const message = this.sql.exec('INSERT INTO messages(author,name,body,time,admin,station_name,country_code) VALUES(?,?,?,?,?,?,?) RETURNING *',
      visitor.n,admin ? ADMIN_NAME : publicName(visitor.nickname) || 'Ano'+visitor.n,body,now,admin ? 1 : 0,station?.name || null,station?.countrycode || null).one();
    this.pruneHistory(now);
    this.broadcast({type:'message',message:messageInfo(message)});
  }

  updateStation(socket, session, value, now) {
    const station = stationInfo(value);
    if (station?.name === session.station?.name && station?.countrycode === session.station?.countrycode) return;
    session.station = station;
    session.stationTime = now;
    socket.serializeAttachment(session);
    this.publishPresence(session.author);
  }

  async webSocketMessage(socket, raw) {
    if (typeof raw !== 'string' || raw.length > 2400) return socket.close(1008,'Invalid message');
    let data;
    try { data = JSON.parse(raw); } catch { return socket.close(1008,'Invalid message'); }
    if (!data || typeof data.type !== 'string') return socket.close(1008,'Invalid message');
    const session = socket.deserializeAttachment() || {};
    const now = Date.now();
    if (!session.author) {
      if (data.type !== 'join') return socket.close(1008,'Join first');
      return this.join(socket,session,data,now);
    }
    // Bound all traffic, including packets which fan out to the room.
    if (!(session.windowEnd > now)) {
      session.windowEnd = now + 10000;
      session.packets = 0;
    }
    if (++session.packets > 55) return socket.close(1008,'Too many requests');
    socket.serializeAttachment(session);
    const visitor = this.sql.exec('SELECT * FROM visitors WHERE n=?',session.author).toArray()[0];
    if (!visitor) return socket.close(1001,'Reconnect');
    if (data.type === 'adminLogout') return this.logout(socket,session,visitor,data.resumeToken);
    if (session.expiresAt && !this.savedSession(visitor.n,session.sessionHash,now)) this.clearAdmin(socket,session,visitor);
    if (data.type === 'adminResume') return this.resume(socket,session,data,visitor);
    if (currentUntil(visitor.banned_until,now)) return fail(socket,data.type === 'adminLogin' ? 'login' : data.type,'채팅이 차단된 상태입니다.');
    if (data.type === 'adminLogin') return this.login(socket,session,data,visitor,now);
    if (data.type.startsWith('admin')) {
      if (!(session.expiresAt > now)) return fail(socket,'admin','관리자 로그인이 필요합니다.');
      if (data.type === 'adminPolicy') return this.setPolicy(socket,data,now);
      if (data.type === 'adminReports') return send(socket,{type:'reports',items:this.reports()});
      if (data.type === 'adminBan') return this.setBan(socket,session,data,now);
      return;
    }
    switch (data.type) {
      case 'rename': {
        const nickname = clean(data.name,20);
        if (reserved(nickname) || session.expiresAt > now) return fail(socket,'rename','관리자 닉네임은 로그인해야 사용할 수 있습니다.');
        if (/^ano\d+$/i.test(nickname.normalize('NFKC'))) return fail(socket,'rename','Ano 번호는 자동으로 지정됩니다.');
        this.sql.exec('UPDATE visitors SET nickname=?,seen=? WHERE n=?',nickname,now,visitor.n);
        return send(socket,{type:'renamed',nickname});
      }
      case 'presence': return this.updateStation(socket,session,data.station,now);
      case 'report': return this.report(socket,visitor,data.n,now);
      case 'post': return this.post(socket,session,visitor,data,now);
    }
  }

  webSocketClose(socket,code) {
    const session = socket.deserializeAttachment();
    if (session?.station) this.publishPresence(session.author,socket);
    try { socket.close(code === 1000 ? 1000 : 1001); } catch {}
  }
  webSocketError(socket) {
    const session = socket.deserializeAttachment();
    if (session?.station) this.publishPresence(session.author,socket);
    try { socket.close(1011); } catch {}
  }
}
