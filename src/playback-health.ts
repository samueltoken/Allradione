import { addressSignature, wasDeniedInAudit } from '../electron/station-health.mjs';
import type { PlayerState, Station } from './types';

type Observation = { key: string; ok: boolean; expires: number };
const storageKey = 'allradione-playback-health';
const observations = new Map<string, Observation>();
try {
  const saved: unknown = JSON.parse(localStorage.getItem(storageKey) || '[]');
  if (Array.isArray(saved)) for (const item of saved.slice(-256)) {
    if (typeof item?.key === 'string' && typeof item.ok === 'boolean' && item.expires > Date.now()) observations.set(item.key, item);
  }
} catch { /* Storage can be unavailable in preview. */ }

function keyOf(station: Station) { return station.stationuuid + ':' + addressSignature(station); }
function label(station: Station, key: string, now: number) {
  const local = observations.get(key);
  if (local && local.expires > now) return local.ok ? '' : '최근 재생 실패';
  return wasDeniedInAudit(station, now) ? '국내 점검 시 접근 제한' : '';
}
export function playbackHealthLabel(station: Station) {
  return label(station, keyOf(station), Date.now());
}
export function prioritizePlayable(stations: Station[]) {
  const ready: Station[] = [], unavailable: Station[] = [];
  for (const station of stations) (playbackHealthLabel(station) ? unavailable : ready).push(station);
  return ready.concat(unavailable);
}
export function recordPlaybackHealth(state: PlayerState) {
  if (!state.station || !['playing', 'error'].includes(state.status) || state.error === '재생 버튼을 눌러 주세요.') return false;
  const now = Date.now(), ok = state.status === 'playing', key = keyOf(state.station);
  const previous = observations.get(key);
  if (previous?.ok === ok && previous.expires > now) return false;
  const before = label(state.station, key, now);
  // A successful local playback supersedes a regional audit until it expires.
  const expires = now + (ok ? 7 * 24 : 1) * 60 * 60 * 1000;
  observations.delete(key);
  observations.set(key, {key, ok, expires});
  if (observations.size > 256) observations.delete(observations.keys().next().value!);
  try { localStorage.setItem(storageKey, JSON.stringify([...observations.values()])); } catch { /* Continue in memory. */ }
  return before !== label(state.station, key, now);
}
