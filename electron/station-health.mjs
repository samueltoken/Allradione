import { failedStationAddresses, deniedStationAddresses, checkedAt } from './station-health-results.mjs';

// Matches a dated observation to the exact address pair that was checked.
// A directory edit or a newer positive server check restores the station immediately.
export function addressSignature(station) {
  const text = [station.url || '', station.url_resolved || ''].join('\n');
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
  return (hash >>> 0).toString(16);
}

export function isPlaybackAddress(value) {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return false;
    const host = url.hostname.toLowerCase().replace(/\.$/, '');
    if (host.startsWith('[')) return /^\[[23][\da-f]{3}:/.test(host) && !host.startsWith('[2001:db8:');
    if (!host.includes('.') || /\.(local|localhost|internal|home|lan)$/.test(host)) return false;
    if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
      const [a, b, c] = host.split('.').map(Number);
      return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) ||
        (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
        (a === 100 && b >= 64 && b <= 127) || (a === 198 && [18,19].includes(b)) ||
        (a === 192 && b === 0 && [0,2].includes(c)) || (a === 198 && b === 51 && c === 100) ||
        (a === 203 && b === 0 && c === 113));
    }
    return true;
  } catch { return false; }
}

const reviewTime = Date.parse(checkedAt);
const reviewExpiry = reviewTime + 7 * 24 * 60 * 60 * 1000;
export function wasDeniedInAudit(station, now = Date.now()) {
  const signature = deniedStationAddresses[station.stationuuid];
  return Boolean(signature && now <= reviewExpiry && signature === addressSignature(station));
}
export function isAvailableStation(station, now = Date.now()) {
  if (!station || Number(station.lastcheckok) !== 1 ||
      ![station.url_resolved, station.url].some(isPlaybackAddress)) return false;
  const signature = failedStationAddresses[station.stationuuid];
  if (!signature || now > reviewExpiry || Date.parse(station.lastchecktime_iso8601) > reviewTime) return true;
  return addressSignature(station) !== signature;
}
