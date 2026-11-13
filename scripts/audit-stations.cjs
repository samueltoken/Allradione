'use strict';
// Usage: node scripts/audit-stations.cjs <Radio Browser /json/stations snapshot> <results.ndjson>
// Stores only identifiers, outcomes and times. Never saves the received broadcast.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { requestPublic, validateUrl } = require('../electron/network.cjs');

function hashUrl(url) {
  return crypto.createHash('sha256').update(url).digest('hex');
}

function stationUrl(raw) {
  try {
    const u = validateUrl(raw);
    if (!u.hostname.includes('.') && !u.hostname.includes(':')) return null;
    // Common non-media destinations occasionally submitted as "stations".
    if (/(?:^|\.)(?:youtube(?:-nocookie)?\.com|youtu\.be|facebook\.com|instagram\.com|twitter\.com|x\.com|tiktok\.com|github\.com|spotify\.com|twitch\.tv|vimeo\.com|telegram\.me|t\.me|soundcloud\.com|google\.com|amazon\.com)$/i.test(u.hostname)) return null;
    if (/\.(?:html?|rss|css|js|jpe?g|png|gif|exe|zip|pdf|apk)(?:$|\/)/i.test(u.pathname)) return null;
    u.hash = '';
    return u.href;
  } catch { return null; }
}

function identify(bytes) {
  const head = bytes.toString('latin1', 0, 64);
  if (/^OggS|^fLaC|^RIFF.{4}WAVE|^FORM.{4}AIFF/s.test(head)) return 'media';
  if (['ftyp', 'styp', 'moof', 'sidx', 'moov'].includes(head.slice(4, 8))) return 'media';
  if (bytes.length > 376 && bytes[0] === 0x47 && bytes[188] === 0x47 && bytes[376] === 0x47) return 'media';
  if (/^\s*(?:<!doctype\s+html|<html|<head|<body|<\?xml)/i.test(head)) return 'webpage';
  if (/^\s*(?:#EXTM3U|\[playlist\]|https?:\/\/)/i.test(head)) return 'playlist';
  // Starts of MP3 and ADTS frames can fall inside the first network chunk of a live stream.
  for (let i = 0; i + 4 < bytes.length; i++) {
    if (bytes[i] !== 0xff || (bytes[i + 1] & 0xe0) !== 0xe0) continue;
    const h = bytes[i + 1], k = bytes[i + 2];
    if ((h & 0xf6) === 0xf0 && ((k >> 2) & 15) < 13) {
      const size = ((bytes[i + 3] & 3) << 11) | (bytes[i + 4] << 3) | (bytes[i + 5] >> 5);
      if (size > 6 && i + size + 1 < bytes.length && bytes[i + size] === 0xff && (bytes[i + size + 1] & 0xf6) === 0xf0) return 'media';
    }
    const version = (h >> 3) & 3, layer = (h >> 1) & 3, kb = k >> 4, rate = (k >> 2) & 3;
    if (version === 1 || layer !== 1 || kb === 0 || kb === 15 || rate === 3) continue;
    const bitrate = (version === 3 ? [0,32,40,48,56,64,80,96,112,128,160,192,224,256,320] : [0,8,16,24,32,40,48,56,64,80,96,112,128,144,160])[kb];
    const sampleRate = [44100,48000,32000][rate] / (version === 3 ? 1 : version === 2 ? 2 : 4);
    const size = Math.floor((version === 3 ? 144000 : 72000) * bitrate / sampleRate) + ((k >> 1) & 1);
    if (i + size + 1 < bytes.length && bytes[i + size] === 0xff && (bytes[i + size + 1] & 0xfe) === (h & 0xfe)) return 'media';
  }
  return null;
}

async function inspectStream(raw, depth = 0) {
  if (depth > 4) return 'playlist-unconfirmed';
  const url = stationUrl(raw);
  if (!url) return 'ineligible';
  const signal = AbortSignal.timeout(9000);
  let response;
  try {
    const result = await requestPublic(url, { signal, timeout: 7000, redirects: 5, allowIcy: true });
    response = result.response;
    if (response.statusCode < 200 || response.statusCode >= 300) return 'http-' + response.statusCode;
    const mime = String(response.headers['content-type'] || '');
    if (/text\/html/i.test(mime)) return 'webpage';
    const chunks = [];
    let size = 0, kind;
    for await (const chunk of response) {
      const part = chunk.subarray(0, 32768 - size);
      chunks.push(part);
      size += part.length;
      const bytes = Buffer.concat(chunks, size);
      kind = identify(bytes);
      if (kind === 'media' || kind === 'webpage') return kind;
      if (kind !== 'playlist' && size >= 8192) break;
      if (size >= 32768) break;
    }
    if (!size) return 'empty';
    if (kind !== 'playlist') return 'unrecognized';
    const playlist = Buffer.concat(chunks).toString('utf8').trim();
    const lines = playlist.split(/\r?\n/).map(line => line.trim());
    const audio = lines.find(line => /^#EXT-X-MEDIA:.*TYPE=AUDIO(?:,|$)/i.test(line))?.match(/URI="([^"]+)"/)?.[1];
    const files = lines.filter(line => line && !line.startsWith('#') && !line.startsWith('['));
    const pls = files.find(line => /^File\d+=/i.test(line))?.replace(/^File\d+=/i, '');
    const target = audio || pls || files[0];
    if (!target || /^(?:[a-z]+:)?\/\//i.test(target) && !/^https?:/i.test(target) && !target.startsWith('//')) return 'playlist-unconfirmed';
    response.destroy();
    const child = await inspectStream(new URL(target, result.url).href, depth + 1);
    return child === 'media' ? 'media' : child.startsWith('playlist-') ? child : 'playlist-' + child;
  } catch (error) {
    if (signal.aborted || /timed out/i.test(error.message)) return 'timeout';
    if (/private address|Local network addresses|public HTTP/.test(error.message)) return 'ineligible';
    if (error.code === 'HPE_INVALID_CONSTANT' && error.rawPacket?.subarray(0,4).toString('ascii') === 'ICY ') return 'legacy-icy';
    if (/CERT|SSL|TLS|VERIFY_LEAF|SELF_SIGNED|ISSUER/.test(error.code || '')) return 'tls-error';
    return ['ENOTFOUND', 'ECONNREFUSED', 'ECONNRESET', 'ENETUNREACH', 'EHOSTUNREACH', 'ETIMEDOUT'].includes(error.code) ? error.code : 'connection-error';
  } finally { response?.destroy(); }
}

function groupUrls(stations) {
  const groups = new Map();
  for (const station of stations) {
    // For previously unchecked entries require a recognizable broadcast path before opening a URL.
    const raw = station.url_resolved || station.url;
    const url = stationUrl(raw);
    const knownStream = station.codec && station.codec !== 'UNKNOWN' || station.hls === 1 || /(?:stream|live|radio|listen|\.mp3|\.aac|\.m3u|\.pls)/i.test(raw);
    const key = url && knownStream ? url : '';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(station);
  }
  return groups;
}

async function audit(snapshot, output) {
  const stations = JSON.parse(fs.readFileSync(snapshot, 'utf8'));
  const groups = groupUrls(stations);
  const done = new Set();
  if (fs.existsSync(output)) {
    for (const line of fs.readFileSync(output, 'utf8').split(/\r?\n/).filter(Boolean)) done.add(JSON.parse(line).key);
  }
  const stream = fs.openSync(output, 'a');
  function record(url, entries, outcome) {
    fs.writeSync(stream, JSON.stringify({key: hashUrl(url), ids: entries.map(s => s.stationuuid), outcome, time: new Date().toISOString()}) + '\n');
  }
  const seenCountries = new Set(), tasks = [];
  for (const [url, entries] of groups) {
    if (done.has(hashUrl(url))) continue;
    if (!url) { record(url, entries, 'ineligible'); continue; }
    const country = entries[0].countrycode;
    const priority = seenCountries.has(country) ? ['KP','KR'].includes(country) ? 1 : 2 : 0;
    seenCountries.add(country);
    tasks.push({url, entries, priority});
  }
  tasks.sort((a,b) => a.priority - b.priority);
  const queues = new Map();
  for (const task of tasks) {
    const host = new URL(task.url).hostname;
    if (!queues.has(host)) queues.set(host, []);
    queues.get(host).push(task);
  }
  // A station's server gets at most two listeners. Two multi-station delivery
  // networks host thousands of independent streams and can share six listeners.
  const sharedNetworks = new Set(['stream.zeno.fm', 'playerservices.streamtheworld.com']);
  const hostList = [...queues.keys()].sort((a,b) => queues.get(a)[0].priority - queues.get(b)[0].priority ||
    queues.get(b).length - queues.get(a).length);
  const lanes = hostList.flatMap(host => Array(Math.min(queues.get(host).length, sharedNetworks.has(host) ? 6 : 2)).fill(host));
  let nextLane = 0, finished = 0;
  async function worker() {
    while (nextLane < lanes.length) {
      const queue = queues.get(lanes[nextLane++]);
      while (queue.length) {
        const task = queue.shift();
        const outcome = await inspectStream(task.url);
        record(task.url, task.entries, outcome);
        if (++finished % 1000 === 0) console.log(finished + ' / ' + tasks.length);
      }
    }
  }
  try { await Promise.all(Array.from({length: 64}, worker)); }
  finally { fs.closeSync(stream); }
}

if (require.main === module) {
  if (process.argv.length !== 4) throw new Error('Usage: node ' + path.basename(__filename) + ' <stations.json> <results.ndjson>');
  audit(process.argv[2], process.argv[3]).catch(error => { console.error(error); process.exitCode = 1; });
}
module.exports = { inspectStream, identify, stationUrl, groupUrls };
