const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

// Exercise the production player with a media element whose source can reject.
// No remote station availability or connection speed is required for this test.
function fixture(options = {}) {
  let audio;
  class Media extends EventTarget {
    constructor() { super(); audio = this; }
    pause() {}
    play() { return Promise.resolve(); }
    load() {}
    removeAttribute() {}
  }
  const calls = [];
  const bridge = {
    streamUrl: async url => { calls.push(url); return options.source || url; },
    stationClick: async () => {}, publishPlayer: () => {}
  };
  const exports = {};
  const source = fs.readFileSync(path.join(__dirname, '../src/audio.ts'), 'utf8');
  const script = ts.transpileModule(source, {compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022
  }}).outputText;
  vm.runInNewContext(script, {exports, require: name => name === 'hls.js' ? {default: {isSupported: () => false}} : {},
    Audio: Media, navigator: {}, MediaError: {MEDIA_ERR_SRC_NOT_SUPPORTED: 4},
    fetch: options.fetch || (async () => { throw new Error('Offline test'); }),
    AbortController, DOMException, setTimeout, clearTimeout, clearInterval});
  const player = new exports.RadioPlayer(bridge, () => {});
  return {audio, player, calls};
}

test('an expired or unsupported resolved stream falls back to the registered URL', async () => {
  const {player, audio, calls} = fixture();
  const station = {stationuuid:'saved', name:'Station', url_resolved:'https://stream.example/expired', url:'https://radio.example/live'};
  try {
    await player.play(station);
    audio.error = {code:4};
    audio.dispatchEvent(new Event('error'));
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.deepEqual(calls, [station.url_resolved, station.url]);
    audio.dispatchEvent(new Event('playing'));
    assert.equal(player.state.status, 'playing');
  } finally { player.destroy(); }
});

test('changing stations cancels the pending fallback', async () => {
  const {player, audio, calls} = fixture();
  try {
    await player.play({name:'First', url_resolved:'https://radio.example/expired', url:'https://radio.example/first'});
    audio.error = {code:4};
    audio.dispatchEvent(new Event('error'));
    await player.play({name:'Second', url:'https://radio.example/second'});
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.deepEqual(calls, ['https://radio.example/expired','https://radio.example/second']);
  } finally { player.destroy(); }
});

test('a direct stream returning a web page or access denied reports the cause', async () => {
  for (const [response, message] of [
    [new Response('', {status:403}), /403/],
    [new Response('', {status:429}), /요청 횟수/],
    [new Response('<html>', {headers:{'Content-Type':'text/html'}}), /웹페이지/],
    [new Response('', {status:502,headers:{'X-Allradione-Error':'tls'}}), /인증서/]
  ]) {
    const {player, audio} = fixture({fetch:async () => response});
    try {
      await player.play({name:'Radio',url:'https://radio.example/feed'});
      audio.error = {code:4};
      audio.dispatchEvent(new Event('error'));
      await new Promise(resolve => setTimeout(resolve, 10));
      assert.equal(player.state.status, 'error');
      assert.match(player.state.error, message);
    } finally { player.destroy(); }
  }
});
test('scheduled time away from air is distinct from a broken stream', async () => {
  const {player, calls} = fixture({source:{offAir:true,nextAt:Date.now() + 600000}});
  try {
    await player.play({name:'NHK WORLD · 한국어',url:'https://radio.example/feed'});
    assert.equal(player.state.status, 'offair');
    assert.match(player.state.error, /다음 방송/);
    assert.equal(calls.length, 1);
  } finally { player.destroy(); }
});
