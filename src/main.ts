import './style.css';
import { mountChat } from './chat';
import { bridge, desktop } from './bridge';
import { playbackHealthLabel, prioritizePlayable, recordPlaybackHealth } from './playback-health';
import { flagMarkup } from './flags';
import type { RadioGlobe } from './globe';
import type { RadioPlayer } from './audio';
import type { Country, OperatorKind, PlayerState, Preferences, Station, WidgetSize } from './types';

const app=document.querySelector<HTMLDivElement>('#app')!;
const widgetParam=new URLSearchParams(location.search).get('widget');
const widgetSize:WidgetSize=widgetParam==='medium'?'medium':'small';
const isWidget=!!widgetParam;
if(isWidget)document.documentElement.classList.add('widget-root');
const paths:Record<string,string>={
 info:'<circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-10v1"/>',
 globe:'<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a17 17 0 0 1 0 18 17 17 0 0 1 0-18"/>',
 heart:'<path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8Z"/>',
 history:'<path d="M3 11a9 9 0 1 1 2.6 7M3 4v7h7M12 7v5l3 2"/>',
 settings:'<path d="m9.2 3-.5 2a7 7 0 0 0-1.8 1l-2-.5-2 3.5 1.5 1.5a7 7 0 0 0 0 2l-1.5 1.5 2 3.5 2-.5a7 7 0 0 0 1.8 1l.5 2h4l.5-2a7 7 0 0 0 1.8-1l2 .5 2-3.5-1.5-1.5a7 7 0 0 0 0-2L20 9l-2-3.5-2 .5a7 7 0 0 0-1.8-1l-.5-2Z"/><circle cx="11.2" cy="11.5" r="3"/>',
 search:'<circle cx="10.7" cy="10.7" r="6.7"/><path d="m16 16 5 5"/>',
 arrow:'<path d="M5 12h14m-6-6 6 6-6 6"/>',
 back:'<path d="M19 12H5m6-6-6 6 6 6"/>',
 external:'<path d="M14 3h7v7m0-7L10 14M10 3H4a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h16a1 1 0 0 0 1-1v-6"/>',
 play:'<path d="m8 5 11 7-11 7Z"/>',pause:'<path d="M8 5v14M16 5v14"/>',
 prev:'<path d="M5 5v14m13-14L7 12l11 7Z"/>',next:'<path d="M19 5v14M6 5l11 7-11 7Z"/>',
 volume:'<path d="m11 5-6 4H2v6h3l6 4V5m4 3a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14"/>',
 x:'<path d="m6 6 12 12M6 18 18 6"/>',plus:'<path d="M12 5v14M5 12h14"/>',minus:'<path d="M5 12h14"/>',
 reset:'<path d="M3 10a9 9 0 1 1 2 8M3 3v7h7"/>',
 refresh:'<path d="M21 10a9 9 0 1 0-2 8M21 3v7h-7"/>',
 widget:'<rect x="3" y="4" width="18" height="16" rx="2"/><rect x="12" y="12" width="7" height="6" rx="1"/>',
 expand:'<path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5"/>',
 radio:'<circle cx="12" cy="12" r="2"/><path d="M7 7a7 7 0 0 0 0 10M17 7a7 7 0 0 1 0 10M4 4a11 11 0 0 0 0 16M20 4a11 11 0 0 1 0 16"/>',
 check:'<path d="m5 12 4 4L19 6"/>',clock:'<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'
};
const icon=(name:string,size=20)=>`<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name]||paths.radio}</svg>`;
const safeNotices=new Set([
 '아직 공개된 릴리즈가 없어.','안정 버전 릴리즈를 찾지 못했어.','최신 버전이야.',
 '새 버전을 사용할 수 있어.','릴리즈 페이지에서 새 버전을 확인할 수 있어.',
 '업데이트를 다운로드하고 있어.','업데이트가 없어.',
 '릴리즈 페이지를 열었어. 새 무설치 파일을 내려받아 실행해줘.',
 '검증 완료. 새 버전으로 다시 시작할게.',
 '릴리즈 페이지를 열었어. 새 설치 파일을 내려받아 실행해줘.',
 '설치 파일 검증 완료. 업데이트 후 다시 시작할게.',
 '업데이트 파일을 준비 중이야. 잠시 후 다시 확인해줘.',
 '아직 새 릴리즈가 없어.','릴리즈 페이지에서 새 버전을 다운로드해줘.'
]);
function userMessage(value:unknown,fallback:string):string{
 const text=typeof value==='string'?value:value instanceof Error?value.message:'';
 if(safeNotices.has(text))return text;
 if(/체크섬|무결성|정상적인 Windows 실행/.test(text))return '업데이트 파일을 검증하지 못했어. 다시 다운로드해줘.';
 if(/파일이 너무 커|파일 크기가 허용/.test(text))return '업데이트 파일을 확인하지 못했어. 릴리즈 페이지를 확인해줘.';
 if(/현재 무설치 실행 파일/.test(text))return '현재 실행 파일을 찾지 못했어. 새 버전을 직접 다운로드해줘.';
 if(/EACCES|EPERM|권한이 없/.test(text))return '파일을 저장할 수 없어. 앱 폴더의 쓰기 권한을 확인해줘.';
 if(/데스크톱 앱에서/.test(text))return '위젯은 Windows 데스크톱 앱에서 사용할 수 있어.';
 return fallback;
}
const esc=(value:unknown)=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
const regionName=(code:string)=>{try{return new Intl.DisplayNames(['ko'],{type:'region'}).of(code)||code;}catch{return code;}};
const englishName=(code:string)=>{try{return new Intl.DisplayNames(['en'],{type:'region'}).of(code)||code;}catch{return code;}};
const countryName=(code:string)=>countries.find(c=>c.code===code)?.name||regionName(code);
let preferences:Preferences={volume:.65,favorites:[],recent:[],widgetEnabled:false,widgetSize:'small',lastCountry:'',reducedMotion:false};
let countries:Country[]=[];
let stations:Station[]=[];
let country='';
let view:'explore'|'country'|'favorites'|'recent'='explore';
let query='';
let genre='';
const operatorLabels: Record<OperatorKind,string> = { broadcaster: '공식 방송사', independent: '개인·독립 방송', unknown: '운영자 미확인' };
const countryOperators = ['broadcaster', 'independent', 'unknown', ''] as const;
let operator: OperatorKind | '' = '';
const kindOf = (station: Station): OperatorKind => station.operatorKind ?? 'unknown';
const codecOf = (station: Station): string => /^unknown$/i.test(station.codec) ? '' : station.codec;
let loadState:'loading'|'ready'|'error'='loading';
let loadError='';
let countryLoadError='';
let countryLoading=true;
let loadGeneration=0;
let globe:RadioGlobe|undefined;
let player:RadioPlayer;
let current:PlayerState={station:null,playing:false,status:'idle',volume:.65};
let lastRecent='';
let toastTimer:ReturnType<typeof setTimeout>|undefined;
let version='—';
let nativeVisible=true;
let settingsOpen=false;
let countryDialogOpen=false;
let detailOpener: HTMLButtonElement | undefined;
let streamButtonBusy=false;
let previousPaintKey='';
let timer:ReturnType<typeof setTimeout>|undefined;
let dialPreviewing=false;
let cleanDial:()=>void=()=>{};
let updateMode:'installer'|'portable'|'development'|undefined;

const btn=(name:string,label:string,cls='',attrs='')=>`<button class="icon-button ${cls}" title="${esc(label)}" aria-label="${esc(label)}" ${attrs}>${icon(name)}</button>`;
const liveDot='<span class="live-beacon" aria-hidden="true"><i></i><i></i><b></b></span>';
const liveMeter='<span class="live-meter" aria-hidden="true"><i></i><i></i><i></i><i></i></span>';
const wave=(count=25,cls='')=>`<span class="waveform ${cls}" aria-hidden="true">${Array.from({length:count},(_,i)=>`<i style="--i:${i};--bar:3px"></i>`).join('')}</span>`;
function toast(message:string){let el=document.querySelector<HTMLDivElement>('#toast');if(!el){el=document.createElement('div');el.id='toast';el.setAttribute('role','status');document.body.append(el);}el.textContent=message;el.classList.add('visible');clearTimeout(toastTimer);toastTimer=setTimeout(()=>el?.classList.remove('visible'),4500);}
async function save(patch:Partial<Preferences>){preferences={...preferences,...patch};try{await bridge.savePreferences(patch);}catch{toast('설정을 저장하지 못했어.');}}
function favorite(station:Station|null){if(!station)return;const exists=preferences.favorites.some(s=>s.stationuuid===station.stationuuid);void save({favorites:exists?preferences.favorites.filter(s=>s.stationuuid!==station.stationuuid):[station,...preferences.favorites]});if(view==='favorites')renderList();updatePlayerUI();paintFavorites();}
function isFavorite(id:string){return preferences.favorites.some(s=>s.stationuuid===id);}
function collection(){return view==='favorites'?preferences.favorites:view==='recent'?preferences.recent:stations;}
function filtered() {
 const term = query.trim().toLowerCase();
 const matches = collection().filter(station =>
   (!operator || kindOf(station) === operator) &&
   (!term || `${station.name} ${station.operatorName || ''} ${station.tags} ${station.language}`.toLowerCase().includes(term)) &&
   (!genre || station.tags.toLowerCase().split(',').some(tag => tag.trim() === genre))
 );
 return view === 'country' ? prioritizePlayable(matches) : matches;
}
function statusLabel() {
 return ({ idle: '', connecting: '연결 중', playing: '재생 중', paused: '일시 정지', error: '연결 실패', offair: '방송 시간 외' } as const)[current.status];
}
function step(direction:number) {
 const items = view === 'explore' ? preferences.recent : filtered();
 if (!items.length) return;
 const index = items.findIndex(s => s.stationuuid === current.station?.stationuuid);
 const next = index < 0 ? (direction > 0 ? 0 : items.length - 1) : (index + direction + items.length) % items.length;
 void tune(items[next]);
}
async function tune(station:Station){try{await player.play(station);}catch(error){toast(userMessage(error,'방송에 연결할 수 없어. 잠시 후 다시 시도해줘.'));}}
async function toggle(){if(!current.station){const first=(view==='explore'?preferences.recent:filtered())[0];if(first)await tune(first);return;}if(streamButtonBusy)return;streamButtonBusy=true;try{await player.toggle();}finally{streamButtonBusy=false;}}

function render(){
 cleanDial();dialPreviewing=false;
 globe?.destroy();globe=undefined;
 app.innerHTML=`<div class="desktop-shell">
 <aside class="rail"><button class="brand-mark" data-action="explore" aria-label="Allradione 홈">${icon('radio',28)}</button><div class="rail-main">${btn('globe','세계 탐색',view==='explore'||view==='country'?'active':'','data-action="explore"')}${btn('heart','즐겨찾기',view==='favorites'?'active':'','data-action="favorites"')}${btn('history','최근 청취',view==='recent'?'active':'','data-action="recent"')}</div><div class="rail-bottom">${btn('settings','설정','','data-action="settings"')}</div></aside>
 <div class="workspace"><header class="topbar"><button class="wordmark" data-action="explore">Allradione<span class="wordmark-dot"></span></button><div class="topbar-right">${desktop?`<div class="window-controls">${btn('minus','최소화','','data-action="minimize"')}${btn('expand','창 크기 전환','','data-action="maximize"')}${btn('x','창 닫기','','data-action="close"')}</div>`:''}</div></header>
 <main id="main-content">${view==='explore'?exploreHTML():radioHTML()}</main>
 ${playerHTML()}
 </div></div><div id="modal-root"></div>`;
 if(view==='explore'){
   const container=document.querySelector<HTMLElement>('#globe')!;
   void import('./globe').then(({RadioGlobe})=>{
     if(!container.isConnected)return;
     globe=new RadioGlobe(container,code=>{void selectCountry(code);});
     globe.setCountries(countries);globe.setReducedMotion(preferences.reducedMotion);globe.setActive(nativeVisible&&!document.hidden);
     if(country)globe.selectCountry(country);
   }).catch(()=>{if(container.isConnected)container.innerHTML='<div class="globe-unavailable">지구본을 불러올 수 없습니다.</div>';});
   renderCountryStrip();
 }else{renderList();bindDial();}
 updatePlayerUI();
}
function exploreHTML() {
 return `<section class="explore">
  <div class="explore-copy"><h1>세계<br><span>라디오</span></h1>
   <button class="country-picker" data-action="countries">${icon('search',18)}<span>국가 찾기</span><kbd>/</kbd></button>
  </div>
  <div class="globe-stage"><div class="globe-orbit orbit-one"></div><div class="globe-orbit orbit-two"></div><div id="globe"></div>
   <div class="globe-bottom-note"><div class="globe-tools">${btn('minus','지구본 축소','','data-action="zoom-out"')}${btn('plus','지구본 확대','','data-action="zoom-in"')}${btn('reset','지구본 초기화','','data-action="globe-reset"')}</div></div>
  </div></section>
  <section class="destinations"><div class="section-kicker"><button class="text-button" data-action="countries">모든 국가 ${icon('arrow',16)}</button></div><div class="country-strip" id="country-strip"></div></section>`;
}
function renderCountryStrip(){const strip=document.querySelector('#country-strip');if(!strip)return;const codes=['KR','JP','US','GB','FR','DE'];if(countryLoading){strip.innerHTML=Array.from({length:6},()=>'<div class="destination skeleton"><span></span><span></span></div>').join('');return;}if(countryLoadError){strip.innerHTML=`<div class="strip-error"><span>${esc(countryLoadError)}</span><button class="text-button" data-action="reload-countries">${icon('reset',16)} 다시 연결</button></div>`;return;}const chosen=codes.map(code=>countries.find(c=>c.code===code)).filter((c):c is Country=>!!c);strip.innerHTML=chosen.map(c=>`<button class="destination" data-country="${c.code}"><span class="destination-top"><span class="country-code">${flagMarkup(c.code)}<b>${c.code}</b></span></span><span class="destination-name">${esc(c.name)} ${icon('arrow',16)}</span></button>`).join('');}
function radioHTML() {
 const title = view === 'favorites' ? '즐겨찾기' : view === 'recent' ? '최근 청취' : countryName(country);
 const operatorTabs = countryOperators.map(kind =>
  `<button type="button" role="tab" id="operator-${kind || 'all'}" aria-controls="station-list" aria-selected="false" tabindex="-1" data-operator="${kind}">${kind ? operatorLabels[kind] : '전체'} <span class="operator-count"></span></button>`
 ).join('');
 return `<section class="radio-page">
  <div class="radio-page-heading"><div><button class="back-link" data-action="explore">${icon('back',16)} 세계 라디오</button>
   <div class="country-title"><h1>${esc(title)}</h1>${view==='country'?`<span class="country-stamp">${flagMarkup(country)}</span>`:''}</div></div>
   <button class="outline-button" data-action="countries">${icon('globe',16)} 국가 찾기</button>
  </div>
  <div class="radio-layout">
   <section class="receiver" aria-label="라디오 수신기">
    <div class="dial-slot"><div class="dial" id="dial" role="slider" tabindex="0" aria-label="방송 채널 다이얼" aria-valuemin="1" aria-valuemax="1" aria-valuenow="1">
     ${wideDialScale()}
     <svg viewBox="0 0 440 440" class="dial-scale" aria-hidden="true">${dialTicks()}</svg><div class="dial-rings"></div><div class="dial-needle" id="dial-needle"><span></span></div>
     <div class="dial-center"><span class="dial-mode" data-dial-mode></span><div class="dial-number" data-dial-number></div><div class="dial-live-indicator">${liveDot}${liveMeter}</div><span class="dial-preview-name" data-dial-preview></span></div>
    </div></div>
    <div class="station-identity">
     <div class="wide-channel" aria-hidden="true"><span data-wide-number>—</span><small data-wide-count></small></div>
     <div class="station-overline"><span class="station-country"><span data-station-flag></span><span data-station-country></span></span><span class="codec-pill" data-codec></span></div>
     <div class="station-title-line"><h2 data-station-name></h2><div class="wide-preview" data-wide-preview aria-hidden="true"></div><button class="icon-button station-info" data-current-info aria-label="현재 방송 정보" title="방송 정보" aria-haspopup="dialog" hidden>${icon('info',16)}</button></div><div class="station-description" data-station-meta></div><div class="receiver-error" data-play-error role="status"></div>
    </div>
    <div class="receiver-wave">${wave(47,'receiver-levels')}<span class="wave-center"></span></div>
    <div class="channel-strip" aria-label="채널 위치"><span class="channel-label">CH.</span><div class="channel-track">${Array.from({length:35},(_,i)=>`<i class="${i%5===0?'major':''}">${i%5===0?`<span>${String(i+1).padStart(2,'0')}</span>`:''}</i>`).join('')}<b id="channel-pointer"></b></div></div>
   </section>
   <section class="station-panel" aria-label="방송 목록">
    <div class="station-panel-top"><span>방송 목록 <b id="list-count">0</b></span>
     ${view === 'country' ? '' : `<select id="operator-filter" aria-label="방송 운영 주체"><option value="">전체 방송</option>${Object.entries(operatorLabels).map(([key,label])=>`<option value="${key}" ${operator===key?'selected':''}>${label}</option>`).join('')}</select>`}
    </div>
    ${view === 'country' ? `<div class="operator-tabs" role="tablist" aria-label="방송 운영 주체">${operatorTabs}</div>` : ''}
    <label class="search-field">${icon('search',18)}<input id="station-search" type="search" aria-label="방송국, 장르 검색" placeholder="방송국, 장르 검색" value="${esc(query)}" autocomplete="off"><kbd>/</kbd></label>
    <div class="genre-filters" id="genre-filters"></div><div class="station-list" id="station-list" ${view === 'country' ? 'role="tabpanel" tabindex="0"' : ''}></div>
   </section>
  </div></section>`;
}
const wideDialStart = -144;
const wideDialEnd = -36;
function wideDialScale() {
 const point = (angle:number, radius:number) => {
  const radians = angle * Math.PI / 180;
  return [220 + Math.sin(radians) * radius, 220 - Math.cos(radians) * radius].map(n => n.toFixed(2));
 };
 const arc = (r:number) => `M ${point(wideDialStart,r)} A ${r} ${r} 0 0 1 ${point(wideDialEnd,r)}`;
 const ticks = Array.from({ length:73 }, (_,i) => {
  const angle = wideDialStart + i / 72 * (wideDialEnd - wideDialStart);
  const major = i % 9 === 0;
  const [x1,y1] = point(angle,major ? 150 : 157);
  const [x2,y2] = point(angle,163);
  return `<line class="${major ? 'major' : ''}" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/>`;
 }).join('');
 return `<svg class="receiver-arc" viewBox="0 0 440 440" aria-hidden="true" focusable="false">
  <path class="arc-guide" d="${arc(195)}"/><path class="arc-band" d="${arc(178)}"/>
  <path class="arc-progress" pathLength="1" d="${arc(178)}"/><g class="arc-ticks">${ticks}</g>
  <g class="arc-pointer"><path d="M220 21v48"/><circle cx="220" cy="21" r="2.2"/></g>
 </svg>`;
}
function dialTicks(){let svg='';for(let i=0;i<65;i++){const angle=(-135+i*270/64)*Math.PI/180;const major=i%8===0;const r1=major?169:178;const r2=188;const x1=220+Math.sin(angle)*r1,y1=220-Math.cos(angle)*r1,x2=220+Math.sin(angle)*r2,y2=220-Math.cos(angle)*r2;svg+=`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${major?'#d5d1ba':'#5f5d52'}" stroke-width="${major?'2':'1'}"/>`;if(major){const x=220+Math.sin(angle)*148,y=220-Math.cos(angle)*148;svg+=`<text x="${x}" y="${y}" text-anchor="middle" dominant-baseline="middle">${String(i/8+1).padStart(2,'0')}</text>`;}}return svg;}
function playerHTML(){return `<footer class="playerbar"><div class="now-playing"><span class="player-art">${icon('radio',23)}</span><div><span class="now-playing-name" data-footer-name>Allradione</span><span class="now-playing-sub"><span data-footer-flag></span><span data-footer-meta></span></span></div>${btn('heart','현재 방송 즐겨찾기','footer-heart','data-action="favorite-current"')}</div><div class="transport"><div class="transport-buttons">${btn('prev','이전 방송','','data-action="previous"')}<button class="play-button" data-action="toggle" aria-label="재생">${icon('play',23)}</button>${btn('next','다음 방송','','data-action="next"')}</div><span class="transport-status" data-status role="status"></span></div><div class="player-right">${wave(15,'mini-wave')}${icon('volume',18)}<input class="volume" id="volume" type="range" min="0" max="100" value="${Math.round(preferences.volume*100)}" aria-label="볼륨">${btn('widget','위젯 모드',preferences.widgetEnabled?'active':'','data-action="widget"')}</div></footer>`;}
const stationPageSize = 100;
function stationRows(items:Station[], start:number) {
 return items.map((s,i) => {
  const kind = kindOf(s);
  const location = view === 'country' ? '' : regionName(s.countrycode);
  const details = [playbackHealthLabel(s), s.operatorName ? operatorLabels[kind] : '', s.isPodcast ? '팟캐스트' : '', location, s.tags?.split(',').slice(0,2).join(' · ') || s.language].filter(Boolean).join(' · ');
  return `<div class="station-row ${s.stationuuid===current.station?.stationuuid?'selected':''}" data-station-row="${esc(s.stationuuid)}">
   <button class="station-select" data-station="${esc(s.stationuuid)}"><span class="station-index">${String(start+i+1).padStart(2,'0')}</span>
    <span class="station-row-main"><span class="station-row-name" title="${esc(s.name)}">${esc(s.name)}</span>
     <span class="station-row-sub">${flagMarkup(s.countrycode)}<span class="operator-name">${esc(s.operatorName || operatorLabels[kind])}</span>${details?' · '+esc(details):''}</span>
    </span><span class="station-bitrate">${s.bitrate?s.bitrate+'<small>KBPS</small>':esc(codecOf(s))}</span>
   </button>
   <button type="button" class="icon-button station-info" data-info="${esc(s.stationuuid)}" aria-label="${esc(s.name)} 방송 정보" title="방송 정보" aria-haspopup="dialog">${icon('info',16)}</button>
   <button class="icon-button station-heart ${isFavorite(s.stationuuid)?'is-favorite':''}" aria-label="${esc(s.name)} 즐겨찾기" aria-pressed="${isFavorite(s.stationuuid)}" data-favorite="${esc(s.stationuuid)}">${icon('heart',17)}</button>
  </div>`;
 }).join('');
}
function appendStationPage(list:HTMLElement, items:Station[], start:number) {
 const end = Math.min(start + stationPageSize, items.length);
 const more = end < items.length ? `<button class="outline-button station-more" data-more="${end}">방송 더 보기</button>` : '';
 list.insertAdjacentHTML('beforeend',stationRows(items.slice(start,end),start)+more);
}
function renderList() {
 const list = document.querySelector<HTMLDivElement>('#station-list');
 if (!list) return;
 if (view === 'country') {
  const counts = { broadcaster: 0, independent: 0, unknown: 0, '': stations.length };
  for (const station of stations) counts[kindOf(station)]++;
  for (const tab of document.querySelectorAll<HTMLButtonElement>('[data-operator]')) {
   const kind = tab.dataset.operator as typeof countryOperators[number];
   tab.querySelector('.operator-count')!.textContent = loadState === 'ready' ? counts[kind].toLocaleString() : '';
   tab.setAttribute('aria-selected',String(kind === operator));
   tab.tabIndex = kind === operator ? 0 : -1;
   tab.disabled = loadState !== 'ready';
  }
  list.setAttribute('aria-labelledby','operator-'+(operator || 'all'));
 }
 const items = filtered();
 const count = document.querySelector('#list-count');
 if (count) count.textContent = items.length.toLocaleString();
 if (view === 'country' && loadState === 'loading') {
  list.innerHTML = Array.from({length:7},()=>'<div class="station-skeleton skeleton"><i></i><span></span></div>').join('');
 } else if (view === 'country' && loadState === 'error') {
  list.innerHTML = `<div class="empty-state">${icon('radio',32)}<p>${esc(loadError)}</p><button class="outline-button" data-action="retry-country">다시 시도 ${icon('reset',15)}</button></div>`;
 } else if (!items.length) {
  const message = query || genre ? '검색 결과가 없습니다.' : operator ? '이 분류에 등록된 방송이 없습니다.' : view === 'favorites' ? '즐겨찾기가 비어 있습니다.' : view === 'recent' ? '최근 청취한 방송이 없습니다.' : '등록된 방송이 없습니다.';
  list.innerHTML = `<div class="empty-state">${icon(view==='favorites'?'heart':'radio',34)}<h3>${message}</h3></div>`;
 } else {
  list.replaceChildren();
  appendStationPage(list,items,0);
 }
 list.scrollTop = 0;
 renderGenres();
 updatePlayerUI();
}
function renderGenres(){const filters=document.querySelector('#genre-filters');if(!filters)return;const counts=new Map<string,number>();for(const s of collection()){for(const tag of (s.tags||'').toLowerCase().split(',').map(t=>t.trim()).filter(Boolean))counts.set(tag,(counts.get(tag)||0)+1);}const genres=[...counts].sort((a,b)=>b[1]-a[1]).slice(0,5).map(([tag])=>tag);if(!genres.length){filters.replaceChildren();return;}filters.innerHTML=`<button class="genre-chip ${!genre?'selected':''}" data-genre="">전체</button>${genres.map(g=>`<button class="genre-chip ${g===genre?'selected':''}" data-genre="${esc(g)}">${esc(g)}</button>`).join('')}`;}
function bindDial(){
 const dial=document.querySelector<HTMLElement>('#dial');
 if(!dial)return;
 let pointerId:number|null=null;
 let pointerAngle=0;
 let rotation=0;
 let downX=0,downY=0,moved=false;
 let pending:Station[]=[];
 let pendingIndex=0;
 let settle:ReturnType<typeof setTimeout>|undefined;
 const clamp=(n:number,min:number,max:number)=>Math.max(min,Math.min(max,n));
 const angleFor=(index:number,count:number)=>count<=1?0:-135+index/(count-1)*270;
 const angleAt=(event:PointerEvent)=>{const rect=dial.getBoundingClientRect();return Math.atan2(event.clientX-rect.left-rect.width/2,-(event.clientY-rect.top-rect.height/2))*180/Math.PI;};
 const wideMode = () => dial.querySelector('.receiver-arc')!.getClientRects().length > 0;
 const cancel=()=>{clearTimeout(settle);settle=undefined;dialPreviewing=false;dial.classList.remove('dragging','previewing');const preview=dial.querySelector<HTMLElement>('[data-dial-preview]');if(preview)preview.textContent='';};
 const prepare=()=>{
  if(dialPreviewing)return pending.length>0;
  pending=filtered();if(!pending.length)return false;
  const selected=pending.findIndex(s=>s.stationuuid===current.station?.stationuuid);
  pendingIndex=selected<0?Math.round((pending.length-1)/2):selected;
  rotation=selected<0?0:angleFor(pendingIndex,pending.length);return true;
 };
 const paint=()=>{
  dialPreviewing=true;dial.classList.add('previewing');
  pendingIndex=clamp(Math.round((rotation+135)/270*Math.max(0,pending.length-1)),0,pending.length-1);
  const needle=dial.querySelector<HTMLElement>('#dial-needle');if(needle)needle.style.transform=`rotate(${rotation}deg)`;
  const number=dial.querySelector('[data-dial-number]');if(number)number.textContent=String(pendingIndex+1).padStart(2,'0');
  const mode=dial.querySelector('[data-dial-mode]');if(mode)mode.textContent=`CHANNEL / ${pending.length}`;
  const preview=dial.querySelector('[data-dial-preview]');if(preview)preview.textContent=pending[pendingIndex]?.name||'';
  dial.setAttribute('aria-valuenow',String(pendingIndex+1));dial.setAttribute('aria-valuemax',String(pending.length));
  dial.setAttribute('aria-valuetext',pending[pendingIndex]?.name||'');
  const pointer=document.querySelector<HTMLElement>('#channel-pointer');if(pointer)pointer.style.left=`${(rotation+135)/270*100}%`;
  updateWideDial(dial, (rotation+135)/270, pendingIndex, pending.length, pending[pendingIndex]?.name);
 };
 const commit=()=>{
  const selected=pending[pendingIndex];cancel();
  if(!dial.isConnected)return;
  if(selected&&(selected.stationuuid!==current.station?.stationuuid||!current.playing))void tune(selected);
  else updatePlayerUI();
 };
 const queue=()=>{clearTimeout(settle);settle=setTimeout(commit,240);};
 dial.addEventListener('pointerdown',event=>{
  if(event.button!==0||pointerId!==null||!prepare())return;
  clearTimeout(settle);event.preventDefault();dial.focus({preventScroll:true});
  pointerId=event.pointerId;pointerAngle=angleAt(event);downX=event.clientX;downY=event.clientY;moved=false;
  dial.setPointerCapture(event.pointerId);dial.classList.add('dragging');paint();
 });
 dial.addEventListener('pointermove',event=>{
  if(event.pointerId!==pointerId)return;
  const nextAngle=angleAt(event);let delta=nextAngle-pointerAngle;
  if(delta>180)delta-=360;if(delta<-180)delta+=360;
  pointerAngle=nextAngle;rotation=clamp(rotation+delta*(wideMode()?270/(wideDialEnd-wideDialStart):1),-135,135);
  moved=moved||Math.hypot(event.clientX-downX,event.clientY-downY)>3;paint();
 });
 dial.addEventListener('pointerup',event=>{
  if(event.pointerId!==pointerId)return;
  if(!moved){
   const angle=angleAt(event);
   rotation=clamp(wideMode()?(angle-wideDialStart)/(wideDialEnd-wideDialStart)*270-135:angle,-135,135);
   paint();
  }
  const captured=pointerId;pointerId=null;
  if(captured!==null&&dial.hasPointerCapture(captured))dial.releasePointerCapture(captured);
  commit();
 });
 dial.addEventListener('pointercancel',event=>{if(event.pointerId===pointerId){pointerId=null;cancel();updatePlayerUI();}});
 dial.addEventListener('lostpointercapture',()=>{if(pointerId!==null){pointerId=null;cancel();updatePlayerUI();}});
 dial.addEventListener('wheel',event=>{
  if(pointerId!==null||!prepare()||event.deltaY===0)return;
  event.preventDefault();const step=Math.max(1,Math.min(10,Math.round(Math.abs(event.deltaY)/70)));
  pendingIndex=clamp(pendingIndex+(event.deltaY>0?step:-step),0,pending.length-1);
  rotation=angleFor(pendingIndex,pending.length);paint();queue();
 },{passive:false});
 dial.addEventListener('keydown',event=>{
  if(event.key==='Escape'&&dialPreviewing){event.preventDefault();event.stopPropagation();const captured=pointerId;pointerId=null;if(captured!==null&&dial.hasPointerCapture(captured))dial.releasePointerCapture(captured);cancel();updatePlayerUI();return;}
  if(event.key==='Enter'&&dialPreviewing){event.preventDefault();commit();return;}
  if(pointerId!==null||!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End','PageUp','PageDown'].includes(event.key)||!prepare())return;
  event.preventDefault();event.stopPropagation();
  const delta=(event.key==='ArrowRight'||event.key==='ArrowUp'?1:event.key==='PageUp'?Math.max(1,Math.round(pending.length/20)):event.key==='PageDown'?-Math.max(1,Math.round(pending.length/20)):-1);
  pendingIndex=event.key==='Home'?0:event.key==='End'?pending.length-1:clamp(pendingIndex+delta,0,pending.length-1);
  rotation=angleFor(pendingIndex,pending.length);paint();queue();
 });
 cleanDial=()=>{clearTimeout(settle);pointerId=null;dialPreviewing=false;};
}
function updateWideDial(dial:HTMLElement, position:number, index:number, total:number, preview='') {
 const receiver = dial.closest('.receiver')!;
 dial.style.setProperty('--arc-angle', `${wideDialStart + position*(wideDialEnd-wideDialStart)}deg`);
 dial.style.setProperty('--arc-offset', String(1-position));
 receiver.querySelector('[data-wide-number]')!.textContent = index >= 0 ? String(index+1).padStart(2,'0') : '—';
 receiver.querySelector('[data-wide-count]')!.textContent = index >= 0 ? '/ '+total : '';
 receiver.querySelector('[data-wide-preview]')!.textContent = preview;
}

async function selectCountry(code:string){country=code;view='country';query='';genre='';operator='';stations=[];loadState='loading';save({lastCountry:code});const gen=++loadGeneration;render();try{const results=await bridge.stations(code);if(gen!==loadGeneration)return;const seen=new Set<string>();stations=results.filter(s=>s.stationuuid&&!seen.has(s.stationuuid)&&!!seen.add(s.stationuuid));loadState='ready';operator=stations.some(s=>kindOf(s)==='broadcaster')?'broadcaster':'';renderList();}catch(error){if(gen!==loadGeneration)return;loadState='error';loadError=userMessage(error,'방송 목록을 불러올 수 없습니다.');renderList();}}
async function loadCountries(){countryLoading=true;countryLoadError='';renderCountryStrip();try{countries=await bridge.countries();countryLoading=false;globe?.setCountries(countries);renderCountryStrip();if(countryDialogOpen)renderCountryResults('');}catch(error){countryLoading=false;countryLoadError=userMessage(error,'국가 목록을 불러올 수 없습니다.');renderCountryStrip();if(countryDialogOpen)renderCountryResults('');}}
// A single delegated listener survives content updates without accumulating handlers.
async function onClick(event:MouseEvent){
 const target = event.target as HTMLElement;
 const info = target.closest<HTMLButtonElement>('[data-info],[data-current-info]');
 if (info) {
  const station = info.hasAttribute('data-current-info') ? current.station : collection().find(s=>s.stationuuid === info.dataset.info);
  if (station) openStationDetails(station,info);
  return;
 }
 const tab = target.closest<HTMLButtonElement>('[data-operator]');
 if (tab) {
  operator = tab.dataset.operator as typeof countryOperators[number];
  renderList();
  return;
 }
 const more = target.closest<HTMLButtonElement>('[data-more]');
 if (more) {
  const list = more.parentElement!;
  const start = Number(more.dataset.more);
  more.remove();
  appendStationPage(list,filtered(),start);
  list.querySelector<HTMLButtonElement>(`.station-row:nth-child(${start+1}) .station-select`)?.focus({preventScroll:true});
  return;
 }
 const actionEl=target.closest<HTMLElement>('[data-action]');const countryEl=target.closest<HTMLElement>('[data-country]');const stationEl=target.closest<HTMLElement>('[data-station]');const favEl=target.closest<HTMLElement>('[data-favorite]');const genreEl=target.closest<HTMLElement>('[data-genre]');if(countryEl){closeModal();void selectCountry(countryEl.dataset.country!);return;}if(stationEl){const station=collection().find(s=>s.stationuuid===stationEl.dataset.station);if(station)void tune(station);return;}if(favEl){favorite(collection().find(s=>s.stationuuid===favEl.dataset.favorite)||null);return;}if(genreEl){genre=genreEl.dataset.genre!;renderList();return;}if(!actionEl)return;const action=actionEl.dataset.action;switch(action){case'explore':++loadGeneration;view='explore';query='';genre='';operator='';render();break;case'favorites':++loadGeneration;view='favorites';query='';genre='';operator='';render();break;case'recent':++loadGeneration;view='recent';query='';genre='';operator='';render();break;case'settings':await openSettings();break;case'countries':openCountries();break;case'zoom-in':globe?.zoom(1);break;case'zoom-out':globe?.zoom(-1);break;case'globe-reset':globe?.reset();break;case'reload-countries':void loadCountries();break;case'retry-country':void selectCountry(country);break;case'toggle':void toggle();break;case'previous':step(-1);break;case'next':step(1);break;case'favorite-current':favorite(current.station);break;case'widget':await changeWidget(!preferences.widgetEnabled,preferences.widgetSize);break;case'close':case'minimize':case'maximize':bridge.windowAction(action);break;case'close-modal':closeModal();break;case'cache-clear':void clearAppCache(actionEl as HTMLButtonElement);break;case'desktop-shortcut':void createShortcut(actionEl as HTMLButtonElement);break;case'check-update':void checkUpdate(actionEl as HTMLButtonElement);break;case'install-update':void installUpdate(actionEl as HTMLButtonElement);break;case'github':await bridge.openExternal('https://github.com/samueltoken/Allradione');break;case'station-home':if(current.station?.homepage)await bridge.openExternal(current.station.homepage);break;}}
app.addEventListener('keydown', event => {
 const tab = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-operator]');
 if (!tab || !['ArrowLeft','ArrowRight','Home','End',' '].includes(event.key)) return;
 event.preventDefault();
 event.stopPropagation();
 if (event.key === ' ') { tab.click(); return; }
 const tabs = [...tab.parentElement!.querySelectorAll<HTMLButtonElement>('[data-operator]')];
 const i = tabs.indexOf(tab);
 const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length-1 : (i + (event.key === 'ArrowLeft' ? -1 : 1) + tabs.length) % tabs.length;
 tabs[next].focus();
 tabs[next].click();
});
app.addEventListener('input',event=>{const el=event.target as HTMLInputElement;if(el.id==='station-search'){query=el.value;renderList();}if(el.id==='volume'){player.setVolume(Number(el.value)/100);preferences.volume=Number(el.value)/100;}});
app.addEventListener('change',event=>{const el=event.target as HTMLInputElement;if(el.id==='volume')void save({volume:Number(el.value)/100});if(el.id==='operator-filter'){operator=el.value as OperatorKind|'';renderList();}if(el.id==='widget-toggle')void changeWidget(el.checked,preferences.widgetSize);if(el.name==='widget-size')void changeWidget(preferences.widgetEnabled,el.value as WidgetSize);if(el.id==='motion-toggle'){void save({reducedMotion:el.checked});document.body.classList.toggle('reduced-motion',el.checked);globe?.setReducedMotion(el.checked);}if(el.id==='sleep-timer'){clearTimeout(timer);const mins=Number(el.value);if(mins)timer=setTimeout(()=>{player.stop();toast('취침 타이머로 재생을 종료했어.');},mins*60000);}});
function updatePlayerUI() {
 if (isWidget) { updateWidget(); return; }
 if (!nativeVisible || document.hidden) return;
 const station = current.station;
 const items = view === 'explore' ? preferences.recent : filtered();
 const index = items.findIndex(s => s.stationuuid === station?.stationuuid);
 const setText = (selector:string, text:string) => document.querySelectorAll(selector).forEach(el => {
  if (el.textContent !== text) el.textContent = text;
 });
 setText('[data-footer-name]', station?.name || 'Allradione');
 setText('[data-footer-meta]', station ? regionName(station.countrycode) : '');
 setText('[data-status]', statusLabel());
 setText('[data-station-name]', station?.name || '');
 const currentInfo = document.querySelector<HTMLButtonElement>('[data-current-info]');
 if (currentInfo) currentInfo.hidden = !station;
 setText('[data-station-meta]', station ? [station.operatorName || operatorLabels[kindOf(station)], station.isPodcast ? '팟캐스트' : '', station.language, station.tags?.split(',').slice(0,3).join(' · ')].filter(Boolean).join(' / ') : '');
 setText('[data-station-country]', station ? regionName(station.countrycode) : '');
 document.querySelectorAll<HTMLElement>('[data-station-flag],[data-footer-flag]').forEach(el => {
  const code = station?.countrycode || '';
  if (el.dataset.code !== code) { el.dataset.code = code; el.innerHTML = flagMarkup(code); }
 });
 setText('[data-codec]', station ? [codecOf(station), station.bitrate ? station.bitrate+' kbps' : ''].filter(Boolean).join(' / ') : '');
 setText('[data-play-error]', current.error || '');
 const dial = document.querySelector<HTMLElement>('#dial');
 if (dial && !dialPreviewing) {
  const position = index >= 0 && items.length > 1 ? index/(items.length-1) : .5;
  setText('[data-dial-number]', index >= 0 ? String(index+1).padStart(2,'0') : '');
  setText('[data-dial-mode]', index >= 0 ? 'CHANNEL / '+items.length : '');
  const needle = dial.querySelector<HTMLElement>('#dial-needle');
  if (needle) needle.style.transform = `rotate(${-135+position*270}deg)`;
  const pointer = document.querySelector<HTMLElement>('#channel-pointer');
  if (pointer) pointer.style.left = position*100+'%';
  updateWideDial(dial, position, index, items.length);
  dial.setAttribute('aria-valuemax',String(Math.max(1,items.length)));
  dial.setAttribute('aria-valuenow',String(Math.max(1,index+1)));
  dial.setAttribute('aria-valuetext', index >= 0 ? items[index].name : '방송 미선택');
  dial.setAttribute('aria-disabled',String(!items.length));
  dial.tabIndex = items.length ? 0 : -1;
 }
 const play = document.querySelector<HTMLButtonElement>('[data-action="toggle"]');
 if (play) {
  const canPause = current.playing || current.status === 'connecting';
  play.innerHTML = icon(canPause?'pause':'play',23);
  play.setAttribute('aria-label', canPause?'일시 정지':'재생');
  play.disabled = !station && !items.length;
  play.classList.toggle('connecting', current.status==='connecting');
 }
 document.querySelectorAll<HTMLButtonElement>('[data-action="previous"],[data-action="next"]').forEach(el=>el.disabled=!items.length);
 const heart = document.querySelector<HTMLButtonElement>('[data-action="favorite-current"]');
 if (heart) {
  const saved = !!station && isFavorite(station.stationuuid);
  heart.disabled = !station;
  heart.classList.toggle('is-favorite',saved);
  heart.setAttribute('aria-pressed',String(saved));
 }
 document.querySelectorAll('.station-row.selected').forEach(el=>el.classList.remove('selected'));
 if (station) document.querySelector(`[data-station-row="${CSS.escape(station.stationuuid)}"]`)?.classList.add('selected');
 document.body.classList.toggle('is-playing',current.playing);
 document.body.classList.toggle('is-connecting',current.status==='connecting');
 document.body.classList.toggle('is-error',current.status==='error');
 const volume=document.querySelector<HTMLInputElement>('#volume');
 if(volume&&document.activeElement!==volume)volume.value=String(Math.round(current.volume*100));
 paintWave();
}
function paintFavorites(){document.querySelectorAll<HTMLElement>('[data-favorite]').forEach(el=>{const saved=isFavorite(el.dataset.favorite!);el.classList.toggle('is-favorite',saved);el.setAttribute('aria-pressed',String(saved));});}
function paintWave(){
 if(document.hidden||(!isWidget&&!nativeVisible))return;
 const data=current.playing?(current.spectrum||[]):[];
 document.querySelectorAll<HTMLElement>('.waveform').forEach(waveform=>{
  const bars=waveform.querySelectorAll<HTMLElement>('i');
  bars.forEach((bar,i)=>{
   const sample=data.length?Math.min(1,Math.max(0,data[Math.floor(i/bars.length*data.length)]||0)):0;
   bar.style.setProperty('--bar',`${Math.max(2,sample*42)}px`);
   bar.style.setProperty('--bar-opacity',String(.35+sample*.65));
   if (waveform.classList.contains('receiver-levels')) bar.style.setProperty('--level', `${sample*100}%`);
  });
 });
 document.querySelectorAll<HTMLElement>('.live-meter i').forEach((bar,i)=>{
  const sample=data.length?data[Math.floor((i+.5)/4*data.length)]||0:0;
  bar.style.height=`${3+sample*9}px`;
 });
}

function openStationDetails(station: Station, opener: HTMLButtonElement) {
 detailOpener = opener;
 const facts = [
  ['국가', countryName(station.countrycode)], ['방송 분류', operatorLabels[kindOf(station)]],
  ['운영자', station.operatorName || '미확인'], ['방송 제작', station.programmeOriginName], ['중계', station.relayName],
  ['미확인 이유', kindOf(station) === 'unknown' && (station.programmeOriginName ? '방송 제작처는 확인됐지만 이 주소의 송출 운영자는 확인되지 않았습니다.' : station.relayName ? '중계 서비스만 확인됐습니다.' : '등록된 송출 주소와 일치하는 운영 자료를 찾지 못했습니다.') || ''],
 ];
 const source = station.operatorSource;
 const link = source ? `<button class="text-button" id="operator-source">출처 보기 ${icon('external',15)}</button>` : '';
 const details = facts.filter(([,value])=>value).map(([label,value])=>`<dt>${esc(label)}</dt><dd>${esc(value)}</dd>`).join('');
 modalFrame('방송 정보',`<div class="station-details"><h3>${esc(station.name)}</h3><dl>${details}</dl>${link}</div>`);
 if (source) document.querySelector('#operator-source')?.addEventListener('click',()=>{
  void bridge.openExternal(source).catch(()=>toast('확인 자료를 열 수 없습니다.'));
 });
}
function modalFrame(title:string,body:string){const root=document.querySelector('#modal-root')!;root.innerHTML=`<div class="modal-backdrop" data-action="close-modal"></div><section class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title"><header><div><h2 id="modal-title">${title}</h2></div>${btn('x','닫기','','data-action="close-modal"')}</header>${body}</section>`;const el=root.querySelector<HTMLInputElement>('input,button');el?.focus();document.body.classList.add('modal-open');}
function closeModal(){document.querySelector('#modal-root')?.replaceChildren();settingsOpen=false;countryDialogOpen=false;document.body.classList.remove('modal-open');if(detailOpener?.isConnected)detailOpener.focus({preventScroll:true});detailOpener=undefined;}
function openCountries(){countryDialogOpen=true;settingsOpen=false;modalFrame('국가 찾기',`<label class="search-field country-dialog-search">${icon('search',18)}<input id="country-search" type="search" placeholder="국가 이름 또는 코드" autocomplete="off"></label><div class="country-results" id="country-results"></div>`);const search=document.querySelector<HTMLInputElement>('#country-search')!;search.addEventListener('input',()=>renderCountryResults(search.value));search.focus();renderCountryResults('');}
function renderCountryResults(q:string){const target=document.querySelector('#country-results');if(!target)return;if(countryLoading){target.innerHTML='<p class="loading-label">국가 목록을 불러오는 중…</p>';return;}if(countryLoadError){target.innerHTML=`<div class="empty-state"><p>${esc(countryLoadError)}</p><button class="outline-button" data-action="reload-countries">다시 연결</button></div>`;return;}const selected=countries.filter(c=>`${c.name} ${c.code} ${englishName(c.code)}`.toLowerCase().includes(q.toLowerCase()));target.innerHTML=selected.length?selected.map(c=>`<button class="country-result" data-country="${c.code}"><span class="country-result-code">${flagMarkup(c.code)}<b>${c.code}</b></span><span><strong>${esc(c.name)}</strong><small>${esc(englishName(c.code))}</small></span>${icon('arrow',16)}</button>`).join(''):'<div class="empty-state"><p>검색 결과가 없습니다.</p></div>';}
async function openSettings(){try{preferences={...preferences,...await bridge.getPreferences()};}catch{}settingsOpen=true;countryDialogOpen=false;modalFrame('설정',`<div class="settings-body"><section class="setting-section"><div class="setting-row"><div><h3>위젯 모드</h3></div><label class="switch"><input id="widget-toggle" type="checkbox" ${preferences.widgetEnabled?'checked':''} aria-label="위젯 모드"><span></span></label></div><div class="widget-size-options"><label class="size-choice"><input type="radio" name="widget-size" value="small" ${preferences.widgetSize==='small'?'checked':''}><span class="widget-preview small-preview"><i></i><i></i><i></i><i></i><b></b></span><strong>작은 원형</strong></label><label class="size-choice"><input type="radio" name="widget-size" value="medium" ${preferences.widgetSize==='medium'?'checked':''}><span class="widget-preview medium-preview"><i>65<small>VOL</small></i><span class="preview-arc"></span><b></b></span><strong>중간 직사각형</strong></label></div></section><section class="setting-section"><div class="setting-row"><div><h3>애니메이션 줄이기</h3></div><label class="switch"><input id="motion-toggle" type="checkbox" ${preferences.reducedMotion?'checked':''} aria-label="애니메이션 줄이기"><span></span></label></div><div class="setting-row"><div><h3>취침 타이머</h3></div><select id="sleep-timer" aria-label="취침 타이머"><option value="0">끄기</option><option value="15">15분</option><option value="30">30분</option><option value="60">60분</option><option value="90">90분</option></select></div></section><section class="setting-section maintenance-section"><div class="setting-row"><div><h3>캐시</h3><p id="cache-size">확인 중</p></div><button class="outline-button" data-action="cache-clear">${icon('reset',16)} 캐시 정리</button></div><p class="update-message" id="cache-message" role="status"></p><div class="setting-row shortcut-row"><div><h3>바탕화면 실행 파일</h3></div><button class="outline-button" data-action="desktop-shortcut">${icon('plus',16)} 만들기</button></div></section><section class="setting-section update-section"><div class="setting-row"><div><h3>업데이트</h3><p>현재 버전 <span id="current-version">${esc(version)}</span></p></div><button class="outline-button" data-action="check-update">${icon('refresh',16)} 업데이트 확인</button></div><p class="update-message" id="update-message" role="status"></p></section><footer class="settings-footer"><span>Allradione <b>© 2026</b></span><button class="text-button" data-action="github">OPEN SOURCE ${icon('external',14)}</button></footer></div>`);void refreshCacheSize();}
async function changeWidget(enabled:boolean,size:WidgetSize){try{await bridge.setWidget(enabled,size);await save({widgetEnabled:enabled,widgetSize:size});player?.setVisualizing((nativeVisible&&!document.hidden)||preferences.widgetEnabled);document.querySelectorAll('[data-action="widget"]').forEach(el=>el.classList.toggle('active',enabled));if(settingsOpen){const toggle=document.querySelector<HTMLInputElement>('#widget-toggle');if(toggle)toggle.checked=enabled;}}catch(error){const toggle=document.querySelector<HTMLInputElement>('#widget-toggle');if(toggle)toggle.checked=preferences.widgetEnabled;toast(userMessage(error,'위젯을 열지 못했어. 다시 시도해줘.'));}}
async function checkUpdate(button:HTMLButtonElement) {
 button.disabled = true;
 button.setAttribute('aria-busy','true');
 const message = document.querySelector<HTMLElement>('#update-message')!;
 message.textContent = '확인 중…';
 const reducedMotion = preferences.reducedMotion || matchMedia('(prefers-reduced-motion: reduce)').matches;
 const turn = reducedMotion ? undefined : button.querySelector('svg')?.animate(
  [{transform:'rotate(0deg)'},{transform:'rotate(360deg)'}],
  {duration:620, easing:'cubic-bezier(.4,0,.2,1)'}
 );
 const finished = turn?.finished.catch(() => {});
 let available = false;
 try {
  const info = await bridge.checkUpdate();
  available = info.available;
  updateMode = info.mode;
  message.textContent = available ? 'v'+info.version+' 업데이트가 있어.' : userMessage(info.message,'업데이트를 확인하지 못했어. 잠시 후 다시 시도해줘.');
 } catch (error) {
  message.textContent = userMessage(error,'업데이트를 확인하지 못했어. 인터넷 연결을 확인해줘.');
 } finally {
  await finished;
  button.dataset.action = available ? 'install-update' : 'check-update';
  button.innerHTML = available ? icon('arrow',16)+(updateMode==='installer'?'다운로드 및 설치':'업데이트하기') : icon('refresh',16)+' 업데이트 확인';
  button.removeAttribute('aria-busy');
  button.disabled = false;
 }
}
async function installUpdate(button:HTMLButtonElement){
 button.disabled=true;button.innerHTML=icon('refresh',16)+(updateMode==='installer'?'설치 파일 다운로드 중':'다운로드 중');
 let restarting=false;
 const showMessage=(message:string)=>{const target=document.querySelector('#update-message');if(target)target.textContent=message;};
 try{
  const result=await bridge.installUpdate();
  showMessage(userMessage(result.message,'업데이트를 적용하지 못했어. 잠시 후 다시 시도해줘.'));
  restarting=result.status==='installing';
  if(restarting)button.innerHTML=icon('refresh',16)+' 설치 및 재시작 중';
  else if(result.status==='retry')button.innerHTML=icon('refresh',16)+' 다시 시도';
  else{button.dataset.action='check-update';button.innerHTML=icon('refresh',16)+' 다시 확인';}
 }catch(error){showMessage(userMessage(error,'업데이트를 적용하지 못했어. 잠시 후 다시 시도해줘.'));button.innerHTML=icon('refresh',16)+' 다시 시도';}
 finally{button.disabled=restarting;}
}


function formatBytes(bytes:number){if(bytes<1024)return `${Math.max(0,bytes)} B`;if(bytes<1024*1024)return `${(bytes/1024).toFixed(1)} KB`;if(bytes<1024*1024*1024)return `${(bytes/1024/1024).toFixed(1)} MB`;return `${(bytes/1024/1024/1024).toFixed(2)} GB`;}
async function refreshCacheSize(){
 const label=document.querySelector<HTMLElement>('#cache-size');if(!label)return;
 try{const info=await bridge.cacheInfo();if(label.isConnected)label.textContent=formatBytes(info.totalBytes);}
 catch{if(label.isConnected)label.textContent='용량을 확인할 수 없어.';}
}
async function clearAppCache(button:HTMLButtonElement){
 button.disabled=true;button.innerHTML=icon('reset',16)+' 정리 중';
 const message=document.querySelector<HTMLElement>('#cache-message');
 try{const result=await bridge.clearCache();if(message?.isConnected)message.textContent=result.errors.length?'사용 중인 일부 캐시를 제외하고 정리했어.':result.freedBytes>0?`${formatBytes(result.freedBytes)} 정리 완료`:'정리할 캐시가 없어.';await refreshCacheSize();}
 catch{if(message?.isConnected)message.textContent='캐시를 정리하지 못했어. 다시 시도해줘.';}
 finally{button.disabled=false;button.innerHTML=icon('reset',16)+' 캐시 정리';}
}
async function createShortcut(button:HTMLButtonElement){
 button.disabled=true;
 try{
  const result=await bridge.createDesktopShortcut();
  const message=result.created?'바탕화면에 실행 파일을 만들었어.':result.message==='같은 이름의 다른 파일이 있어 덮어쓰지 않았습니다.'?'바탕화면에 같은 이름의 파일이 있어. 이름을 바꾼 뒤 다시 시도해줘.':result.message==='Windows 설치 버전에서 사용할 수 있습니다.'?'Windows 설치 버전에서 사용할 수 있어.':'실행 파일을 만들지 못했어. 바탕화면 폴더 권한을 확인해줘.';
  toast(message);
 }
 catch{toast('실행 파일을 만들지 못했어. 다시 시도해줘.');}
 finally{button.disabled=false;}
}


// Ring motion integrates only decoded band energy. Silence decelerates to rest.
const radarTargets=new Float32Array(5);
const radarLevels=new Float32Array(5);
const radarVelocity=new Float32Array(5);
const radarAngles=[-18,31,-8,52,9];
let radarFrame=0;
let radarLastFrame=0;
let radarSampleAt=0;
let radarDrawState='';
let radarRings:SVGElement[]=[];
let radarCore:SVGCircleElement|null=null;
function feedRadar(spectrum:number[]){
 if(document.hidden)return;
 if(!radarRings.length){radarRings=[...document.querySelectorAll<SVGElement>('.radar-ring')];radarCore=document.querySelector<SVGCircleElement>('.radar-core');}
 if(!radarRings.length)return;
 const reduced=document.body.classList.contains('reduced-motion');
 const state=`${current.playing}:${reduced}`;
 if(reduced){
  if(radarFrame)cancelAnimationFrame(radarFrame);
  radarFrame=0;radarLevels.fill(0);radarVelocity.fill(0);radarTargets.fill(0);
  if(radarDrawState!==state)paintRadar(performance.now());
  return;
 }
 for(let i=0;i<5;i++){
  const start=Math.floor(i*spectrum.length/5),end=Math.floor((i+1)*spectrum.length/5);
  let power=0,peak=0;
  for(let k=start;k<end;k++){const sample=Math.max(0,Math.min(1,spectrum[k]||0));power+=sample*sample;peak=Math.max(peak,sample);}
  radarTargets[i]=end>start?Math.min(1,Math.sqrt(power/(end-start))*.75+peak*.25):0;
 }
 radarSampleAt=performance.now();
 const moving=radarTargets.some(value=>value>.001)||radarLevels.some(value=>value>.001)||radarVelocity.some(value=>Math.abs(value)>.02);
 if(!radarFrame&&(moving||radarDrawState!==state)){radarLastFrame=0;radarFrame=requestAnimationFrame(paintRadar);}
}
function paintRadar(time:number){
 radarFrame=0;
 const dt=radarLastFrame?Math.min(.05,(time-radarLastFrame)/1000):1/60;
 radarLastFrame=time;
 const reduced=document.body.classList.contains('reduced-motion');
 radarDrawState=`${current.playing}:${reduced}`;
 const fresh=current.playing&&current.volume>0&&time-radarSampleAt<250;
 let moving=false;
 for(let i=0;i<radarRings.length;i++){
  const target=!reduced&&fresh?radarTargets[i]:0;
  const previous=radarLevels[i];
  let level=previous+(target-previous)*(1-Math.exp(-dt/(target>previous?.035:.17)));
  if(level<.001)level=0;
  radarLevels[i]=level;
  const direction=i%2===0?1:-1;
  const desired=direction*(52+i*21)*Math.pow(level,1.3);
  let velocity=radarVelocity[i]+(desired-radarVelocity[i])*(1-Math.exp(-dt/.12));
  if(reduced||Math.abs(velocity)<.02)velocity=0;
  radarVelocity[i]=velocity;
  if(!reduced)radarAngles[i]=(radarAngles[i]+velocity*dt)%360;
  const ring=radarRings[i];
  const energy=reduced?0:level;
  ring.style.transform=`rotate(${radarAngles[i].toFixed(3)}deg) scale(${(1+energy*.045).toFixed(4)})`;
  ring.style.strokeWidth=(2.8+energy*4.1).toFixed(3);
  ring.style.opacity=String((current.playing?.5:.34)+energy*.5);
  ring.style.filter=energy>.01?`drop-shadow(0 0 ${(energy*3.5).toFixed(2)}px rgba(190,232,83,${(energy*.65).toFixed(3)}))`:'none';
  ring.style.setProperty('--ring-signal',energy.toFixed(4));
  moving=moving||level>.001||Math.abs(velocity)>.02;
 }
 const bass=reduced?0:radarLevels[0];
 if(radarCore){radarCore.setAttribute('r',String(4.8+bass*2.7));radarCore.style.filter=bass>.01?`drop-shadow(0 0 ${bass*5}px #c1e25b)`:'none';}
 if(moving&&!reduced)radarFrame=requestAnimationFrame(paintRadar);
}
function stopRadar(){
 if(radarFrame)cancelAnimationFrame(radarFrame);
 radarFrame=0;radarLastFrame=0;radarDrawState='';radarLevels.fill(0);radarVelocity.fill(0);
}
window.addEventListener('pagehide',stopRadar);
document.addEventListener('visibilitychange',()=>{
 if(!isWidget)return;
 if(document.hidden)stopRadar();else updateWidget();
});

function mediumDialSVG(){
 let ticks='';
 for(let i=0;i<=32;i++){
  const angle=(180+i*100/32)*Math.PI/180;
  const inner=i%4===0?70:77,outer=84;
  ticks+=`<line x1="${130+Math.cos(angle)*inner}" y1="${100+Math.sin(angle)*inner}" x2="${130+Math.cos(angle)*outer}" y2="${100+Math.sin(angle)*outer}" class="${i%4===0?'major':''}"/>`;
 }
 return `<svg viewBox="0 0 150 110" preserveAspectRatio="none"><path class="retro-arc-track" d="M39 100 A91 91 0 0 1 145.802 10.383"/><path class="retro-arc-progress" data-volume-arc pathLength="100" d="M39 100 A91 91 0 0 1 145.802 10.383"/>${ticks}<line class="retro-arc-needle" data-volume-needle x1="130" y1="100" x2="43" y2="100"/></svg>`;
}

function renderWidget(){document.documentElement.classList.add('widget-root');void bridge.getPreferences().then(p=>document.body.classList.toggle('reduced-motion',p.reducedMotion)).catch(()=>{});bridge.onCommand((command,value)=>{if(command==='preferences-changed'&&value&&typeof value==='object')document.body.classList.toggle('reduced-motion',!!(value as Partial<Preferences>).reducedMotion);});document.body.className=`widget-body widget-${widgetSize}`;const small=widgetSize==='small';app.innerHTML=small?`<div class="mini-widget"><div class="widget-drag" title="Allradione"></div><button class="radar-play" id="widget-play" aria-label="재생"><svg class="radar" viewBox="0 0 160 160" aria-hidden="true">${[69,57,45,33,21].map((r,i)=>`<circle cx="80" cy="80" r="${r}" pathLength="100" class="radar-ring ring-${i}"/>`).join('')}<circle class="radar-orbit" cx="80" cy="80" r="11"/><path class="radar-spoke" d="M80 90v57"/><circle class="radar-core" cx="80" cy="80" r="6"/></svg><span class="radar-control">${icon('play',24)}</span></button><div class="mini-station"><span data-widget-country-flag></span><span data-widget-name>ALLRADIONE</span></div><div class="widget-hover-controls"><button aria-label="앱 열기" data-widget-action="show">${icon('expand',13)}</button><span data-widget-status></span><button aria-label="위젯 닫기" data-widget-action="close">${icon('x',13)}</button></div></div>`:`<div class="retro-widget"><div class="retro-screen"><div class="retro-top"><span class="retro-brandline">ALLRADIONE<span class="retro-header-separator"></span>${liveDot}<b data-widget-status></b></span><div><button data-widget-action="show" aria-label="앱 열기">${icon('expand',13)}</button><button data-widget-action="close" aria-label="위젯 닫기">${icon('x',13)}</button></div></div><div class="retro-face"><div class="retro-readout"><strong><b data-widget-volume-readout>65</b><small>%<em>VOL</em></small></strong></div><div class="retro-arc" aria-hidden="true">${mediumDialSVG()}<span class="retro-arc-caption">VOLUME</span></div></div><div class="retro-identity"><div class="retro-station" data-widget-name></div><div class="retro-meta"><span data-widget-country-flag></span><span data-widget-meta></span></div></div><div class="retro-wave">${wave(32)}</div><div class="retro-transport"><button data-widget-action="previous" aria-label="이전 방송">${icon('prev',16)}</button><button class="retro-play" id="widget-play" aria-label="재생">${icon('play',18)}</button><button data-widget-action="next" aria-label="다음 방송">${icon('next',16)}</button><div class="retro-volume">${icon('volume',14)}<input id="widget-volume" type="range" min="0" max="100" value="65" aria-label="볼륨"></div></div></div></div>`;app.addEventListener('click',event=>{const target=event.target as HTMLElement;if(target.closest('#widget-play'))bridge.sendCommand('toggle-play');const action=target.closest<HTMLElement>('[data-widget-action]')?.dataset.widgetAction;if(action==='show')bridge.windowAction('show');else if(action==='close')void bridge.setWidget(false,widgetSize);else if(action)bridge.sendCommand(action);});document.querySelector<HTMLInputElement>('#widget-volume')?.addEventListener('input',event=>{bridge.sendCommand('volume',Number((event.target as HTMLInputElement).value)/100);});bridge.onPlayer(state=>{current=state;updateWidget();});updateWidget();}
let widgetPaintKey='';
function updateWidget(){
 if(document.hidden)return;
 const paintKey=JSON.stringify([current.station?.stationuuid,current.status,current.playing,current.volume]);
 if(paintKey!==widgetPaintKey){
  widgetPaintKey=paintKey;
  document.body.classList.toggle('is-playing',current.playing);
  document.body.classList.toggle('is-connecting',current.status==='connecting');
  document.body.classList.toggle('is-error',current.status==='error');
  const name=document.querySelector('[data-widget-name]');
  if(name){name.textContent=current.station?.name||(widgetSize==='small'?'ALLRADIONE':'');name.setAttribute('title',current.station?.name||'Allradione');}
  document.querySelectorAll('[data-widget-status]').forEach(el=>{el.textContent=statusLabel();});
  const meta=document.querySelector('[data-widget-meta]');
  if(meta)meta.textContent=current.station?[regionName(current.station.countrycode),current.station.codec,current.station.bitrate?current.station.bitrate+' KBPS':''].filter(Boolean).join(' / ') : '';
  const control=document.querySelector('.radar-control');if(control)control.innerHTML=icon(current.playing?'pause':'play',24);
  const play=document.querySelector<HTMLButtonElement>('#widget-play');
  if(play){play.setAttribute('aria-label',current.playing?'일시 정지':'재생');if(widgetSize==='medium')play.innerHTML=icon(current.playing?'pause':'play',18);}
  const volume=document.querySelector<HTMLInputElement>('#widget-volume');
  if(volume&&document.activeElement!==volume)volume.value=String(Math.round(current.volume*100));
  const volumeValue=document.querySelector('[data-widget-volume-readout]');if(volumeValue)volumeValue.textContent=String(Math.round(current.volume*100)).padStart(2,'0');
  const volumeArc=document.querySelector<SVGElement>('[data-volume-arc]');if(volumeArc)volumeArc.style.strokeDasharray=`${current.volume*100} 100`;
  const volumeNeedle=document.querySelector<SVGElement>('[data-volume-needle]');if(volumeNeedle)volumeNeedle.setAttribute('transform',`rotate(${current.volume*100} 130 100)`);
  document.querySelectorAll<HTMLElement>('[data-widget-country-flag]').forEach(el=>{
   const code=current.station?.countrycode||'';if(el.dataset.code!==code){el.dataset.code=code;el.innerHTML=flagMarkup(code);}
  });
 }
 const spectrum=current.playing&&current.volume>0?(current.spectrum||[]):[];
 const level=spectrum.length?Math.min(1,spectrum.reduce((a,b)=>a+b,0)/spectrum.length):0;
 document.documentElement.style.setProperty('--signal-level',String(level));
 if(widgetSize==='small')feedRadar(spectrum);
 paintWave();
}


async function start(){if(isWidget){renderWidget();return;}try{preferences={...preferences,...await bridge.getPreferences()};version=await bridge.version();}catch{toast('설정을 불러오지 못해 기본값으로 시작했어.');}document.body.classList.toggle('reduced-motion',preferences.reducedMotion);const {RadioPlayer}=await import('./audio');player=new RadioPlayer(bridge,state=>{current=state;if(state.status==='playing'&&state.station&&state.station.stationuuid!==lastRecent){lastRecent=state.station.stationuuid;void save({recent:[state.station,...preferences.recent.filter(s=>s.stationuuid!==state.station!.stationuuid)].slice(0,40)});}const key=JSON.stringify([state.station?.stationuuid,state.status,state.volume,state.error]);if(key!==previousPaintKey){previousPaintKey=key;if(recordPlaybackHealth(state))renderList();updatePlayerUI();}else paintWave();});player.setVolume(preferences.volume);player.setVisualizing(true);app.addEventListener('click',onClick);render();void loadCountries();bridge.onCommand((command,value)=>{switch(command){case'window-visibility':nativeVisible=Boolean(value);globe?.setActive(nativeVisible&&!document.hidden);player.setVisualizing((nativeVisible&&!document.hidden)||preferences.widgetEnabled);document.body.classList.toggle('window-hidden',!nativeVisible);if(nativeVisible)updatePlayerUI();break;case'preferences-changed':if(value&&typeof value==='object'){preferences={...preferences,...value as Partial<Preferences>};document.body.classList.toggle('reduced-motion',preferences.reducedMotion);globe?.setReducedMotion(preferences.reducedMotion);player.setVisualizing((nativeVisible&&!document.hidden)||preferences.widgetEnabled);document.querySelectorAll('[data-action="widget"]').forEach(el=>el.classList.toggle('active',preferences.widgetEnabled));const check=document.querySelector<HTMLInputElement>('#widget-toggle');if(check)check.checked=preferences.widgetEnabled;document.querySelectorAll<HTMLInputElement>('input[name="widget-size"]').forEach(el=>el.checked=el.value===preferences.widgetSize);}break;case'toggle-play':case'toggle':void toggle();break;case'next':step(1);break;case'previous':step(-1);break;case'volume':player.setVolume(Number(value));void save({volume:Number(value)});break;case'favorite':favorite(current.station);break;case'show':bridge.windowAction('show');break;case'disable-widget':void changeWidget(false,preferences.widgetSize);break;}});document.addEventListener('keydown',event=>{if(event.key==='Escape'){closeModal();return;}if(event.key==='Tab'&&(settingsOpen||countryDialogOpen||detailOpener)){const items=[...document.querySelectorAll<HTMLElement>('.modal button:not(:disabled),.modal input,.modal select')].filter(el=>el.getClientRects().length>0);const first=items[0],last=items[items.length-1];if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}return;}if(settingsOpen||countryDialogOpen||detailOpener)return;if((event.target as HTMLElement).matches('input,select,textarea')||event.ctrlKey||event.metaKey||event.altKey)return;if(event.code==='Space'){event.preventDefault();void toggle();}if(event.key==='/'){event.preventDefault();if(view==='explore')openCountries();else document.querySelector<HTMLInputElement>('#station-search')?.focus();}});document.addEventListener('visibilitychange',()=>{globe?.setActive(nativeVisible&&!document.hidden);player.setVisualizing((nativeVisible&&!document.hidden)||preferences.widgetEnabled);document.body.classList.toggle('window-hidden',!nativeVisible||document.hidden);if(nativeVisible&&!document.hidden)updatePlayerUI();});}
if (!isWidget) mountChat();
void start();
