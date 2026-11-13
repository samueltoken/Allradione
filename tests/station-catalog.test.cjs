const test = require('node:test');
const assert = require('node:assert/strict');
const {cleanStation, savedStations, stationsForCountry, createStationReader, countriesFromRows} = require('../electron/station-catalog.mjs');

const row = (changes = {}) => ({
  stationuuid: '12345678-0000-4444-8888-000000000000', name: 'Test', url: 'https://example.org/audio',
  countrycode: 'KR', tags: '', lastcheckok: 1, ...changes
});

test('operator comes from the stream; names, homepage, podcast and stored claims do not grant verification', () => {
  const s = cleanStation(row({name: 'KBS podcast', homepage: 'https://www.kbs.co.kr/', operatorName: 'KBS', operatorKind: 'broadcaster'}));
  assert.equal(s.operatorKind, 'unknown');
  assert.equal(s.operatorName, undefined);
  assert.equal(s.isPodcast, true);
  assert.equal(cleanStation(row({url: 'https://kbs.co.kr.example.org/audio'})).operatorKind, 'unknown');
  assert.equal(cleanStation(row({url: 'https://radio.bbc.co.uk/live', tags: 'podcast'})).operatorName, 'BBC');
  const creator = cleanStation(row({url: 'https://stream.laut.fm/example'}));
  assert.equal(creator.operatorKind, 'independent');
  assert.equal(creator.relayName, 'laut.fm');
  assert.equal(creator.operatorName, undefined);
  assert.equal(cleanStation(row({url:'https://stream.zeno.fm/example'})).operatorKind, 'unknown');
});

test('corrects North Korean programme origins without assigning foreign-language programmes by language', async () => {
  const relay = row({url: 'https://stream.intchoson.com/kcbs/main_stream.m3u8'});
  const foreign = row({stationuuid: 'two', name: 'Pyongyang stories', language: 'korean', countrycode: 'US'});
  const s = cleanStation(relay);
  assert.equal(s.countrycode, 'KP');
  assert.equal(s.operatorName, 'intchoson');
  assert.equal(s.programmeOriginName, '조선중앙방송');
  assert.equal(cleanStation(foreign).countrycode, 'US');
  assert.equal(cleanStation(row({url:'https://stream.zeno.fm/oldwnjuma3duv', countrycode:'KP'})).countrycode,'EE');
  const reused = cleanStation(row({name:'Голос Корей',url:'https://listen4.myradio24.com/60315',countrycode:'KP'}));
  assert.equal(reused.countrycode,'ZZ');
  assert.equal(reused.name,'EURORADIO');
  const read = createStationReader(async endpoint => endpoint.startsWith('stations/bycountrycodeexact/KR?') ? [relay] : []);
  assert.equal((await read('KP'))[0].stationuuid, relay.stationuuid);
  assert.ok(!(await read('KR')).some(item => item.stationuuid === relay.stationuuid));
});

test('canonical station keeps its first-party playback entry across old caches, duplicate favorites and third-party redirection', () => {
  const legacy = row({url: 'http://serpent0.duckdns.org:8088/kbsfm.pls', url_resolved: 'https://1fm.gscdn.kbs.co.kr/1fm_192_2.m3u8?expires=old'});
  const [s] = savedStations([legacy, {...legacy, stationuuid:'duplicate'}]);
  assert.equal(s.stationuuid, 'allradione-kbs-24');
  assert.equal(s.operatorKind, 'broadcaster');
  assert.equal(s.operatorName, 'KBS 한국방송');
  assert.equal(savedStations([legacy, s]).length, 1);
  assert.equal(stationsForCountry([legacy], 'KR').filter(item => item.stationuuid === s.stationuuid).length, 1);
  assert.equal(stationsForCountry([], 'KR').find(item=>item.stationuuid==='allradione-jtv-fm').operatorName,'JTV 전주방송');
  assert.ok(!s.url_resolved.includes('expires'));
  assert.equal(cleanStation({...s, url:'https://example.org/not-kbs'}), null);
});

test('country lists include later pages, preserve unknown country, isolate failure of supplemental UUID lookup', async () => {
  const calls = [];
  const read = createStationReader(async endpoint => {
    calls.push(endpoint);
    if (endpoint.startsWith('stations/byuuid?')) throw Error('Mirror timed out');
    const url = new URL('https://example.org/' + endpoint);
    const offset = Number(url.searchParams.get('offset'));
    const limit = Number(url.searchParams.get('limit'));
    return Array.from({length: offset === 0 ? limit : 1}, (_, i) => row({stationuuid: 'x' + (offset + i), countrycode:'DE'}));
  });
  const rows = await read('DE');
  assert.ok(rows.length > 2000 && calls.some(endpoint => endpoint.includes('offset=2000')));
  assert.equal(countriesFromRows([{name:'za',stationcount:1}, {name:'ZA',stationcount:2}]).find(c=>c.code==='ZA').stationcount, 3);
  assert.equal(cleanStation(row({countrycode:''})).countrycode, 'ZZ');
  assert.equal(stationsForCountry([row({lastcheckok:0})], 'US').length, 0);
});
