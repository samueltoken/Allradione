import names from '../electron/languages.json';
import { uiRows } from './ui-locales';
import { noticeRows } from './notice-locales';
import { chatRows } from './chat-locales';

export const languages = names;
export type Language = keyof typeof languages;
const codes = Object.keys(languages) as Language[];
const rows = new Map([...uiRows, ...noticeRows, ...chatRows].map(row => [row[0], row]));
let active: Language = 'ko';
const listeners = new Set<() => void>();
export const locale = () => active;
export function onLanguageChange(callback: () => void) {
  listeners.add(callback);
  return () => { listeners.delete(callback); };
}
export function setLanguage(code: unknown) {
  const next = typeof code === 'string' && Object.hasOwn(names,code) ? code as Language : 'ko';
  if (typeof document !== 'undefined') document.documentElement.lang = next;
  if (next === active) return;
  active = next;
  for (const update of listeners) update();
}
export function t(source: string): string {
  if (source.startsWith('다음 방송 ') && !source.includes('{time}')) {
    const raw=source.slice('다음 방송 '.length), date=new Date(raw);
    const time=Number.isFinite(date.valueOf()) ? date.toLocaleString([active,'en'],{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false}) : raw;
    return t('다음 방송 {time}').replace('{time}',time);
  }
  if (!source || active === 'ko') return source;
  const row = rows.get(source);
  if (row) return row[codes.indexOf(active)] || source;
  const http = /^(.*?)\s*\((\d{3})\)$/.exec(source);
  if (http) { const template = http[1]+' ({status})'; return rows.has(template) ? t(template).replace('{status}',http[2]) : source; }
  return source;
}
const regionDisplays = new Map<string, Intl.DisplayNames>();
const localRegions: Record<string, [string,string]> = {
  KR:['南韓','Corea Meridionalis'], KP:['北韓','Corea Septentrionalis'], TW:['臺灣','Taivania'],
  CN:['中國','Sinae'], JP:['日本','Iaponia'], US:['美國','Civitates Foederatae Americae'],
  GB:['英國','Regnum Unitum'], FR:['法國','Francia'], DE:['德國','Germania'], HK:['香港','Hongcongum'],
  IT:['義大利','Italia'], ES:['西班牙','Hispania'], AU:['澳洲','Australia'], CA:['加拿大','Canada']
};
export function region(code: string, language: string = active) {
  if (!/^[A-Z]{2}$/.test(code)) return code;
  if (localRegions[code] && (language === 'nan-TW' || language === 'la')) return localRegions[code][language === 'la' ? 1 : 0];
  let display = regionDisplays.get(language);
  if (!display) {
    const fallback = language === 'nan-TW' || language === 'yue-HK' ? 'zh-Hant' : 'en';
    display = new Intl.DisplayNames([language, fallback], {type:'region'});
    regionDisplays.set(language,display);
  }
  return display.of(code) || code;
}
