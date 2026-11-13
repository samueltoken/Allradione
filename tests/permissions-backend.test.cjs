const test=require('node:test');
const assert=require('node:assert/strict');
const {canGrantLoopback,isAllowedRendererRequest,configurePermissions}=require('../electron/permissions.cjs');
const documentUrl='file:///C:/Allradione/resources/app.asar/dist/index.html';
const proxy='http://127.0.0.1:31337/stream/secret-token?url=https%3A%2F%2Fradio.example';
test('only the configured secure chat room is reachable from the desktop',()=>{
 const {url}=require('../electron/chat-endpoint.json');
 assert.equal(isAllowedRendererRequest(url,proxy),true);
 for(const other of [url.replace('/room','/moderate'),url.replace('wss:','https:'),url+'?elsewhere',url.replace('allradione-chat.','other.')]){
  assert.equal(isAllowedRendererRequest(other,proxy),false);
 }
 const html=require('node:fs').readFileSync(require.resolve('../index.html'),'utf8');
 assert.ok(html.includes(url),'production CSP must permit the configured secure chat socket');
});
test('only registered bundled main frames receive the narrow loopback permission',()=>{
 const args={permission:'loopback-network',isMainFrame:true,requestingUrl:documentUrl+'?widget=small',documentUrl,isTrusted:true};
 assert.equal(canGrantLoopback(args),true);
 for(const permission of ['local-network','local-network-access','media','geolocation','clipboard-read'])assert.equal(canGrantLoopback({...args,permission}),false);
 assert.equal(canGrantLoopback({...args,isMainFrame:false}),false);
 assert.equal(canGrantLoopback({...args,isTrusted:false}),false);
 assert.equal(canGrantLoopback({...args,requestingUrl:'file:///C:/untrusted.html'}),false);
 assert.equal(canGrantLoopback({...args,requestingUrl:'https://evil.example/'}),false);
 assert.equal(canGrantLoopback({...args,requestingUrl:undefined}),false);
});
test('renderer traffic is restricted to the exact internal token endpoint, not all localhost or LAN',()=>{
 assert.equal(isAllowedRendererRequest(proxy,proxy),true);
 for(const url of ['http://127.0.0.1:31338/stream/secret-token','http://127.0.0.1:31337/admin','http://localhost:31337/stream/secret-token','http://192.168.1.1/admin','http://evil.example/stream/secret-token','https://radio.example/a.mp3','http://127.0.0.1:31337/stream/wrong','http://user@127.0.0.1:31337/stream/secret-token'])assert.equal(isAllowedRendererRequest(url,proxy),false,url);
 assert.equal(isAllowedRendererRequest('http://localhost:5173/src/main.ts',proxy,'http://localhost:5173'),true);
 assert.equal(isAllowedRendererRequest('ws://localhost:5173/?token=vite',proxy,'http://localhost:5173'),true);
 assert.equal(isAllowedRendererRequest('http://localhost.evil.example:5173/',proxy,'http://localhost:5173'),false);
});
test('both Electron permission handlers and request filter enforce the same policy',()=>{
 const handlers={},wc={id:5},win={isDestroyed:()=>false,webContents:wc};
 const ses={setPermissionCheckHandler:fn=>handlers.check=fn,setPermissionRequestHandler:fn=>handlers.request=fn,webRequest:{onBeforeRequest:(_filter,fn)=>handlers.network=fn}};
 configurePermissions(ses,{getWindows:()=>[win],documentUrl,proxyEndpoint:proxy});
 const details={isMainFrame:true,requestingUrl:documentUrl};
 assert.equal(handlers.check(wc,'loopback-network','file://',details),true);
 handlers.request(wc,'loopback-network',value=>assert.equal(value,true),details);
 handlers.request(wc,'local-network',value=>assert.equal(value,false),details);
 handlers.network({webContentsId:5,url:proxy},value=>assert.equal(value.cancel,false));
 handlers.network({webContentsId:6,url:proxy},value=>assert.equal(value.cancel,true));
});
