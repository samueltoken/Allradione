const test = require('node:test');
const assert = require('node:assert/strict');
const { identify, stationUrl } = require('../scripts/audit-stations.cjs');
const { isPlaybackAddress, isAvailableStation, addressSignature } = require('../electron/station-health.mjs');
const { checkedAt, failedStationAddresses } = require('../electron/station-health-results.mjs');

test('directory failure and invalid URLs stay out of the station catalog', () => {
  const good = 'https://example.org/live.mp3';
  for (const input of ['file:///test', 'http://127.1/a', 'http://[::1]/', 'http://host.local./a', 'https://a:b@example.org/live']) {
    assert.equal(isPlaybackAddress(input), false, input);
  }
  assert.equal(isAvailableStation({url: good, lastcheckok: 0}), false);
  assert.equal(isAvailableStation({url: good, url_resolved: 'garbled', lastcheckok: 1}), true);
  assert.equal(isAvailableStation({url: 'http://localhost/a', lastcheckok: 1}), false);
});
test('live audit distinguishes several classes of response before counting a broadcast', () => {
  assert.equal(identify(Buffer.from('<html>error</html>')), 'webpage');
  assert.equal(identify(Buffer.from('#EXTM3U\n#EXTINF:5,\nstream.aac\n')), 'playlist');
  assert.equal(identify(Buffer.from('OK')), null);
  const media = Buffer.alloc(1800);
  media.set([0xff, 0xfb, 0x90, 0x64], 5);
  media.set([0xff, 0xfb, 0x90, 0x64], 422);
  assert.equal(identify(media), 'media');
  media[422] = 0;
  assert.equal(identify(media), null);
  assert.equal(stationUrl('https://www.youtube.com/watch?v=123'), null);
  assert.equal(stationUrl('https://www.example.org/live.mp3'), 'https://www.example.org/live.mp3');
});
test('a new URL or positive check supersedes a dated failure even before its seven-day expiry', () => {
  const station = {stationuuid: 'test-observation', url: 'https://example.org/old', lastcheckok: 1};
  const time = Date.parse(checkedAt);
  failedStationAddresses[station.stationuuid] = addressSignature(station);
  try {
    assert.equal(isAvailableStation(station, time + 1000), false);
    assert.equal(isAvailableStation({...station, url: 'https://example.org/new'}, time + 1000), true);
    assert.equal(isAvailableStation({...station, lastchecktime_iso8601: new Date(time + 1).toISOString()}, time + 1000), true);
    assert.equal(isAvailableStation(station, time + 8 * 86400000), true);
  } finally { delete failedStationAddresses[station.stationuuid]; }
});

test('catalog downranks the audited address and a successful local playback restores it', () => {
  const fs = require('node:fs'), vm = require('node:vm'), ts = require('typescript');
  const source = fs.readFileSync(require.resolve('../src/playback-health.ts'), 'utf8');
  const script = ts.transpileModule(source, {compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
  const stored = new Map(), api = {}, time = Date.parse(checkedAt) + 1000;
  vm.runInNewContext(script, {exports:api,require:() => require('../electron/station-health.mjs'),
    Date:class extends Date { static now(){return time;} },localStorage:{
      getItem:key=>stored.get(key),setItem:(key,value)=>stored.set(key,value)
    }});
  const gs='https://master.nhkworld.jp/nhkworld-radio/playlist/gs2/live.m3u8';
  const nhk={stationuuid:'813c17ee-abc0-46ce-974f-6640a3909d3c',url:gs,url_resolved:gs};
  const other={stationuuid:'other',url:'https://example.org/live'};
  assert.match(api.playbackHealthLabel(nhk), /점검/);
  assert.equal(api.prioritizePlayable([nhk,other])[0],other);
  assert.ok(api.recordPlaybackHealth({station:nhk,status:'playing'}));
  assert.equal(api.prioritizePlayable([nhk,other])[0],nhk);
  assert.ok(api.recordPlaybackHealth({station:nhk,status:'error'}));
  assert.equal(api.playbackHealthLabel(nhk),'최근 재생 실패');
  assert.equal(api.playbackHealthLabel({...nhk,url:'https://example.org/updated'}),'');
});
