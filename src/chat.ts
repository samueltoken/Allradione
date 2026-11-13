import './chat.css';
import endpoint from '../electron/chat-endpoint.json';
import { flagUrl } from './flags';
import { mountModeration, restrictionText, type ChatPolicy } from './chat-moderation';
import { t, onLanguageChange } from './i18n';
import { bindChatLabels } from './chat-labels';
import type { ChatAdminSession } from './types';

interface Listening { name: string; countrycode: string }
interface ChatMessage { n: number; author: number; name: string; body: string; time: number; station?: Listening | null; admin?: boolean }
const store = {
  get(key: string) { try { return localStorage.getItem('allradione.chat.' + key); } catch { return null; } },
  set(key: string, value: string) { try { localStorage.setItem('allradione.chat.' + key, value); } catch {} }
};
const glyph = (paths: string) => `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;
const bubble = glyph('<path d="M20.5 11a8.5 8.5 0 0 1-8.5 8.5 10 10 0 0 1-3.7-.7l-5 1.3 1.4-4.6A8.5 8.5 0 1 1 20.5 11Z"/><path d="M8 10h8m-8 3h5"/>');
const collapse = glyph('<path d="m6 10 6 6 6-6"/>');

function mountResize(root: HTMLElement, panel: HTMLElement) {
  for (const dimension of ['width','height'] as const) {
    const saved = Number(store.get(dimension));
    if (Number.isFinite(saved) && saved > 0) root.style.setProperty('--chat-'+dimension+'-want',saved+'px');
  }
  function resize(width?: number, height?: number) {
    const box = root.getBoundingClientRect();
    if (width !== undefined) root.style.setProperty('--chat-width-want',Math.min(box.right-10,Math.max(285,width))+'px');
    if (height !== undefined) root.style.setProperty('--chat-height-want',Math.min(box.bottom-58,Math.max(225,height))+'px');
  }
  function persist() {
    for (const dimension of ['width','height'] as const) {
      const value = root.style.getPropertyValue('--chat-'+dimension+'-want');
      if (value) store.set(dimension,String(parseFloat(value)));
    }
  }
  for (const handle of panel.querySelectorAll<HTMLElement>('[data-resize]')) {
    const horizontal = handle.dataset.resize !== 'top', vertical = handle.dataset.resize !== 'left';
    handle.onpointerdown = event => {
      if (event.button !== 0 || !event.isPrimary) return;
      event.preventDefault(); handle.setPointerCapture(event.pointerId);
      const rect = panel.getBoundingClientRect(), x = event.clientX, y = event.clientY;
      root.classList.add('resizing');
      handle.onpointermove = move => resize(horizontal ? rect.width + x - move.clientX : undefined,vertical ? rect.height + y - move.clientY : undefined);
    };
    handle.onlostpointercapture = () => { handle.onpointermove = null; root.classList.remove('resizing'); persist(); };
    handle.onkeydown = event => {
      const rect = panel.getBoundingClientRect();
      const dx = event.key === 'ArrowLeft' ? 16 : event.key === 'ArrowRight' ? -16 : 0;
      const dy = event.key === 'ArrowUp' ? 16 : event.key === 'ArrowDown' ? -16 : 0;
      if ((horizontal && dx) || (vertical && dy)) {
        event.preventDefault(); resize(horizontal && dx ? rect.width+dx : undefined,vertical && dy ? rect.height+dy : undefined); persist();
      }
    };
  }
}

export function mountChat() {
  const root = document.createElement('aside');
  root.className = 'global-chat';
  root.setAttribute('aria-label','전체 채팅');
  root.innerHTML = `
    <svg width="0" height="0" class="chat-optics" aria-hidden="true"><defs>
      <filter id="chat-glass-edge" x="-5%" y="-5%" width="110%" height="110%" color-interpolation-filters="sRGB">
        <feTurbulence type="fractalNoise" baseFrequency=".018 .032" numOctaves="2" seed="7" result="grain"/>
        <feDisplacementMap in="SourceGraphic" in2="grain" scale="9" xChannelSelector="R" yChannelSelector="G"/>
      </filter></defs></svg>
    <button class="chat-toggle" type="button" aria-label="채팅하기" title="채팅하기" aria-controls="chat-panel" aria-expanded="false">
      <span>${bubble}</span><span>${collapse}</span>
    </button>
    <section class="chat-panel" id="chat-panel" inert aria-hidden="true">
      <div class="chat-grip" data-resize="top" aria-hidden="true"></div><div class="chat-grip" data-resize="left" aria-hidden="true"></div>
      <button type="button" class="chat-grip" data-resize="corner" aria-label="채팅창 크기 조절" title="드래그 또는 방향키로 크기 조절"></button>
      <header class="chat-head"><h2>전체 채팅</h2><span class="chat-me"><span class="chat-station"></span><button type="button" class="chat-identity" title="닉네임 변경" disabled></button></span></header>
      <form class="chat-name" hidden><label><span>닉네임</span><input name="name" maxlength="20" autocomplete="off"></label><button>저장</button></form>
      <div class="chat-messages" role="log" aria-label="메시지" aria-live="polite" aria-relevant="additions"></div>
      <p class="chat-status" role="status"></p>
      <div class="chat-admin" hidden><strong>관리자</strong><button type="button" data-chat="settings">채팅 설정</button><button type="button" data-chat="reports">신고</button><button type="button" data-chat="logout">로그아웃</button></div>
      <p class="chat-restriction" role="status"></p>
      <form class="chat-compose"><input aria-label="채팅 메시지" placeholder="메시지" maxlength="360" autocomplete="off"><button type="submit" aria-label="보내기" disabled>${glyph('<path d="m5 12 7-7 7 7m-7-7v15"/>')}</button></form>
    </section>`;
  document.body.append(root);
  const labels = bindChatLabels(root);
  const find = <T extends HTMLElement>(selector:string) => root.querySelector<T>(selector)!;
  const toggle = find<HTMLButtonElement>('.chat-toggle');
  const panel = find<HTMLElement>('.chat-panel');
  const list = find<HTMLElement>('.chat-messages');
  const status = find<HTMLElement>('.chat-status');
  const identity = find<HTMLButtonElement>('.chat-identity');
  const rename = find<HTMLFormElement>('.chat-name');
  const name = find<HTMLInputElement>('.chat-name input');
  const compose = find<HTMLFormElement>('.chat-compose');
  const input = find<HTMLInputElement>('.chat-compose input');
  const submit = find<HTMLButtonElement>('.chat-compose button');
  const restriction = find<HTMLElement>('.chat-restriction');
  const ownStation = find<HTMLElement>('.chat-me .chat-station');
  mountResize(root,panel);
  const muted = new Set((store.get('muted') || '').split(',').filter(Boolean).map(Number));
  const online = new Map<number, Listening | null>();
  let listening:Listening | null = null;
  let policy:ChatPolicy = {slowSeconds:0,lockUntil:0}, bannedUntil = 0;
  let restrictionTimer:ReturnType<typeof setTimeout> | undefined;
  let socket: WebSocket | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let attempts = 0, self = 0;
  let open = false, joined = false, ready = false, pending = '';
  let messages: ChatMessage[] = [];
  function controls() {
    const reason = restrictionText(bannedUntil,policy);
    restriction.textContent = reason;
    input.disabled = !ready || !!reason;
    submit.disabled = input.disabled || !input.value.trim() || !!pending;
    identity.disabled = !ready;
  }
  function updateRestrictions() {
    clearTimeout(restrictionTimer); controls();
    const next = Math.min(...[policy.lockUntil,bannedUntil].filter(t => t > Date.now()));
    if (Number.isFinite(next)) restrictionTimer = setTimeout(updateRestrictions,Math.min(next-Date.now()+30,2147483647));
  }
  const transmit = (value: unknown) => {
    if (socket?.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify(value));
    return true;
  };
  let statusKey = '', nickname = '';
  function setStatus(key:string) { statusKey = key; status.textContent = t(key); }
  let savedSession:ChatAdminSession|null = null;
  const initialSession = window.allradione?.getChatAdminSession?.().then(value => {
    savedSession = value;
  }).catch(() => {});
  function rememberSession(value:ChatAdminSession|null) {
    if (savedSession === value) return;
    savedSession = value;
    void window.allradione?.setChatAdminSession?.(value).catch(() => {});
  }
  function logout(expired:boolean) {
    const resumeToken = savedSession?.resumeToken;
    rememberSession(null);
    transmit({type:'adminLogout',resumeToken});
    admin.setActive(false); displayIdentity(); paint();
    if (expired) setStatus('관리자 로그인 시간이 끝났습니다.');
    else identity.focus();
  }
  const admin = mountModeration(root,transmit,setStatus,logout);
  function displayIdentity() {
    identity.textContent = admin.active ? t('관리자') : nickname;
    identity.title = t(admin.active ? '채팅 설정' : '닉네임 변경');
  }
  function stationLabel(el: HTMLElement, station:Listening | null | undefined) {
    el.replaceChildren(); el.removeAttribute('title');
    if (!station) return;
    const url = flagUrl(station.countrycode);
    if (url) { const flag = document.createElement('img'); flag.className = 'country-flag'; flag.src = url; flag.alt = station.countrycode; el.append(flag); }
    const label = document.createElement('span');
    label.textContent = station.name; el.append(label);
    el.title = t('듣고 있는 방송') + ' · ' + station.name;
  }
  function updateStations(author:number) {
    for (const item of list.querySelectorAll<HTMLElement>('[data-author="'+author+'"] .chat-station')) stationLabel(item,online.get(author));
    if (author === self) stationLabel(ownStation,online.get(author));
  }
  function row(message: ChatMessage) {
    const item = document.createElement('article');
    item.className = 'chat-line' + (message.author === self ? ' own' : '');
    item.dataset.author = String(message.author);
    const header = document.createElement('div'), station = document.createElement('span');
    header.className = 'chat-by'; station.className = 'chat-station';
    const by = document.createElement('strong'), body = document.createElement('p');
    by.textContent = message.admin ? t('관리자') : message.name; body.textContent = message.body;
    if (message.admin) by.classList.add('verified-admin');
    if (admin.active && message.author !== self) {
      const author = document.createElement('button');
      author.type = 'button'; author.className = 'chat-author'; author.title = t('차단 관리')+' · '+message.name;
      author.append(by); author.onclick = () => admin.ban(message.author,by.textContent || message.name);
      header.append(author);
    } else header.append(by);
    stationLabel(station,online.get(message.author));
    header.append(station); item.append(header, body);
    if (message.author !== self) {
      const details = document.createElement('details'), menu = document.createElement('summary');
      menu.textContent = '···'; menu.ariaLabel = t('메시지 옵션')+' · '+by.textContent;
      const hide = document.createElement('button'), report = document.createElement('button');
      hide.textContent = t('사용자 숨기기'); report.textContent = t('신고');
      hide.onclick = () => {
        muted.add(message.author);
        store.set('muted', Array.from(muted).slice(-300).join(','));
        paint();
      };
      report.onclick = () => { details.open = false; transmit({type:'report',n:message.n}); };
      details.append(menu, hide, report); item.append(details);
      body.onclick = () => { details.open = !details.open; };
    }
    return item;
  }
  function paint() {
    list.replaceChildren(...messages.filter(m => !muted.has(m.author)).map(row));
  }
  function connect() {
    if (!open) return;
    const url = import.meta.env.DEV && import.meta.env.VITE_CHAT_URL || endpoint.url;
    if (!url) { setStatus('채팅 서버에 연결할 수 없습니다.'); return; }
    setStatus(attempts ? '다시 연결 중…' : '연결 중…');
    const ws = new WebSocket(url);
    socket = ws;
    let joiningStation:Listening|null = null;
    let resuming = false;
    ws.onopen = () => { if (socket === ws) { joiningStation = listening; transmit({type:'join',token:store.get('token'),station:listening}); } };
    ws.onmessage = async event => {
      if (socket !== ws) return;
      let packet;
      try { packet = JSON.parse(event.data); } catch { return; }
      if (packet.type === 'welcome') {
        joined = true;
        store.set('token',packet.token); self = packet.author;
        online.clear();
        for (const entry of packet.presence || []) online.set(entry.author,entry.station);
        online.set(self,listening); stationLabel(ownStation,listening);
        policy = packet.policy || {slowSeconds:0,lockUntil:0}; bannedUntil = packet.bannedUntil || 0;
        admin.setPolicy(policy);
        nickname = packet.nickname || 'Ano'+self; displayIdentity();
        name.value = packet.nickname; name.placeholder = 'Ano'+self;
        messages = packet.history; paint(); list.scrollTop = list.scrollHeight;
        attempts = 0;
        if (joiningStation !== listening) transmit({type:'presence',station:listening});
        await initialSession;
        if (socket !== ws || ws.readyState !== WebSocket.OPEN) return;
        if (savedSession && savedSession.expiresAt <= Date.now()) rememberSession(null);
        if (savedSession && packet.adminResume === true) {
          resuming = transmit({type:'adminResume',resumeToken:savedSession.resumeToken});
        }
        ready = !resuming; setStatus(''); updateRestrictions();
      } else if (packet.type === 'presence') {
        online.set(packet.author,packet.station); updateStations(packet.author);
      } else if (packet.type === 'adminSession') {
        const active = packet.active === true && Number.isSafeInteger(packet.expiresAt) && packet.expiresAt > Date.now();
        if (active && typeof packet.resumeToken === 'string' && /^[0-9a-f]{64}$/.test(packet.resumeToken)) {
          rememberSession({resumeToken:packet.resumeToken,expiresAt:packet.expiresAt});
        } else if (!active || !resuming) rememberSession(null);
        admin.setActive(active,packet.expiresAt);
        if (!active) nickname = packet.nickname || 'Ano'+self;
        displayIdentity(); name.value = active ? '' : packet.nickname || '';
        rename.hidden = true; ready = true; updateRestrictions(); paint();
        if (statusKey !== '관리자 로그인 시간이 끝났습니다.' || active) setStatus('');
        if (!resuming) identity.focus();
        resuming = false;
      } else if (packet.type === 'reports') {
        admin.receiveReports(packet.items);
      } else if (packet.type === 'policy') {
        policy = packet.policy; admin.setPolicy(policy); updateRestrictions();
      } else if (packet.type === 'ban') {
        bannedUntil = packet.until; updateRestrictions();
      } else if (packet.type === 'message') {
        const m:ChatMessage = packet.message;
        messages.push(m); if (messages.length > 80) messages.shift();
        const nearEnd = list.scrollHeight-list.clientHeight-list.scrollTop < 40;
        if (!muted.has(m.author)) list.append(row(m));
        while (list.childElementCount > 80) list.firstElementChild?.remove();
        if (nearEnd || m.author === self) list.scrollTop = list.scrollHeight;
        if (m.author === self && pending) {
          if (input.value.trim() === pending) input.value = '';
          pending = ''; controls();
        }
      } else if (packet.type === 'renamed') {
        nickname = packet.nickname || 'Ano'+self; displayIdentity(); name.value = packet.nickname;
        rename.hidden = true; identity.focus();
      } else if (packet.type === 'remove') {
        messages = messages.filter(m => m.n !== packet.n); paint();
      } else if (packet.type === 'error' || packet.type === 'notice') {
        if (resuming && packet.type === 'error' && ['admin','adminResume'].includes(packet.scope)) {
          resuming = false; ready = true; rememberSession(null);
        }
        admin.result(packet.scope,packet.text,packet.type === 'notice');
        if (packet.type === 'error' && (!packet.scope || packet.scope === 'post')) pending = '';
        controls();
      }
    };
    ws.onclose = () => {
      if (socket !== ws) return;
      socket = undefined; joined = ready = false; pending = ''; admin.setActive(false); displayIdentity(); controls();
      if (open) {
        setStatus('연결이 끊겼습니다. 다시 연결 중…');
        retry = setTimeout(connect, Math.min(30000, 1200 * 2 ** Math.min(attempts++, 5)));
      }
    };
  }
  function setOpen(value:boolean) {
    open = value; root.classList.toggle('open', value); panel.inert = !value;
    panel.setAttribute('aria-hidden', String(!value)); toggle.setAttribute('aria-expanded',String(value));
    toggle.title = toggle.ariaLabel = t(value ? '채팅 접기' : '채팅하기');
    if (value) { connect(); } else {
      clearTimeout(retry); const old = socket; socket = undefined; old?.close();
      admin.setActive(false); displayIdentity(); pending = ''; joined = ready = false; attempts = 0; rename.hidden = true;
      clearTimeout(restrictionTimer); controls(); toggle.focus();
    }
  }
  toggle.onclick = () => setOpen(!open);
  input.oninput = controls;
  identity.onclick = () => {
    if (admin.active) { find<HTMLButtonElement>('[data-chat="settings"]').focus(); return; }
    rename.hidden = !rename.hidden; if (!rename.hidden) { name.focus(); name.select(); }
  };
  rename.onsubmit = event => {
    event.preventDefault();
    const entered = name.value.trim().normalize('NFKC').toLowerCase();
    if (['관리자',t('관리자').toLowerCase()].includes(entered)) { rename.hidden = true; name.value = nickname; admin.login(); }
    else transmit({type:'rename',name:name.value});
  };
  compose.onsubmit = event => {
    event.preventDefault();
    const body = input.value.trim();
    if (ready && !input.disabled && body && !pending && transmit({type:'post', body, station:listening})) {
      pending = body; setStatus(''); controls();
    }
  };
  root.addEventListener('keydown', event => {
    event.stopPropagation();
    if (event.key === 'Escape' && open) { event.preventDefault(); setOpen(false); }
  });
  window.addEventListener('pagehide', () => { clearTimeout(retry); open = false; socket?.close(); });
  onLanguageChange(() => {
    labels(); admin.refresh(); displayIdentity(); setStatus(statusKey); controls(); paint();
    stationLabel(ownStation,listening); toggle.title = toggle.ariaLabel = t(open ? '채팅 접기' : '채팅하기');
  });
  return {
    listening(station:Listening|null) {
      if (station?.name === listening?.name && station?.countrycode === listening?.countrycode) return;
      listening = station ? {name:station.name,countrycode:station.countrycode} : null;
      if (joined) { online.set(self,listening); updateStations(self); transmit({type:'presence',station:listening}); }
    }
  };
}
