// Store official player entry points in favorites. KBS, MBC and SBS issue
// short-lived media addresses, so resolve them again whenever playback starts.
const channels = [
  ...[['21', '1라디오'], ['22', '2라디오'], ['23', '3라디오'], ['24', '클래식FM'], ['25', '쿨FM'], ['26', '한민족방송']].map(([code, name]) => ({
    id: 'kbs-' + code, name: 'KBS ' + name, network: 'kbs',
    homepage: 'https://onair.kbs.co.kr/index.html?sname=onair&stype=live&ch_code=' + code,
    url: 'https://cfpwwwapi.kbs.co.kr/api/v1/landing/live/channel_code/' + code
  })),
  ...[['sfm', '표준FM'], ['mfm', 'FM4U'], ['chm', '올댓뮤직']].map(([code, name]) => ({
    id: 'mbc-' + code, name: 'MBC ' + name, network: 'mbc',
    homepage: 'https://mini.imbc.com/index_v3.html?channel=' + code,
    url: 'https://sminiplay.imbc.com/aacplay.ashx?agent=webapp&channel=' + code
  })),
  ...[['power', '파워FM'], ['love', '러브FM']].map(([code, name]) => ({
    id: 'sbs-' + code, name: 'SBS ' + name, network: 'sbs',
    homepage: 'https://web.gorealra.sbs.co.kr/',
    url: 'https://apis.sbs.co.kr/play-api/1.0/livestream/' + code + 'pc/' + code + 'fm?protocol=hls&ssl=Y'
  })),
  { id: 'ytn-fm', name: 'YTN 뉴스FM', network: 'ytn', homepage: 'https://radio.ytn.co.kr/',
    url: 'https://radiolive.ytn.co.kr/radio/_definst_/20211118_fmlive/playlist.m3u8' },
  { id: 'jtv-fm', name: 'JTV 매직FM', network: 'jtv', homepage: 'https://www.jtv.co.kr/page/00029.php',
    url: 'https://jtvonair.sbsoft.net/jtv_radio/myStream/playlist.m3u8' }
];

export const koreanStations = channels.map(channel => ({
  stationuuid: 'allradione-' + channel.id, name: channel.name,
  url: channel.url, url_resolved: channel.url, homepage: channel.homepage,
  countrycode: 'KR', language: 'korean', favicon: '', tags: '', codec: 'AAC',
  hls: 1, bitrate: 0, lastcheckok: 1, votes: 0, operatorKind: 'broadcaster'
}));

const byUrl = new Map(channels.map(channel => [channel.url, channel]));
export function isKoreanBroadcasterStation(station) {
  const channel = byUrl.get(station.url);
  return !!channel && station.stationuuid === 'allradione-' + channel.id &&
    station.name === channel.name && (!station.url_resolved || station.url_resolved === channel.url);
}

export async function resolveKoreanStream(url, readText) {
  const channel = byUrl.get(url);
  if (!channel || ['ytn', 'jtv'].includes(channel.network)) return url;
  const body = await readText(url);
  let result = body.trim();
  if (channel.network === 'kbs') {
    const rows = JSON.parse(body).channel_item;
    result = rows?.find(row => row.media_type === 'radio' && row.channel_code === channel.id.slice(4))?.service_url;
  }
  const media = new URL(result);
  const domain = { kbs: 'kbs.co.kr', mbc: 'imbc.com', sbs: 'sbs.co.kr' }[channel.network];
  if (media.protocol !== 'https:' || media.username || media.password ||
      !(media.hostname === domain || media.hostname.endsWith('.' + domain))) {
    throw new Error('방송사의 재생 주소를 확인할 수 없습니다.');
  }
  return media.href;
}
