const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveStationStream } = require('../electron/nhk-radio.mjs');
const { cleanStation } = require('../electron/station-catalog.mjs');

const ko = 'https://www3.nhk.or.jp/nhkworld/ko/radio/live/';
const now = Date.parse('2026-11-13T12:00:00Z');
const row = { lang: 'ko', start_at: '2026-11-13T12:00:00Z', end_at: '2026-11-13T12:20:00Z', channel: {out: 2} };
const primary = 'https://nhkworld-radio.nhkworld.jp/hls/live/nhkworld-radio-media2/index.m3u8';
const backup = 'https://b-nhkworld-radio.nhkworld.jp/output-2.m3u8';
test('Korean playback follows the selected language programme time and official output number', async () => {
  const read = async url => JSON.stringify(url.includes('audio_schedules') ? {items:[{...row,lang:'en',channel:{out:11}},row]}
    : {main:{'02':primary, '11':'https://outside.example/'},sub:{'02':backup}});
  assert.deepEqual(await resolveStationStream(ko, read, now - 60000), {offAir:true,nextAt:now});
  assert.deepEqual(await resolveStationStream(ko, read, now), {url:primary,backup,endsAt:Date.parse(row.end_at)});
  assert.deepEqual(await resolveStationStream(ko, read, Date.parse(row.end_at)), {offAir:true,nextAt:undefined});
});
test('catalog corrects numbered outputs, keeps legacy identities distinct and restores saved Korean service', () => {
  const url = 'https://nhkworld-radio.nhkworld.jp/hls/live/nhkworld-radio-media11/index.m3u8';
  assert.equal(cleanStation({name:'NHK WORLD RADIO-2',stationuuid:'one',url}).name, 'NHK WORLD RADIO 11');
  const gs='https://master.nhkworld.jp/nhkworld-radio/playlist/gs2/live.m3u8';
  assert.equal(cleanStation({name:'NHK WORLD RADIO 11',stationuuid:'two',url:gs}).name, 'NHK WORLD · GS2');
  const saved=cleanStation({name:'NHK World Radio (Korean)',stationuuid:'9a6855fe-1c7f-422b-a4bc-f15af3b347ff',
    url:'https://master.nhkworld.jp/nhkworld-radio/playlist/rs1/live.m3u8'});
  assert.equal(saved.url, ko);
  assert.equal(cleanStation(saved).operatorKind, 'broadcaster');
});
