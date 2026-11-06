import type { AllradioneBridge, Country, PlayerState, Preferences, Station, UpdateInfo } from './types';
const defaults:Preferences={volume:.65,favorites:[],recent:[],widgetEnabled:false,widgetSize:'small',lastCountry:'',reducedMotion:false};
const channels = new BroadcastChannel('allradione-preview');
let preferences:Preferences={...defaults};
try { preferences={...defaults,...JSON.parse(localStorage.getItem('allradione-preferences')||'{}')}; } catch { /* Preserve working defaults on invalid local preferences. */ }
const apiServers=['https://de1.api.radio-browser.info','https://nl1.api.radio-browser.info'];
async function request<T>(path:string):Promise<T>{
 for(const server of apiServers){try{const res=await fetch(server+'/json/'+path,{signal:AbortSignal.timeout(9000)});if(!res.ok)continue;return await res.json() as T;}catch{}}
 throw new Error('방송국 목록에 연결할 수 없어. 잠시 후 다시 시도해줘.');
}
let update:UpdateInfo|undefined;
export const desktop = !!window.allradione;
export const bridge:AllradioneBridge = window.allradione || {
 async getPreferences(){return preferences;},
 async savePreferences(patch){preferences={...preferences,...patch};localStorage.setItem('allradione-preferences',JSON.stringify(preferences));return preferences;},
 async countries(){const raw=await request<{name:string;iso_3166_1:string;stationcount:number}[]>('countries');const regionNames=new Intl.DisplayNames(['ko'],{type:'region'});return raw.filter(c=>/^[A-Z]{2}$/.test(c.iso_3166_1)).map(c=>({code:c.iso_3166_1,name:regionNames.of(c.iso_3166_1)||c.name,stationcount:c.stationcount} as Country)).sort((a,b)=>a.name.localeCompare(b.name,'ko'));},
 async stations(code){if(!/^[A-Z]{2}$/.test(code))throw new Error('올바른 국가를 선택해줘.');return request<Station[]>('stations/bycountrycodeexact/'+code+'?hidebroken=true&order=votes&reverse=true&limit=1000');},
 async streamUrl(url){if(!/^https?:\/\//i.test(url))throw new Error('지원하지 않는 방송 주소야.');return url;},
 async stationClick(id){if(/^[\w-]+$/.test(id))await request('url/'+id).catch(()=>undefined);},
 async setWidget(){throw new Error('위젯은 Windows 데스크톱 앱에서 사용할 수 있어.');},
 publishPlayer(state){channels.postMessage({kind:'player',state});},
 onPlayer(fn){const listener=(event:MessageEvent)=>{if(event.data?.kind==='player')fn(event.data.state as PlayerState);};channels.addEventListener('message',listener);return()=>channels.removeEventListener('message',listener);},
 sendCommand(command,value){channels.postMessage({kind:'command',command,value});},
 onCommand(fn){const listener=(event:MessageEvent)=>{if(event.data?.kind==='command')fn(event.data.command,event.data.value);};channels.addEventListener('message',listener);return()=>channels.removeEventListener('message',listener);},
 windowAction(action){if(action==='close')window.close();if(action==='show')window.focus();},
 async checkUpdate(){const response=await fetch('https://api.github.com/repos/samueltoken/Allradione/releases/latest',{signal:AbortSignal.timeout(10000)});if(response.status===404)return {available:false,currentVersion:'0.1.0',version:'0.1.0',url:'https://github.com/samueltoken/Allradione/releases',message:'아직 새 릴리즈가 없어.'};if(!response.ok)throw new Error('업데이트 정보를 불러올 수 없어.');const release=await response.json();update={available:release.tag_name.replace(/^v/,'')!=='0.1.0',currentVersion:'0.1.0',version:release.tag_name.replace(/^v/,''),url:release.html_url};return update;},
 async installUpdate(){window.open(update?.url||'https://github.com/samueltoken/Allradione/releases','_blank','noopener,noreferrer');return{message:'릴리즈 페이지에서 새 버전을 다운로드해줘.'};},
 async openExternal(url){if(/^https?:\/\//i.test(url))window.open(url,'_blank','noopener,noreferrer');},
 async version(){return '0.1.0';}
};
