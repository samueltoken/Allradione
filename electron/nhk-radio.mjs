import { resolveKoreanStream } from './korean-stations.mjs';

// These are the same schedule and channel tables read by NHK's public radio player.
const liveTable = 'https://livepl-radio.nhkworld.jp/hlslive_radio.json';
const koreanPlayer = 'https://www3.nhk.or.jp/nhkworld/ko/radio/live/';
const legacyFeeds = /^https:\/\/master\.nhkworld\.jp\/nhkworld-radio\/playlist\/(gs2|rs[1245]|kai|sin)\/live\.m3u8$/;
const numberedFeed = /^https:\/\/(?:b-)?nhkworld-radio\.nhkworld\.jp\/hls\/live\/nhkworld-radio-media(\d{1,2})\/index\.m3u8$/;

export function correctNhkStation(station) {
  if (station.stationuuid === '9a6855fe-1c7f-422b-a4bc-f15af3b347ff' &&
      [koreanPlayer, 'https://master.nhkworld.jp/nhkworld-radio/playlist/rs1/live.m3u8'].includes(station.url)) {
    return { ...station, name: 'NHK WORLD · 한국어', countrycode: 'JP', operatorName: 'NHK', operatorKind: 'broadcaster',
      operatorSource: koreanPlayer, homepage: koreanPlayer, url: koreanPlayer, url_resolved: koreanPlayer, hls: 1 };
  }
  const current = numberedFeed.exec(station.url);
  if (current) return { ...station, name: 'NHK WORLD RADIO ' + Number(current[1]), hls: 1 };
  const legacy = legacyFeeds.exec(station.url);
  if (legacy) return { ...station, name: 'NHK WORLD · ' + legacy[1].toUpperCase() };
  return station;
}

async function readChannel(number, readText) {
  const table = JSON.parse(await readText(liveTable));
  const key = String(number).padStart(2, '0');
  return [...new Set([table.main?.[key], table.sub?.[key]])].filter(value => {
    if (typeof value !== 'string') return false;
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && !url.username && !url.password &&
        (url.hostname === 'nhkworld.jp' || url.hostname.endsWith('.nhkworld.jp'));
    } catch { return false; }
  });
}

export async function resolveStationStream(url, readText, now = Date.now()) {
  if (url === koreanPlayer) {
    const until = Math.floor(now / 1000) + 86400;
    const schedule = JSON.parse(await readText('https://api.nhkworld.jp/showsapi/v1/ko/audio_schedules?until=' + until));
    if (!Array.isArray(schedule.items)) throw new Error('Invalid NHK radio schedule');
    const shows = schedule.items.filter(item => item.lang === 'ko')
      .map(item => ({start: Date.parse(item.start_at), end: Date.parse(item.end_at), channel: item.channel?.out}))
      .filter(item => item.start < item.end && item.end > now && Number.isInteger(item.channel))
      .sort((a, b) => a.start - b.start);
    const playing = shows.find(show => show.start <= now);
    if (!playing) return { offAir: true, nextAt: shows[0]?.start };
    const [primary, backup] = await readChannel(playing.channel, readText);
    if (!primary) return { offAir: true, nextAt: shows.find(show => show.start > now)?.start };
    return { url: primary, backup, endsAt: playing.end };
  }
  const channel = numberedFeed.exec(url);
  if (channel) {
    // A directory's direct feed is still usable if NHK's lookup is temporarily down.
    try {
      const [primary, backup] = await readChannel(Number(channel[1]), readText);
      if (primary) return { url: primary, backup };
    } catch { /* Fall back to this exact output number's registered feed. */ }
    return url;
  }
  return resolveKoreanStream(url, readText);
}
