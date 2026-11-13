'use strict';
const dns = require('node:dns').promises;
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const APP_VERSION = require('../package.json').version;
const {requestIcy} = require('./icy.cjs');

function isPublicAddress(address) {
  if (net.isIPv4(address)) {
    const [a,b,c] = address.split('.').map(Number);
    return !(a===0 || a===10 || a===127 || a>=224 || (a===169&&b===254) || (a===172&&b>=16&&b<=31) || (a===192&&b===168) || (a===100&&b>=64&&b<=127) || (a===198&&(b===18||b===19)) || (a===192&&b===0&&c===0) || (a===192&&b===0&&c===2) || (a===198&&b===51&&c===100) || (a===203&&b===0&&c===113));
  }
  if (net.isIPv6(address)) {
    const a = address.toLowerCase();
    // Public global unicast only. IPv4-mapped addresses are deliberately rejected.
    return /^[23][0-9a-f]{0,3}:/.test(a) && !a.startsWith('2001:db8:');
  }
  return false;
}
function validateUrl(raw) {
  if (typeof raw !== 'string' || raw.length > 8192) throw new Error('Invalid stream URL');
  const u = new URL(raw);
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) throw new Error('Only public HTTP/HTTPS streams are supported');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (!host || /(^|\.)(localhost|local|internal|home|lan)$/i.test(host) || (net.isIP(host) && !isPublicAddress(host))) throw new Error('Local network addresses are not supported');
  return u;
}
async function publicLookup(hostname) {
  const host = hostname.replace(/^\[|\]$/g, '');
  let timer;
  const addresses = net.isIP(host) ? [{address:host,family:net.isIP(host)}] : await Promise.race([dns.lookup(host,{all:true}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('DNS lookup timed out')),8000);})]).finally(()=>clearTimeout(timer));
  if (!addresses.length || addresses.some(x=>!isPublicAddress(x.address))) throw new Error('Stream hostname resolves to a private address');
  return addresses.sort((a,b)=>a.family-b.family)[0];
}
async function requestPublic(raw, {headers={}, redirects=6, timeout=15000, signal, allowIcy=false}={}) {
  const url=validateUrl(raw), address=await publicLookup(url.hostname);
  return new Promise((resolve,reject)=>{
    const transport=url.protocol==='https:'?https:http;
    const req=transport.get(url,{headers:{'User-Agent':`Allradione/${APP_VERSION}`,...headers},lookup:(_host,opts,cb)=>opts?.all?cb(null,[address]):cb(null,address.address,address.family),signal},res=>{
      clearTimeout(timer);
      if ([301,302,303,307,308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        if(redirects<=0) return reject(new Error('Too many stream redirects'));
        requestPublic(new URL(res.headers.location,url).href,{headers,redirects:redirects-1,timeout,signal,allowIcy}).then(resolve,reject);
      } else resolve({response:res,url:url.href});
    });
    const timer=setTimeout(()=>req.destroy(new Error('Connection timed out')),timeout);
    req.on('error',e=>{
      clearTimeout(timer);
      const prefix=e.rawPacket?.subarray(0,16).toString('latin1') || '';
      const bareStatus=e.code==='HPE_CR_EXPECTED' && /^HTTP\/1\.[01] 200 OK\n/.test(prefix);
      const icy=e.code==='HPE_INVALID_CONSTANT' && prefix.startsWith('ICY 200 OK\r\n');
      if(allowIcy && !signal?.aborted && (icy || bareStatus)){
        requestIcy(url,address,{signal,timeout,userAgent:'Allradione/'+APP_VERSION,bareStatus}).then(resolve,reject);
      }else reject(e);
    });
    req.setTimeout(45000,()=>req.destroy(new Error('Stream connection timed out')));
  });
}
async function fetchText(url,{timeout=12000,maxBytes=16*1024*1024,headers={}}={}) {
  const {response}=await requestPublic(url,{timeout,headers});
  if(response.statusCode<200 || response.statusCode>=300){response.resume();throw new Error(`HTTP ${response.statusCode}`);}
  let size=0; const chunks=[];
  for await(const chunk of response){size+=chunk.length;if(size>maxBytes){response.destroy();throw new Error('Response too large');}chunks.push(chunk);}
  return Buffer.concat(chunks).toString('utf8');
}
async function fetchJson(url,options) {
  return JSON.parse(await fetchText(url,options));
}
module.exports={isPublicAddress,validateUrl,publicLookup,requestPublic,fetchJson,fetchText};
