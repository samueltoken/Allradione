import { t, locale } from './i18n';
import { bindChatLabels } from './chat-labels';

export interface ChatPolicy { slowSeconds: number; lockUntil: number }
export interface ChatReport {
  n: number; author: number; name: string; body: string; time: number;
  reports: number; reportedAt: number; bannedUntil: number; admin?:boolean;
}

export function restrictionActive(until: number) {
  return until === -1 || until > Date.now();
}

function untilText(until: number) {
  if (until === -1) return t('기한 없음');
  return t('{time}까지').replace('{time}',new Date(until).toLocaleString(locale(), {month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'}));
}

export function restrictionText(until: number, policy: ChatPolicy) {
  if (restrictionActive(until)) return t('채팅 차단') + ' · ' + untilText(until);
  if (restrictionActive(policy.lockUntil)) return t('전체 채팅 입력 중지') + ' · ' + untilText(policy.lockUntil);
  return '';
}

export function mountModeration(root: HTMLElement, send: (packet: unknown) => boolean, setStatus: (text: string) => void) {
  const bar = root.querySelector<HTMLElement>('.chat-admin')!;
  const dialog = document.createElement('dialog');
  dialog.className = 'chat-dialog';
  dialog.setAttribute('aria-labelledby','chat-dialog-title');
  dialog.innerHTML = '<header><h2 id="chat-dialog-title"></h2><button type="button" aria-label="닫기">×</button></header><div class="chat-dialog-body"></div><p class="chat-dialog-status" role="status"></p>';
  root.append(dialog);
  const title = dialog.querySelector('h2')!;
  const content = dialog.querySelector<HTMLElement>('.chat-dialog-body')!;
  const feedback = dialog.querySelector<HTMLElement>('.chat-dialog-status')!;
  const labels = bindChatLabels(dialog);
  let viewLabels = () => {}, dynamicLabels = () => {}, titleKey = '', feedbackKey = '';
  function setFeedback(key: string) { feedbackKey = key; feedback.textContent = t(key); }
  let view = '', active = false, policy:ChatPolicy = {slowSeconds:0,lockUntil:0};
  let returnToReports = false;
  let expiry:ReturnType<typeof setTimeout> | undefined;
  function close() {
    if (dialog.open) dialog.close();
    content.replaceChildren(); view = ''; setFeedback(''); viewLabels = dynamicLabels = () => {};
  }
  function show(kind: string, heading: string, markup: string) {
    view = kind; titleKey = heading; title.textContent = t(heading); setFeedback('');
    content.innerHTML = markup;
    viewLabels = bindChatLabels(content); dynamicLabels = () => {};
    if (!dialog.open) dialog.showModal();
    (content.querySelector<HTMLElement>('input, select, button') || dialog.querySelector('button'))?.focus();
  }
  dialog.querySelector('header button')!.addEventListener('click', close);
  dialog.addEventListener('cancel',event => { event.preventDefault(); close(); });
  dialog.addEventListener('keydown',event => event.stopPropagation());
  function login() {
    show('login','관리자 로그인','<form class="chat-dialog-form"><label>아이디<input name="id" required maxlength="96" autocomplete="off" spellcheck="false"></label><label>비밀번호<input type="password" name="password" required maxlength="256" autocomplete="off"></label><button class="chat-primary" type="submit">로그인</button></form>');
    const form = content.querySelector('form')!;
    form.onsubmit = async event => {
      event.preventDefault();
      const id = form.elements.namedItem('id') as HTMLInputElement;
      const password = form.elements.namedItem('password') as HTMLInputElement;
      const submit = form.querySelector('button')!;
      if (submit.disabled) return;
      submit.disabled = true;
      setFeedback('확인 중…');
      const username = id.value;
      const encoder = new TextEncoder();
      const bytes = encoder.encode(password.value);
      password.value = '';
      try {
        const key = await crypto.subtle.importKey('raw',bytes,'PBKDF2',false,['deriveBits']);
        bytes.fill(0);
        const bits = new Uint8Array(await crypto.subtle.deriveBits({
          name:'PBKDF2',hash:'SHA-256',iterations:600000,salt:encoder.encode('Allradione admin login v1:'+username)
        }, key, 256));
        try {
          if (form.isConnected && dialog.open && !send({type:'adminLogin',id:username,proof:btoa(String.fromCharCode(...bits))})) throw new Error();
        } finally { bits.fill(0); }
      } catch {
        if (form.isConnected) { setFeedback('로그인을 완료할 수 없습니다.'); submit.disabled = false; }
      } finally { bytes.fill(0); }
    };
  }
  function setActive(value: boolean, expiresAt = 0) {
    clearTimeout(expiry); active = value; bar.hidden = !value;
    if (view) close();
    if (value && expiresAt > Date.now()) expiry = setTimeout(() => {
      setActive(false); send({type:'adminLogout'}); setStatus('관리자 로그인 시간이 끝났습니다.');
    }, expiresAt - Date.now());
  }
  function setPolicy(value: ChatPolicy) { policy = value; }
  function settings() {
    show('policy','채팅 설정','<form class="chat-dialog-form"><label>메시지 전송 간격 (초)<input name="slow" type="number" min="0" max="3600" step="1" required></label><label>전체 메시지 입력<select name="lock"><option value="keep">현재 설정 유지</option><option value="0">허용</option><option value="timed">일정 시간 중지</option><option value="-1">해제할 때까지 중지</option></select></label><label class="chat-minutes" hidden>중지 시간 (분)<input name="minutes" type="number" min="1" max="5256000" step="1" value="10"></label><button class="chat-primary" type="submit">적용</button></form>');
    const form = content.querySelector('form')!;
    const slow = form.elements.namedItem('slow') as HTMLInputElement;
    const lock = form.elements.namedItem('lock') as HTMLSelectElement;
    const minutes = form.elements.namedItem('minutes') as HTMLInputElement;
    slow.value = String(policy.slowSeconds);
    dynamicLabels = () => { lock.options[0].text = restrictionActive(policy.lockUntil) ? t('중지 중')+' · '+untilText(policy.lockUntil) : t('현재 입력 허용'); };
    dynamicLabels();
    const change = () => {
      minutes.disabled = lock.value !== 'timed'; minutes.required = !minutes.disabled;
      minutes.closest('label')!.hidden = minutes.disabled;
    };
    lock.onchange = change; change();
    form.onsubmit = event => {
      event.preventDefault();
      const lockMinutes = lock.value === 'keep' ? undefined : lock.value === 'timed' ? minutes.valueAsNumber : Number(lock.value);
      if (send({type:'adminPolicy', slowSeconds:slow.valueAsNumber,lockMinutes})) close();
    };
  }
  function reports() {
    show('reports','신고','<p class="chat-empty">불러오는 중…</p>');
    send({type:'adminReports'});
  }
  function ban(author: number, name: string, fromReports = false) {
    if (!active) return;
    returnToReports = fromReports;
    show('ban','사용자 차단','<form class="chat-dialog-form"><strong class="chat-target"></strong><label>차단 기간<select name="duration"><option value="timed">시간 지정</option><option value="-1">영구 차단</option><option value="0">차단 해제</option></select></label><label>차단 시간 (분)<input name="minutes" type="number" min="1" max="5256000" step="1" value="10" required></label><div class="chat-dialog-actions"><button type="button" class="chat-back">취소</button><button type="submit" class="chat-primary">차단</button></div></form>');
    const form = content.querySelector('form')!;
    form.querySelector('.chat-target')!.textContent = name;
    const duration = form.elements.namedItem('duration') as HTMLSelectElement;
    const minutes = form.elements.namedItem('minutes') as HTMLInputElement;
    const submit = form.querySelector<HTMLButtonElement>('[type="submit"]')!;
    dynamicLabels = () => { submit.textContent = t(duration.value === '0' ? '차단 해제' : '차단'); };
    duration.onchange = () => {
      minutes.disabled = duration.value !== 'timed'; minutes.closest('label')!.hidden = minutes.disabled;
      dynamicLabels();
    };
    form.querySelector<HTMLButtonElement>('.chat-back')!.onclick = fromReports ? reports : close;
    form.onsubmit = event => {
      event.preventDefault();
      const time = duration.value === 'timed' ? minutes.valueAsNumber : Number(duration.value);
      if (send({type:'adminBan',author,minutes:time})) submit.disabled = true;
    };
  }
  function receiveReports(items: ChatReport[]) {
    if (!active || view !== 'reports') return;
    dynamicLabels = () => receiveReports(items);
    content.replaceChildren();
    if (!items.length) { const empty = document.createElement('p'); empty.className = 'chat-empty'; empty.textContent = t('접수된 신고가 없습니다.'); content.append(empty); return; }
    for (const item of items) {
      const card = document.createElement('article');
      card.className = 'chat-report'; card.innerHTML = '<header><strong></strong><time></time></header><p></p><footer><span></span><button type="button"></button></footer>';
      card.querySelector('strong')!.textContent = item.admin ? t('관리자') : item.name;
      card.querySelector('time')!.textContent = new Date(item.time).toLocaleString(locale());
      card.querySelector('p')!.textContent = item.body;
      const blocked = restrictionActive(item.bannedUntil);
      card.querySelector('footer span')!.textContent = t('신고 {count}건').replace('{count}',String(item.reports)) + (blocked ? ' · '+t('차단 중')+' (' + untilText(item.bannedUntil) + ')' : '');
      const button = card.querySelector('button')!;
      button.textContent = t(blocked ? '차단 관리' : '사용자 차단'); button.onclick = () => ban(item.author,item.name,true);
      content.append(card);
    }
  }
  function result(scope: string | undefined, text: string, ok: boolean) {
    if (view === 'login' && scope === 'login') {
      setFeedback(text);
      content.querySelector('button')!.disabled = false; content.querySelector<HTMLInputElement>('[name="password"]')!.focus();
    } else if (view === 'ban' && (scope === 'admin' || (ok && content.querySelector<HTMLButtonElement>('[type="submit"]')?.disabled))) {
      if (ok) { if (returnToReports) reports(); else close(); setStatus(text); }
      else { setFeedback(text); content.querySelector<HTMLButtonElement>('[type="submit"]')!.disabled = false; }
    } else if (dialog.open && scope === 'admin') setFeedback(text);
    else setStatus(text);
  }
  bar.querySelector<HTMLButtonElement>('[data-chat="settings"]')!.onclick = settings;
  bar.querySelector<HTMLButtonElement>('[data-chat="reports"]')!.onclick = reports;
  bar.querySelector<HTMLButtonElement>('[data-chat="logout"]')!.onclick = () => send({type:'adminLogout'});
  function refresh() {
    labels(); title.textContent = t(titleKey); setFeedback(feedbackKey);
    viewLabels(); dynamicLabels();
  }
  return { login, setActive, setPolicy, ban, receiveReports, result, close, refresh, get active() { return active; } };
}
