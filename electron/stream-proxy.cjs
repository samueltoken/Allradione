'use strict';
const http=require('node:http');
const crypto=require('node:crypto');
const {validateUrl,requestPublic}=require('./network.cjs');

function rewritePlaylist(text,base,proxify) {
  return text.split(/\r?\n/).map(line=>{
    const trimmed=line.trim();
    if(!trimmed)return line;
    if(trimmed.startsWith('#'))return line.replace(/URI="([^"]+)"/g,(_all,url)=>`URI="${proxify(new URL(url,base).href)}"`);
    return proxify(new URL(trimmed,base).href);
  }).join('\n');
}
function stationListTarget(text, base, isPls) {
  const lines = text.split(/\r?\n/).map(line => line.trim());
  if (lines.some(line => /^#EXT-X-/i.test(line))) return null;
  if (isPls || /^\[playlist\]/i.test(lines[0])) {
    const file = lines.find(line => /^File\d+=.+/i.test(line));
    if (!file) throw new Error('Empty PLS station list');
    return validateUrl(new URL(file.slice(file.indexOf('=') + 1), base).href).href;
  }
  // HLS media playlists contain timed segments. Traditional radio M3Us
  // list station URLs with no duration, or the live duration -1.
  if (lines.some(line => /^#EXTINF:(?!-1(?:[,.]|$))\d/i.test(line))) return null;
  const entry = lines.find(line => line && !line.startsWith('#'));
  if (!entry) throw new Error('Empty M3U station list');
  return validateUrl(new URL(entry, base).href).href;
}
async function createStreamProxy({ request = requestPublic } = {}) {
  const token=crypto.randomBytes(32).toString('hex');
  const controllers=new Set();
  let origin;
  function proxify(url) {validateUrl(url);return `${origin}/stream/${token}?url=${encodeURIComponent(url)}`;}
  const server=http.createServer(async(req,res)=>{
    res.setHeader('Access-Control-Allow-Origin','*');
    res.setHeader('Access-Control-Allow-Headers','Range');
    res.setHeader('Access-Control-Expose-Headers','Content-Length,Content-Range,Accept-Ranges,X-Allradione-Error');
    res.setHeader('Cross-Origin-Resource-Policy','cross-origin');
    res.setHeader('Cache-Control','no-store');
    const local=new URL(req.url,'http://127.0.0.1');
    if(local.pathname!==`/stream/${token}`){res.writeHead(403);return res.end();}
    if(req.method==='OPTIONS'){res.writeHead(204);return res.end();}
    if(req.method!=='GET'){res.writeHead(405);return res.end();}
    const controller=new AbortController();controllers.add(controller);
    res.on('close',()=>{controller.abort();controllers.delete(controller);});
    try{
      const target=validateUrl(local.searchParams.get('url')).href;
      const headers={};
      if(req.headers.range && /^bytes=\d*-\d*(,\d*-\d*)*$/.test(req.headers.range)) headers.Range=req.headers.range;
      const {response:upstream,url:finalUrl}=await request(target,{headers,signal:controller.signal,allowIcy:true});
      if(upstream.statusCode<200||upstream.statusCode>=300){upstream.resume();res.writeHead(upstream.statusCode||502);return res.end('Broadcast unavailable');}
      const iterator=upstream[Symbol.asyncIterator]();
      const first=await iterator.next();
      if(first.done){res.writeHead(502);return res.end('Empty broadcast');}
      const contentType=String(upstream.headers['content-type']||'application/octet-stream');
      const prefix=first.value.subarray(0,32).toString('utf8').trimStart();
      const pathname=new URL(finalUrl).pathname;
      const isPls=/scpls/i.test(contentType)||/\.pls$/i.test(pathname)||/^\[playlist\]/i.test(prefix);
      const isPlaylist=isPls||/mpegurl/i.test(contentType)||/\.m3u8?$/i.test(pathname)||prefix.startsWith('#EXTM3U');
      if(isPlaylist){
        let bytes=first.value.length;const chunks=[first.value];
        for(let next=await iterator.next();!next.done;next=await iterator.next()){
          bytes+=next.value.length;if(bytes>2*1024*1024){upstream.destroy();throw new Error('Playlist too large');}chunks.push(next.value);
        }
        const body=Buffer.concat(chunks).toString('utf8').trimStart();
        const entry=stationListTarget(body,finalUrl,isPls);
        if(entry){
          const depth=Number(local.searchParams.get('depth')||0);
          if(!Number.isInteger(depth)||depth<0||depth>=4)throw new Error('Too many nested station lists');
          res.writeHead(307,{Location:proxify(entry)+'&depth='+(depth+1)});
          return res.end();
        }
        const playlist=rewritePlaylist(body,finalUrl,proxify);
        res.writeHead(200,{'Content-Type':'application/vnd.apple.mpegurl; charset=utf-8'});res.end(playlist);
      } else {
        const forwarded={'Content-Type':contentType};
        for(const key of ['content-length','content-range','accept-ranges']) if(upstream.headers[key])forwarded[key]=upstream.headers[key];
        res.writeHead(upstream.statusCode,forwarded);
        const write=chunk=>new Promise((resolve,reject)=>{
          if(res.destroyed)return reject(new Error('Client closed'));
          if(res.write(chunk))return resolve();
          const cleanup=()=>{res.off('drain',done);res.off('close',closed);};
          const done=()=>{cleanup();resolve();};const closed=()=>{cleanup();reject(new Error('Client closed'));};
          res.once('drain',done);res.once('close',closed);
        });
        await write(first.value);
        for(let next=await iterator.next();!next.done;next=await iterator.next())await write(next.value);
        res.end();
      }
    } catch (error) {
      if (!res.destroyed) {
        if (!res.headersSent) {
          let cause = 'connection';
          if (/CERT|SSL|TLS|VERIFY_LEAF|SELF_SIGNED|ISSUER/.test(error.code || '')) cause = 'tls';
          else if (['ENOTFOUND','EAI_AGAIN'].includes(error.code)) cause = 'dns';
          else if (/timed out/i.test(error.message)) cause = 'timeout';
          res.writeHead(502, {'X-Allradione-Error': cause});
        }
        res.end('Unable to connect to broadcast');
      }
    }
    finally{controllers.delete(controller);}
  });
  server.requestTimeout=0;server.headersTimeout=15000;
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  origin=`http://127.0.0.1:${server.address().port}`;
  return {url:proxify,close(){for(const c of controllers)c.abort();server.closeAllConnections();server.close();}};
}
module.exports={createStreamProxy,rewritePlaylist};
