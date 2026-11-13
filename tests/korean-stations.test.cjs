const { test } = require('node:test');
const assert = require('node:assert/strict');
const { koreanStations, isKoreanBroadcasterStation, resolveKoreanStream } = require('../electron/korean-stations.mjs');

test('official channels keep stable identities and refresh broadcaster-issued URLs at tune time', async () => {
  const ids = new Set(koreanStations.map(station => station.stationuuid));
  assert.equal(ids.size, koreanStations.length);
  for (const station of koreanStations) {
    assert.ok(isKoreanBroadcasterStation(station));
    assert.equal(isKoreanBroadcasterStation({...station, url_resolved: 'https://relay.example/other'}), false);
  }
  const kbs = koreanStations.find(s => s.name === 'KBS 1라디오');
  const read = async () => JSON.stringify({channel_item: [
    {media_type: 'bora', channel_code: '21', service_url: 'https://video.kbs.co.kr/live.m3u8'},
    {media_type: 'radio', channel_code: '21', service_url: 'https://1radio.gscdn.kbs.co.kr/live.m3u8'}
  ]});
  assert.equal(await resolveKoreanStream(kbs.url, read), 'https://1radio.gscdn.kbs.co.kr/live.m3u8');
  const mbc = koreanStations.find(s => s.name === 'MBC FM4U');
  const endpoint = 'https://minimw.imbc.com/path/to/live.m3u8';
  assert.equal(await resolveKoreanStream(mbc.url, async () => endpoint + '\n'), endpoint);
  await assert.rejects(resolveKoreanStream(mbc.url, async () => 'https://imbc.com.unrelated.example/live'));
  const thirdParty = 'https://elsewhere.example/live';
  assert.equal(await resolveKoreanStream(thirdParty, () => assert.fail('unexpected request')), thirdParty);
});
