import './chat.css';
import endpoint from '../electron/chat-endpoint.json';

interface ChatMessage { n: number; author: number; name: string; body: string; time: number }
const store = {
  get(key: string) { try { return localStorage.getItem('allradione.chat.' + key); } catch { return null; } },
  set(key: string, value: string) { try { localStorage.setItem('allradione.chat.' + key, value); } catch {} }
};
const glyph = (paths: string) => `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;
const bubble = glyph('<path d="M20.5 11a8.5 8.5 0 0 1-8.5 8.5 10 10 0 0 1-3.7-.7l-5 1.3 1.4-4.6A8.5 8.5 0 1 1 20.5 11Z"/><path d="M8 10h8m-8 3h5"/>');
const collapse = glyph('<path d="m6 10 6 6 6-6"/>');

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
      <header class="chat-head"><h2>전체 채팅</h2><button type="button" class="chat-identity" title="닉네임 변경" disabled></button></header>
      <form class="chat-name" hidden><label>닉네임<input name="name" maxlength="20" autocomplete="off"></label><button>저장</button></form>
      <div class="chat-messages" role="log" aria-label="메시지" aria-live="polite" aria-relevant="additions"></div>
      <p class="chat-status" role="status"></p>
      <form class="chat-compose"><input aria-label="채팅 메시지" placeholder="메시지" maxlength="360" autocomplete="off"><button type="submit" aria-label="보내기" disabled>${glyph('<path d="m5 12 7-7 7 7m-7-7v15"/>')}</button></form>
    </section>`;
  document.body.append(root);
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
  const muted = new Set((store.get('muted') || '').split(',').filter(Boolean).map(Number));
  let socket: WebSocket | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let attempts = 0, self = 0;
  let open = false, ready = false, pending = '';
  let messages: ChatMessage[] = [];
  const controls = () => { submit.disabled = !ready || !input.value.trim() || !!pending; identity.disabled = !ready; };
  const transmit = (value: unknown) => {
    if (socket?.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify(value));
    return true;
  };
  function row(message: ChatMessage) {
    const item = document.createElement('article');
    item.className = 'chat-line' + (message.author === self ? ' own' : '');
    const by = document.createElement('strong'), body = document.createElement('p');
    by.textContent = message.name; body.textContent = message.body;
    item.append(by, body);
    if (message.author !== self) {
      const details = document.createElement('details'), menu = document.createElement('summary');
      menu.textContent = '···'; menu.ariaLabel = message.name + ' 메시지 옵션';
      const hide = document.createElement('button'), report = document.createElement('button');
      hide.textContent = '사용자 숨기기'; report.textContent = '신고';
      hide.onclick = () => {
        muted.add(message.author);
        store.set('muted', Array.from(muted).slice(-300).join(','));
        paint();
      };
      report.onclick = () => { details.open = false; transmit({type:'report',n:message.n}); };
      details.append(menu, hide, report); item.append(details);
    }
    return item;
  }
  function paint() {
    list.replaceChildren(...messages.filter(m => !muted.has(m.author)).map(row));
  }
  function connect() {
    if (!open) return;
    const url = import.meta.env.DEV && import.meta.env.VITE_CHAT_URL || endpoint.url;
    if (!url) { status.textContent = '채팅 서버에 연결할 수 없습니다.'; return; }
    status.textContent = attempts ? '다시 연결 중…' : '연결 중…';
    const ws = new WebSocket(url);
    socket = ws;
    ws.onopen = () => { if (socket === ws) transmit({type:'join',token:store.get('token')}); };
    ws.onmessage = event => {
      if (socket !== ws) return;
      let packet;
      try { packet = JSON.parse(event.data); } catch { return; }
      if (packet.type === 'welcome') {
        store.set('token',packet.token); self = packet.author;
        identity.textContent = packet.nickname || 'Ano'+self;
        name.value = packet.nickname; name.placeholder = 'Ano'+self;
        messages = packet.history; paint(); list.scrollTop = list.scrollHeight;
        ready = true; attempts = 0; status.textContent = ''; controls();
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
        identity.textContent = packet.nickname || 'Ano'+self; name.value = packet.nickname;
        rename.hidden = true; identity.focus();
      } else if (packet.type === 'remove') {
        messages = messages.filter(m => m.n !== packet.n); paint();
      } else if (packet.type === 'error' || packet.type === 'notice') {
        status.textContent = packet.text;
        pending = ''; controls();
      }
    };
    ws.onclose = () => {
      if (socket !== ws) return;
      ready = false; pending = ''; controls();
      if (open) {
        status.textContent = '연결이 끊겼습니다. 다시 연결 중…';
        retry = setTimeout(connect, Math.min(30000, 1200 * 2 ** Math.min(attempts++, 5)));
      }
    };
  }
  function setOpen(value:boolean) {
    open = value; root.classList.toggle('open', value); panel.inert = !value;
    panel.setAttribute('aria-hidden', String(!value)); toggle.setAttribute('aria-expanded',String(value));
    toggle.title = toggle.ariaLabel = value ? '채팅 접기' : '채팅하기';
    if (value) { connect(); } else {
      clearTimeout(retry); const old = socket; socket = undefined; old?.close();
      pending = ''; ready = false; attempts = 0; rename.hidden = true; controls(); toggle.focus();
    }
  }
  toggle.onclick = () => setOpen(!open);
  input.oninput = controls;
  identity.onclick = () => { rename.hidden = !rename.hidden; if (!rename.hidden) { name.focus(); name.select(); } };
  rename.onsubmit = event => { event.preventDefault(); transmit({type:'rename',name:name.value}); };
  compose.onsubmit = event => {
    event.preventDefault();
    const body = input.value.trim();
    if (ready && body && !pending && transmit({type:'post', body})) {
      pending = body; status.textContent = ''; controls();
    }
  };
  root.addEventListener('keydown', event => {
    event.stopPropagation();
    if (event.key === 'Escape' && open) { event.preventDefault(); setOpen(false); }
  });
  window.addEventListener('pagehide', () => { clearTimeout(retry); open = false; socket?.close(); });
}
