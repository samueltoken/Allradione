// Shared hosts can carry unrelated stations. Match only published channels.
// The official player pages and the independently identified relays are
// documented in docs/network-operators.md.
const mounts = new Map();

function addMounts(record, addresses) {
  for (const address of addresses) mounts.set(address, record);
}

const arirang = { country:'KR', kind:'broadcaster', operatorName:'아리랑국제방송 · 국제방송교류재단',
  operatorSource:'https://www.arirang.com/radio', relayName:'Akamai' };
for (const host of ['amdlive-ch03-ctnd-com.akamaized.net', 'amdlive.ctnd.com.edgesuite.net']) {
  addMounts(arirang, ['playlist.m3u8','chunklist_b3256000_sleng.m3u8'].map(file =>
    host + '/arirang_3ch/smil:arirang_3ch.smil/' + file));
}
addMounts(arirang, ['amdlive-ch03-ctnd-com.akamaized.net/arirang_3ch/arirang_3ch_audio/chunklist_b128000.m3u8']);

addMounts({country:'KR',kind:'broadcaster',operatorName:'사단법인 전주공동체라디오',operatorSource:'https://jcfm.kr/'},
  ['radiostream.communityradio.kr/jcfm1']);
addMounts({country:'KR',kind:'broadcaster',operatorName:'안동MBC',operatorSource:'https://andongmbc.co.kr/main/onair/live_am.php'},
  ['andong.webcasting.co.kr:1935/live/amlive/playlist.m3u8', 'live.andongmbc.co.kr/live/amlive/playlist.m3u8']);
addMounts({country:'KR',kind:'broadcaster',operatorName:'부산글로벌도시재단 · 부산영어방송',
  operatorSource:'https://www.befm.or.kr/aod/live.php',relayName:'SmileCDN'}, [
  'befm905.live.smilecdn.com:1935/befm905_live/live/playlist.m3u8',
  'live.cdn.smilecdn.com/befm905_live/live/playlist.m3u8'
]);

for (const [prefix, operatorName, operatorSource] of [
  ['fmsetagaya834','株式会社世田谷サービス公社 · FM世田谷','https://fmsetagaya.com/archives/10064'],
  ['shonanbeachfm','逗子・葉山コミュニティ放送株式会社 · 湘南ビーチFM','https://www.beachfm.co.jp/about/help/']
]) {
  const record = {country:'JP',kind:'broadcaster',operatorName,operatorSource,relayName:'Airtime Pro'};
  for (const port of ['',':8000']) {
    addMounts(record, ['a','b','c'].map(channel => prefix + '.out.airtime.pro' + port + '/' + prefix + '_' + channel));
  }
}
addMounts({country:'JP',kind:'broadcaster',operatorName:'特定非営利活動法人 FMかほく',operatorSource:'https://fm.kahoku.net/annai/'},
  ['radio.kahoku.net:8000/','radio.kahoku.net:8000/;','radio.kahoku.net:8443/;']);
addMounts({country:'JP',kind:'independent',operatorName:'NFRSメディアコミュニケーションズ',
  operatorSource:'https://www.nfrsradio.com/about'}, ['securestreams.autopo.st:2592/stream']);
addMounts({country:'JP',kind:'independent',operatorName:'特定非営利活動法人 エフエムわいわい',
  operatorSource:'https://tcc117.jp/fmyy/company/'}, ['tcc117.jp/fmyy/asx/simulbroadcast.mp3']);

const replayNews = {country:'FR',kind:'broadcaster',operatorName:'CONTROL CHANNEL · Groupe Radio Public Santé',
  relayName:'Infomaniak',operatorSource:'https://www.replaynews.net/mentions-legales.php'};
addMounts(replayNews, ['replaynews.ice.infomaniak.ch/replaynews-192.mp3']);
for (const edition of ['eco','story','sport','en','es','it','pt','zh','ja','de','ar','ru','tr','nl','pl','gr','hi','in','ve','ro','kr','sw','se','fi','uk','hr']) {
  const station = 'replaynews' + edition;
  addMounts(replayNews, [station + '.ice.infomaniak.ch/' + station + '-128.mp3']);
}

const asiaDream = {kind:'independent',operatorName:'asia DREAM radio',relayName:'TorontoCast',
  operatorSource:'https://asiadreamradio.torontocast.stream/stations/newstream.html'};
for (const host of ['kathy.torontocast.com:3060','kathy.torontocast.com:3330','kathy.torontocast.com:3340',
  'kathy.torontocast.com:3350','kathy.torontocast.com:3560','quincy.torontocast.com:2020','quincy.torontocast.com:2070']) {
  // These are dedicated ports. /;, /stream, and /stream/1/ are SHOUTcast's
  // root stream and station 1; do not claim a second station on the same port.
  addMounts(asiaDream, ['/','/;','/stream','/stream/1/','/stream.mp3'].map(path => host + path));
}

const bbcServices = new Set([
  'bbc_1xtra','bbc_6music','bbc_asian_network','bbc_london','bbc_tees','bbc_wm',
  'bbc_radio_berkshire','bbc_radio_bristol','bbc_radio_cambridge','bbc_radio_cornwall',
  'bbc_radio_coventry_warwickshire','bbc_radio_cumbria','bbc_radio_cymru','bbc_radio_cymru_2',
  'bbc_radio_derby','bbc_radio_devon','bbc_radio_essex','bbc_radio_five_live','bbc_radio_five_live_sports_extra',
  'bbc_radio_four_extra','bbc_radio_fourfm','bbc_radio_fourlw','bbc_radio_foyle','bbc_radio_gloucestershire',
  'bbc_radio_guernsey','bbc_radio_hereford_worcester','bbc_radio_humberside','bbc_radio_jersey','bbc_radio_kent',
  'bbc_radio_lancashire','bbc_radio_leeds','bbc_radio_leicester','bbc_radio_lincolnshire','bbc_radio_manchester',
  'bbc_radio_merseyside','bbc_radio_nan_gaidheal','bbc_radio_newcastle','bbc_radio_norfolk','bbc_radio_northampton',
  'bbc_radio_one','bbc_radio_one_dance','bbc_radio_one_relax','bbc_radio_orkney','bbc_radio_oxford',
  'bbc_radio_scotland_fm','bbc_radio_scotland_mw','bbc_radio_sheffield','bbc_radio_shropshire','bbc_radio_solent',
  'bbc_radio_solent_west_dorset','bbc_radio_somerset_sound','bbc_radio_stoke','bbc_radio_suffolk',
  'bbc_radio_surrey','bbc_radio_sussex','bbc_radio_three','bbc_radio_two','bbc_radio_ulster',
  'bbc_radio_wales_fm','bbc_radio_wiltshire','bbc_radio_york'
]);

export function broadcasterPlayer(url) {
  const key = url.host.toLowerCase() + url.pathname;
  const record = mounts.get(key);
  if (record) {
    if (!url.search) return record;
    if (record === asiaDream && [...url.searchParams.keys()].every(k => ['shoutcast','type','nocache'].includes(k))) return record;
    if (key === 'securestreams.autopo.st:2592/stream' && /^\?t=\d+$/.test(url.search)) return record;
    return;
  }
  if (url.search) return;
  if (['211.33.246.4:32954', 'mbccbp.coreit.co.kr'].includes(url.host) &&
      /^\/radio_(?:stfm|fm)\/myStream\.sdp\/(?:playlist|chunklist_w\d+)\.m3u8$/.test(url.pathname)) {
    return {country:'KR',kind:'broadcaster',operatorName:'MBC충북',operatorSource:'https://mbccb.co.kr/rb/custom/onair2.php?md=fm1'};
  }
  if (url.host === 'as-hls-ww-live.akamaized.net') {
    const match = /^\/pool_\d+\/live\/ww\/(bbc_[a-z0-9_]+)\/\1\.isml\/(?:dash\/)?\1-audio(?:=|%3d)(?:48000|96000|128000|320000)(?:\.norewind)?\.m3u8$/i.exec(url.pathname);
    if (match && bbcServices.has(match[1])) return {country:'GB',kind:'broadcaster',operatorName:'BBC',
      operatorSource:'https://www.bbc.co.uk/sounds/play/live/' + match[1],relayName:'Akamai'};
  }
}
