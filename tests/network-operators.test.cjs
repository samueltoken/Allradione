const test = require('node:test');
const assert = require('node:assert/strict');
const {networkOperator} = require('../electron/network-operators.mjs');
const {streamOrigin} = require('../electron/station-origins.mjs');

test('an identified channel on a shared server uses its own operator and country', () => {
  const nrj = networkOperator({url: 'https://streaming.nrjaudio.fm/oumvmk8fnozc?origine=radiodns'});
  assert.equal(nrj.country, 'FR');
  assert.equal(nrj.operatorName, 'NRJ Group');
  assert.equal(networkOperator({url: 'https://streaming.nrjaudio.fm/another-station'}), undefined);
  assert.equal(networkOperator({url: 'https://streaming.nrjaudio.fm.unrelated.example/oumvmk8fnozc'}), undefined);
});

test('a published CDN address verifies only its channel and safe query parameters', () => {
  const cbc = 'https://cbcradiolive.akamaized.net/hls/live/2041036/ES_R1ETR/master.m3u8';
  assert.equal(networkOperator({url:cbc}).operatorName, 'CBC/Radio-Canada');
  assert.equal(networkOperator({url:cbc.replace('ES_R1ETR','unknown')}), undefined);
  assert.equal(networkOperator({url:cbc+'?station=other'}), undefined);
  const official = 'https://regiocast.streamabc.net/regc-80s80sby-mp3-192-9748144';
  assert.equal(networkOperator({url_resolved:official+'?sABC=tracking&aw_0_1st.playerid=radio'}).country, 'DE');
  assert.equal(networkOperator({url:'https://streams.80s80s.de/play.m3u',url_resolved:official+'?url=other'}), undefined);
});

test('recognises national and community broadcasters on shared players without trusting lookalikes', () => {
  const feed = 'https://as-hls-ww-live.akamaized.net/pool_74208725/live/ww/bbc_radio_two/bbc_radio_two.isml/bbc_radio_two-audio%3d128000.norewind.m3u8';
  assert.equal(streamOrigin({url:feed}).operatorName,'BBC');
  assert.equal(streamOrigin({url:feed.replace('.net/', '.net.example/'),name:'BBC Radio 2'}).kind,undefined);
  assert.equal(streamOrigin({url:feed.replace('bbc_radio_two.isml', 'bbc_6music.isml')}).kind,undefined);
  assert.equal(streamOrigin({url:'http://211.33.246.4:32954/radio_fm/myStream.sdp/chunklist_w32.m3u8'}).operatorName,'MBC충북');
  assert.equal(streamOrigin({url:'http://211.33.246.4:32954/other/myStream.sdp/chunklist_w32.m3u8'}).kind,undefined);
  assert.equal(streamOrigin({url:'https://fmsetagaya834.out.airtime.pro/fmsetagaya834_a'}).kind,'broadcaster');
  assert.equal(streamOrigin({url:'https://another.out.airtime.pro/fmsetagaya834_a'}).kind,undefined);
  assert.equal(streamOrigin({url:'https://replaynewskr.ice.infomaniak.ch/replaynewskr-128.mp3'}).country,'FR');
});

test('keeps programme and relay identity apart when only the programme can be corroborated', () => {
  const nhk = streamOrigin({name:'NHK-FM',url:'https://mnet.x10.mx/nhkfm.m3u8',homepage:'https://www.nhk.or.jp/radio/'});
  assert.equal(nhk.programmeOriginName,'NHK-FM');
  assert.equal(nhk.kind,undefined);
  const radio = streamOrigin({url:'http://kathy.torontocast.com:3330/stream/1/'});
  assert.equal(radio.operatorName, 'asia DREAM radio');
  assert.equal(radio.kind, 'independent');
  assert.equal(streamOrigin({url:'http://kathy.torontocast.com:3330/stream/2/'}).kind,undefined);
});
