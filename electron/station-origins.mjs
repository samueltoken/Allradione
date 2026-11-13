import { networkOperator } from './network-operators.mjs';
import { broadcastRecords, broadcastDomains, broadcastStreams, broadcastProgrammes } from './broadcast-records.mjs';

// Broadcaster-controlled domains. Shared hosting/CDN parent domains do not
// belong in this table. See docs/station-classification.md for the sources.
const broadcasterSites = [
  ['AR','Radio Nacional Argentina','radionacional.com.ar'],
  ['AT','ORF','orf.at'],
  ['AU','Australian Broadcasting Corporation','abc.net.au abc-cdn.net.au'],
  ['AU','Special Broadcasting Service','sbs.com.au'],
  ['BB','Caribbean Broadcasting Corporation','cbc.bb'],
  ['BE','RTBF','rtbf.be'], ['BE','VRT','vrt.be'],
  ['BG','Bulgarian National Radio','bnr.bg'],
  ['BR','Empresa Brasil de Comunicação','ebc.com.br'],
  ['BS','Broadcasting Corporation of The Bahamas','znsbahamas.com'],
  ['CA','CBC/Radio-Canada','cbc.ca radio-canada.ca'],
  ['CH','SRG SSR','srg-ssr.ch'], ['CH','Radio Télévision Suisse','rts.ch'],
  ['CH','Schweizer Radio und Fernsehen','srf.ch'], ['CH','Radiotelevisione svizzera','rsi.ch'],
  ['CN','China National Radio','cnr.cn'], ['CN','China Radio International','cri.cn'], ['CN','CCTV','cctv.com'],
  ['CY','Cyprus Broadcasting Corporation','cybc.com.cy'], ['CZ','Český rozhlas','rozhlas.cz radio.cz'],
  ['DE','Deutschlandradio','deutschlandradio.de dlf.de dradio.de'], ['DE','Bayerischer Rundfunk','br.de'],
  ['DE','Hessischer Rundfunk','hr.de'], ['DE','Mitteldeutscher Rundfunk','mdr.de'], ['DE','Norddeutscher Rundfunk','ndr.de'],
  ['DE','Rundfunk Berlin-Brandenburg','rbb-online.de rbb24.de'], ['DE','Saarländischer Rundfunk','sr.de'],
  ['DE','Südwestrundfunk','swr.de'], ['DE','Westdeutscher Rundfunk','wdr.de'],
  ['DE','RADIO BOB!','radiobob.de'], ['DE','RPR1.','rpr1.de'], ['DE','bigFM','bigfm.de'], ['DE','Radio Regenbogen','regenbogen.de'],
  ['DE','90s90s Radio','90s90s.de'], ['DE','80s80s Radio','80s80s.de'], ['DE','SUNSHINE LIVE','sunshine-live.de'],
  ['DE','ANTENNE BAYERN','antenne.de'], ['DE','ROCK ANTENNE','rockantenne.de'], ['DE','HIT RADIO FFH','ffh.de'],
  ['DE','harmony','harmonyfm.de'], ['DE','Klassik Radio','klassikradio.de'], ['DE','FluxFM','fluxfm.de'],
  ['DK','DR','dr.dk'], ['DZ','Radio Algérienne','radioalgerie.dz'], ['EE','Eesti Rahvusringhääling','err.ee'],
  ['ES','RTVE','rtve.es'], ['FI','Yle','yle.fi'], ['FR','Radio France','radiofrance.fr francebleu.fr'],
  ['FR','Radio France Internationale','rfi.fr'], ['GB','BBC','bbc.co.uk bbci.co.uk bbcmedia.co.uk'],
  ['GR','ERT','ert.gr'], ['HK','Radio Television Hong Kong','rthk.hk'], ['HR','Hrvatska radiotelevizija','hrt.hr'],
  ['ID','Radio Republik Indonesia','rri.co.id'], ['IE','RTÉ','rte.ie'], ['IN','Prasar Bharati','prasarbharati.gov.in allindiaradio.gov.in'],
  ['IS','RÚV','ruv.is'], ['IT','RAI','rai.it raiplayradio.it'], ['JP','NHK','nhk.or.jp nhkworld.jp'],
  ['KE','Kenya Broadcasting Corporation','kbc.go.ke kbc.co.ke'], ['KP','조선의 소리','vok.rep.kp'],
  ['KR','KBS 한국방송','kbs.co.kr'], ['KR','MBC 문화방송','imbc.com'], ['KR','SBS','sbs.co.kr'],
  ['KR','YTN 라디오','ytn.co.kr'], ['KR','EBS 한국교육방송공사','ebs.co.kr'], ['KR','CBS 기독교방송','cbs.co.kr'],
  ['KR','가톨릭평화방송','cpbc.co.kr'], ['KR','OBS 경인TV','obs.co.kr'], ['KR','안동MBC','andongmbc.co.kr'],
  ['KR','MBC충북','mbccb.co.kr'], ['KR','TBS','tbs.seoul.kr'], ['KR','TBN 한국교통방송','tbn.or.kr'],
  ['KR','국방홍보원','dema.mil.kr'], ['KR','경인방송','ifm.kr'], ['KR','마포FM','mapofm.net'],
  ['KR','극동방송','febc.net'],
  ['LT','LRT','lrt.lt'], ['LV','Latvijas Sabiedriskais medijs','lsm.lv latvijasradio.lv'],
  ['MA','SNRT','snrt.ma'], ['MS','ZJB Radio Montserrat','zjbradio.com'], ['MY','Radio Televisyen Malaysia','rtm.gov.my'],
  ['NL','Nederlandse Publieke Omroep','npo.nl'], ['NO','NRK','nrk.no'], ['NZ','Radio New Zealand','rnz.co.nz radionz.co.nz'],
  ['PK','Pakistan Broadcasting Corporation','radio.gov.pk pbc.gov.pk'], ['PL','Polskie Radio','polskieradio.pl'],
  ['PT','Rádio e Televisão de Portugal','rtp.pt'], ['RO','Radio România','radioromania.ro'], ['RS','Radio-televizija Srbije','rts.rs'],
  ['SE','Sveriges Radio','sverigesradio.se sr.se'], ['SI','Radiotelevizija Slovenija','rtvslo.si'], ['SK','STVR','stvr.sk rtvs.sk'],
  ['TT','Caribbean Communications Network','tv6tnt.com'], ['TW','Radio Taiwan International','rti.org.tw'],
  ['UA','Суспільне Мовлення','suspilne.media'], ['US','NPR','npr.org'], ['US','New York Public Radio','wnyc.org'],
  ['US','GBH','wgbh.org'], ['US','KEXP','kexp.org'], ['US','Chicago Public Media','wbez.org'],
  ['US','Minnesota Public Radio','mpr.org'], ['US','American Public Media','publicradio.org'],
  ['VA','Vatican Radio','vaticannews.va'], ['VN','Voice of Vietnam','vov.gov.vn vovgiaothong.vn'],
  ['ZA','South African Broadcasting Corporation','sabc.co.za channelafrica.co.za']
];

const owners = new Map();
for (const [country, operatorName, domains] of broadcasterSites) {
  const roots = domains.split(' ');
  for (const root of roots) owners.set(root, { country, kind: 'broadcaster', operatorName, operatorSource: 'https://' + roots[0] + '/' });
}

for (const [domain, relayName, operatorSource] of [
  ['laut.fm', 'laut.fm', 'https://laut.fm/pages/apply'],
  ['inlive.co.kr', '인라이브', 'https://www.inlive.co.kr/customer/faq'],
  ['sayclub.com', '세이클럽', 'https://me.sayclub.com/']
]) owners.set(domain, { kind: 'independent', relayName, operatorSource });

for (const [domain, country, operatorName, operatorSource] of [
  ['somafm.com','US','SomaFM','https://somafm.com/about/'],
  ['radioparadise.com','US','Radio Paradise','https://radioparadise.com/'],
  ['bigbradio.net','','Big B Radio','https://bigbradio.net/about']
]) owners.set(domain, { country, kind: 'independent', operatorName, operatorSource });

function parseAddress(value) {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url : null;
  } catch { return null; }
}

function recordEvidence(id, programmeOnly = false) {
  const [country, operatorName, programmeOriginName] = broadcastRecords[id];
  const reference = { operatorSource: 'https://www.wikidata.org/wiki/' + id };
  return programmeOnly ? { ...reference, programmeOriginName }
    : { ...reference, country, kind: 'broadcaster', operatorName };
}

const relays = new Map([
  ['streamtheworld.com','Triton Digital / StreamTheWorld'], ['zeno.fm','Zeno.FM'],
  ['radio.co','Radio.co'], ['live365.com','Live365'], ['radioking.com','RadioKing'],
  ['radiojar.com','Radiojar'], ['streamguys1.com','StreamGuys'], ['streamguys.com','StreamGuys'],
  ['infomaniak.ch','Infomaniak'], ['myradio24.com','MyRadio24'], ['myradio24.org','MyRadio24']
]);

export function streamOrigin(station) {
  const url = parseAddress(station.url_resolved || station.url);
  if (!url) return {};
  const network = networkOperator(station);
  if (network) return network;
  const directRecord = broadcastStreams[url.href];
  if (directRecord) return recordEvidence(directRecord);
  let host = url.hostname.toLowerCase().replace(/\.$/, '');
  const path = url.pathname;
  if (host === 'jtvonair.sbsoft.net' && path === '/jtv_radio/myStream/playlist.m3u8') {
    return { country: 'KR', kind: 'broadcaster', operatorName: 'JTV 전주방송', operatorSource: 'https://www.jtv.co.kr/page/00029.php' };
  }
  if (host === 'mgugaklive.nowcdn.co.kr' && /^\/gugak(radio|video)\/gugak\1\.stream\/(?:playlist|chunklist_\w+)\.m3u8$/.test(path)) {
    return { country: 'KR', kind: 'broadcaster', operatorName: '국악방송', operatorSource: 'https://www.igbf.kr/gugak_web/main/' };
  }
  if ((host === 'audio.yojosuknam.com' && path === '/radio/live.m3u8') ||
      (host === 'stream.yojosuknam.com' && path === '/live.mp3')) {
    return { kind: 'independent', operatorName: 'yojosuknam', operatorSource: 'https://music.yojosuknam.com/radio/' };
  }
  if (host === 's10.webradio-hosting.com' && /^\/proxy\/fredradio(bg|cz|dk|ec|edu|en|ge|gr|hr|hu|ind|is|it|lt|lv|nl|po|pt|ru|sar|si|sk|sp)\/stream$/.test(path)) {
    return { country: 'GB', kind: 'independent', operatorName: 'FRED Film Radio', operatorSource: 'https://www.fred.fm/' };
  }
  if (host === 's10.webradio-hosting.com' && path === '/proxy/fredradiokr/stream' &&
      /^fred film radio/i.test(station.name) && /^(www\.)?fred\.fm$/.test(parseAddress(station.homepage)?.hostname || '')) {
    return { country: 'GB', programmeOriginName: 'FRED Film Radio', operatorSource: 'https://www.fred.fm/radiochannel/' };
  }
  if (host === 'stream.intchoson.com' && /^\/(kcbs|vok|kctv)\//.test(path)) {
    // The programmes originate in Pyongyang. Japanese volunteers operate the relay.
    const programmeOriginName = { kcbs: '조선중앙방송', vok: '조선의 소리', kctv: '조선중앙TV' }[path.split('/')[1]];
    return { country: 'KP', kind: 'independent', operatorName: 'intchoson', programmeOriginName, operatorSource: 'https://www.intchoson.com/' };
  }
  if (host === 'antares.dribbcast.com' && /^\/proxy\/(kpop|jpop|cpop|apop)(\/|$)/.test(path)) {
    return { kind: 'independent', operatorName: 'Big B Radio', relayName: 'Dribbcast', operatorSource: 'https://bigbradio.net/servers' };
  }
  if (host === 's5.radio.co' && path === '/s0a9796fe3/listen' &&
      station.stationuuid === '54ac5316-5788-452f-a15b-5a53c79d0375') {
    // AM1660's US service is listed in KR. The station's present player uses
    // another address, so this older third-party feed has unconfirmed ownership.
    return { country: 'US', programmeOriginName: 'K-RADIO AM1660', relayName: 'Radio.co', operatorSource: 'https://kradio.us/about-us/' };
  }
  const evidence = {};
  while (host.includes('.')) {
    const owner = owners.get(host);
    if (owner) return owner;
    const record = broadcastDomains[host];
    if (record) return recordEvidence(record);
    if (relays.has(host)) evidence.relayName = relays.get(host);
    host = host.slice(host.indexOf('.') + 1);
  }
  const programme = broadcastProgrammes[station.stationuuid];
  if (Array.isArray(programme) && station.name === programme[2] &&
      parseAddress(station.homepage)?.hostname.toLowerCase().replace(/^www\./, '') === programme[1]) {
    Object.assign(evidence, recordEvidence(programme[0], true));
  }
  return evidence;
}

// Old saved Korean stations contain already expired signed URLs. Map the actual
// station-specific broadcast endpoints to the matching first-party live player.
const koreanChannelHosts = new Map([
  ['1fm.gscdn.kbs.co.kr','kbs-24'], ['2fm-ad.gscdn.kbs.co.kr','kbs-25'],
  ['1radio-bora.gscdn.kbs.co.kr','kbs-21'], ['2radio-bora.gscdn.kbs.co.kr','kbs-22']
]);
export function koreanChannelAlias(station) {
  const url = parseAddress(station.url_resolved || station.url);
  if (!url) return;
  const oldJtv = parseAddress(station.url);
  if (oldJtv?.hostname === '61ff3340258d2.streamlock.net' && /^\/jtv_radio\/myStream\/(playlist|chunklist_\w+)\.m3u8$/.test(oldJtv.pathname)) return 'jtv-fm';
  const alias = koreanChannelHosts.get(url.hostname);
  if (alias && url.pathname.endsWith('.m3u8')) return alias;
  const mbc = /^mini[smc]w\.imbc\.com$/.test(url.hostname) &&
    /^\/d(sfm|mfm|chm)\/_definst_\/\1\.stream\//.exec(url.pathname);
  if (mbc) return 'mbc-' + mbc[1];
  const sbs = url.hostname === 'radiolive.sbs.co.kr' &&
    /^\/(love|power)pc\/\1fm\.stream\//.exec(url.pathname);
  if (sbs) return 'sbs-' + sbs[1];
  if (url.hostname === 'radiolive.ytn.co.kr' && url.pathname === '/radio/_definst_/20211118_fmlive/playlist.m3u8') return 'ytn-fm';
}
