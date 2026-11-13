const test=require('node:test');
const assert=require('node:assert/strict');
const {isPublicAddress,validateUrl}=require('../electron/network.cjs');
const {rewritePlaylist,createStreamProxy}=require('../electron/stream-proxy.cjs');
const {cleanPreferences}=require('../electron/preferences.cjs');
test('rejects local, link-local, metadata and mapped address targets',()=>{
 for(const host of ['127.0.0.1','10.0.0.1','172.16.0.1','192.168.1.1','169.254.169.254','100.64.0.1','0.0.0.0','::1','::ffff:127.0.0.1','fc00::1','fe80::1'])assert.equal(isPublicAddress(host),false,host);
 for(const url of ['file:///etc/passwd','http://localhost/a','http://something.local/a','http://127.1/a','http://2130706433/a','http://user:pass@radio.example/a'])assert.throws(()=>validateUrl(url),url);
 assert.equal(isPublicAddress('8.8.8.8'),true);assert.equal(isPublicAddress('2606:4700:4700::1111'),true);
});
test('rewrites every HLS variant, audio segment and encrypted key relative to final redirected URL',()=>{
 const input='#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="../keys/key.bin"\n#EXT-X-MEDIA:TYPE=AUDIO,URI="audio/index.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=128000\nlow/playlist.m3u8\n#EXTINF:5,\n../a.ts?x=1\n';
 const output=rewritePlaylist(input,'https://radio.example/live/index.m3u8',url=>'PROXY:'+url);
 assert.match(output,/URI="PROXY:https:\/\/radio.example\/keys\/key.bin"/);
 assert.match(output,/URI="PROXY:https:\/\/radio.example\/live\/audio\/index.m3u8"/);
 assert.match(output,/PROXY:https:\/\/radio.example\/live\/low\/playlist.m3u8/);
 assert.match(output,/PROXY:https:\/\/radio.example\/a.ts\?x=1/);
});
test('loopback proxy requires its unpredictable path token',async()=>{
 const proxy=await createStreamProxy();try{
  const url=proxy.url('https://radio.example/live.mp3');const origin=new URL(url).origin;
  assert.equal((await fetch(origin+'/stream/not-the-token')).status,403);
  assert.throws(()=>proxy.url('http://localhost/secret'));
 }finally{proxy.close();}
});
test('preference patch clamps volume and rejects malformed persisted entries',()=>{
 const p=cleanPreferences({volume:6,widgetSize:'giant',favorites:[null,{}, {stationuuid:'ok',name:'Radio',url:'https://example.com'}],lastCountry:'../../foo',widgetEnabled:true});
 assert.equal(p.volume,1);assert.equal(p.widgetSize,'small');assert.equal(p.favorites.length,1);assert.equal(p.lastCountry,'KR');assert.equal(p.widgetEnabled,true);
});
test('proxy streams actual bytes and range headers without buffering an endless station',async()=>{
 const {Readable}=require('node:stream');let received;
 const proxy=await createStreamProxy({request:async(url,options)=>{
   received=options;const response=Readable.from([Buffer.from('MP3'),Buffer.from('DATA')]);
   response.statusCode=206;response.headers={'content-type':'audio/mpeg','content-range':'bytes 0-6/7','content-length':'7'};
   return {response,url};
 }});
 try{const result=await fetch(proxy.url('https://radio.example/audio'),{headers:{Range:'bytes=0-6'}});
  assert.equal(result.status,206);assert.equal(result.headers.get('access-control-allow-origin'),'*');assert.equal(result.headers.get('content-range'),'bytes 0-6/7');assert.equal(await result.text(),'MP3DATA');assert.equal(received.headers.Range,'bytes=0-6');
 }finally{proxy.close();}
});
test('proxy detects extensionless HLS and rewrites segments after redirect',async()=>{
 const {Readable}=require('node:stream');
 const proxy=await createStreamProxy({request:async()=>{
  const response=Readable.from([Buffer.from('#EXTM3U\n#EXTINF:4,\nchunk.aac\n')]);response.statusCode=200;response.headers={'content-type':'application/octet-stream'};
  return {response,url:'https://cdn.example/resolved/live/index'};
 }});
 try{const result=await fetch(proxy.url('https://radio.example/start'));assert.equal(result.headers.get('content-type'),'application/vnd.apple.mpegurl; charset=utf-8');const body=await result.text();assert.ok(body.includes(encodeURIComponent('https://cdn.example/resolved/live/chunk.aac')));}
 finally{proxy.close();}
});
test('concurrent widget and renderer preference patches persist without losing either change',async()=>{
 const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
 const {createPreferences}=require('../electron/preferences.cjs');
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'allradione-prefs-test-'));
 try{
  const store=await createPreferences(dir);
  await Promise.all([store.save({widgetEnabled:true,widgetSize:'medium'}),store.save({volume:.23}),store.save({lastCountry:'JP'}),store.save({favorites:[{stationuuid:'station-a',name:'A',url:'https://example.com/a'}]})]);
  const reopened=await createPreferences(dir),saved=reopened.get();
  assert.equal(saved.widgetEnabled,true);assert.equal(saved.widgetSize,'medium');assert.equal(saved.volume,.23);assert.equal(saved.lastCountry,'JP');assert.equal(saved.favorites[0].stationuuid,'station-a');
  await Promise.all(Array.from({length:20},(_,i)=>store.save({volume:i/20})));
  assert.equal((await createPreferences(dir)).get().volume,.95);
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});

test('ordinary M3U and PLS playlists lead the player to audio through the same proxy', async () => {
  const { Readable } = require('node:stream');
  const files = {
    '/radio.m3u': ['audio/x-mpegurl', '#EXTM3U\n#EXTINF:-1,Live radio\nlist.pls'],
    '/list.pls': ['audio/x-scpls', '[playlist]\nFile1=audio.mp3\nNumberOfEntries=1'],
    '/audio.mp3': ['audio/mpeg', 'audio bytes'],
    '/loop.pls': ['audio/x-scpls', '[playlist]\nFile1=loop.pls']
  };
  const proxy = await createStreamProxy({request: async url => {
    const [type, body] = files[new URL(url).pathname];
    const response = Readable.from([Buffer.from(body)]);
    response.statusCode = 200;
    response.headers = {'content-type': type};
    return {response, url};
  }});
  try {
    const audio = await fetch(proxy.url('https://radio.example/radio.m3u'));
    assert.equal(audio.headers.get('content-type'), 'audio/mpeg');
    assert.equal(await audio.text(), 'audio bytes');
    assert.equal((await fetch(proxy.url('https://radio.example/loop.pls'))).status, 502);
  } finally { proxy.close(); }
});
