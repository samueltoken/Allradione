'use strict';
const {url:chatRoom}=require('./chat-endpoint.json');

function sameDocument(raw, expected) {
 try { const actual=new URL(raw), trusted=new URL(expected);return actual.protocol===trusted.protocol&&actual.host===trusted.host&&actual.pathname===trusted.pathname&&!actual.username&&!actual.password; }
 catch { return false; }
}
function canGrantLoopback({permission,isMainFrame,requestingUrl,documentUrl,isTrusted}) {
 // Chromium 45 distinguishes loopback from LAN; never grant the old wider permission.
 return permission==='loopback-network' && isTrusted===true && isMainFrame===true && sameDocument(requestingUrl,documentUrl);
}
function isAllowedRendererRequest(raw,proxyEndpoint,devOrigin) {
 try {
  const url=new URL(raw), proxy=new URL(proxyEndpoint);
  if(!['http:','https:','ws:','wss:'].includes(url.protocol))return true;
  if(url.username||url.password)return false;
  if(url.href===chatRoom)return true;
  if(url.origin===proxy.origin&&url.pathname===proxy.pathname&&url.protocol==='http:')return true;
  if(devOrigin){const dev=new URL(devOrigin);if(url.host===dev.host&&((url.protocol===dev.protocol)||(dev.protocol==='http:'&&url.protocol==='ws:')))return true;}
  // Native renderers have no need to contact radios, image hosts, APIs or other
  // localhost services directly. All broadcast network IO goes through the proxy.
  return false;
 }catch{return false;}
}
function configurePermissions(ses,{getWindows,documentUrl,proxyEndpoint,devOrigin}) {
 function trusted(webContents){return !!webContents&&getWindows().some(win=>win&&!win.isDestroyed()&&win.webContents===webContents);}
 function allowed(webContents,permission,details){
  return canGrantLoopback({permission,isMainFrame:details?.isMainFrame,requestingUrl:details?.requestingUrl,documentUrl,isTrusted:trusted(webContents)});
 }
 ses.setPermissionCheckHandler((wc,permission,_origin,details)=>allowed(wc,permission,details));
 ses.setPermissionRequestHandler((wc,permission,callback,details)=>callback(allowed(wc,permission,details)));
 ses.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*','ws://*/*','wss://*/*']},(details,callback)=>{
  const known=getWindows().some(win=>win&&!win.isDestroyed()&&win.webContents.id===details.webContentsId);
  callback({cancel:!known||!isAllowedRendererRequest(details.url,proxyEndpoint,devOrigin)});
 });
}
module.exports={sameDocument,canGrantLoopback,isAllowedRendererRequest,configurePermissions};
