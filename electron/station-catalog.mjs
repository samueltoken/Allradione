import { koreanStations, isKoreanBroadcasterStation } from './korean-stations.mjs';
import { koreanChannelAlias, streamOrigin } from './station-origins.mjs';
import { incomingStations } from './station-country-index.mjs';
import { isAvailableStation } from './station-health.mjs';
import { correctNhkStation } from './nhk-radio.mjs';

const koreanById = new Map(koreanStations.map(row => [row.stationuuid, row]));
const strings = ['stationuuid','name','url_resolved','url','homepage','favicon','language','tags','codec','lastchecktime_iso8601'];
const numbers = ['bitrate','hls','lastcheckok','votes'];
const countryNames = new Intl.DisplayNames(['ko'], { type: 'region' });

function countryCode(input) {
  const code = String(input || '').trim().toUpperCase();
  return /^[A-Z]{2}$/.test(code) && code !== 'UN' ? code : 'ZZ';
}

export function cleanStation(raw) {
  if (!raw || typeof raw.stationuuid !== 'string' || !raw.stationuuid || typeof raw.name !== 'string') return null;
  let station = {};
  for (const key of strings) station[key] = String(raw[key] || '').slice(0, 8192);
  for (const key of numbers) station[key] = Number.isFinite(raw[key]) ? raw[key] : 0;
  for (const key of ['geo_lat','geo_long']) if (Number.isFinite(raw[key])) station[key] = raw[key];
  if (station.stationuuid.startsWith('allradione-')) {
    // Only return the bundled record; a directory entry must not impersonate
    // a curated station, even if it copies some of its metadata.
    if (!isKoreanBroadcasterStation(station)) return null;
    station = { ...koreanById.get(station.stationuuid) };
  } else {
    const canonical = koreanById.get('allradione-' + koreanChannelAlias(station));
    if (canonical) station = { ...canonical };
  }
  const origin = streamOrigin(station);
  if (origin.name) station.name = origin.name;
  station.countrycode = origin.country || countryCode(raw.countrycode);
  station.operatorKind = origin.kind || 'unknown';
  for (const key of ['operatorName','operatorSource','relayName','programmeOriginName']) {
    if (origin[key]) station[key] = origin[key];
  }
  if (isKoreanBroadcasterStation(station)) station.operatorSource = station.homepage;
  station.isPodcast = /\bpodcasts?\b|팟캐스트|ポッドキャスト|播客|подкаст/iu.test(station.tags + ' ' + station.name);
  return correctNhkStation(station);
}

export function savedStations(rows) {
  if (!Array.isArray(rows)) return [];
  const byId = new Map();
  for (const row of rows) {
    const station = cleanStation(row);
    if (station && !byId.has(station.stationuuid)) byId.set(station.stationuuid, station);
  }
  return [...byId.values()];
}

export function countriesFromRows(rows) {
  const counts = new Map();
  for (const row of rows) {
    const code = countryCode(row.code ?? row.name);
    counts.set(code, (counts.get(code) || 0) + Math.max(0, Number(row.stationcount) || 0));
  }
  // The API's country count endpoint can omit entries with an empty code.
  if (!counts.has('ZZ')) counts.set('ZZ', 0);
  if (!counts.has('KR')) counts.set('KR', koreanStations.length);
  return Array.from(counts, ([code, stationcount]) => ({
    code, name: code === 'ZZ' ? '국가 미확인' : countryNames.of(code) || code, stationcount
  }));
}

export function stationsForCountry(rows, code) {
  const result = new Map();
  if (code === 'KR') {
    for (const row of koreanStations) result.set(row.stationuuid, cleanStation(row));
  }
  for (const row of rows) {
    if (!isAvailableStation(row)) continue;
    const station = cleanStation(row);
    if (station?.countrycode === code && !result.has(station.stationuuid)) result.set(station.stationuuid, station);
  }
  return [...result.values()];
}

const pageSize = 2000;
async function loadCountryPages(request, code) {
  const rows = [];
  const seen = new Set();
  for (let offset = 0; ; offset += pageSize) {
    // A mutable popularity order can skip entries between pages. Sort the
    // collected records locally for the UI after fetching in name order.
    const page = await request('stations/bycountrycodeexact/' + code +
      '?hidebroken=true&order=name&limit=' + pageSize + '&offset=' + offset);
    if (!Array.isArray(page)) throw new Error('Invalid station directory');
    const previousSize = seen.size;
    for (const row of page) {
      if (row && !seen.has(row.stationuuid)) {
        seen.add(row.stationuuid);
        rows.push(row);
      }
    }
    if (page.length < pageSize) return rows;
    if (seen.size === previousSize) {
      throw new Error('Station directory repeated a full page');
    }
  }
}

export function createStationReader(request) {
  const discovered = new Map();
  const pending = new Map();
  async function read(code) {
    const buckets = code === 'ZZ' ? ['', 'UN', 'ZZ']
      : code === 'KP' || code === 'KR' ? [code, code === 'KP' ? 'KR' : 'KP'] : [code];
    const ids = new Set([...(incomingStations[code] || []), ...(discovered.get(code) || [])]);
    const pendingPages = buckets.map(bucket => loadCountryPages(request, bucket));
    const incoming = [...ids];
    for (let offset = 0; offset < incoming.length; offset += 80) {
      pendingPages.push(request('stations/byuuid?uuids=' + incoming.slice(offset, offset + 80).join(',')));
    }
    const pages = await Promise.allSettled(pendingPages);
    const primary = pages[0];
    if (primary.status === 'rejected') throw primary.reason;
    const rows = pages.flatMap(page => page.status === 'fulfilled' && Array.isArray(page.value) ? page.value : []);
    for (const row of rows) {
      const origin = streamOrigin(row).country;
      if (origin && origin !== countryCode(row.countrycode) && /^[a-f0-9-]{36}$/i.test(row.stationuuid)) {
        if (!discovered.has(origin)) discovered.set(origin, new Set());
        discovered.get(origin).add(row.stationuuid);
      }
    }
    rows.sort((a, b) => (Number(b.clickcount) || 0) - (Number(a.clickcount) || 0));
    return stationsForCountry(rows, code);
  }
  return code => {
    if (!/^[A-Z]{2}$/.test(code)) throw new Error('Invalid country');
    if (!pending.has(code)) pending.set(code, read(code).finally(() => pending.delete(code)));
    return pending.get(code);
  };
}
