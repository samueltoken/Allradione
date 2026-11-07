'use strict';
const dns=require('node:dns').promises;
const fs=require('node:fs/promises');
const path=require('node:path');
const {fetchJson}=require('./network.cjs');
const {metadataFiles}=require('./cache.cjs');
function cleanStation(s) {
  if(!s||typeof s.stationuuid!=='string'||typeof s.name!=='string')return null;
  const result={};
  for(const key of ['stationuuid','name','url_resolved','url','homepage','favicon','countrycode','language','tags','codec'])result[key]=String(s[key]||'').slice(0,8192);
  for(const key of ['bitrate','hls','lastcheckok','votes'])result[key]=Number.isFinite(s[key])?s[key]:0;
  for(const key of ['geo_lat','geo_long'])if(Number.isFinite(s[key]))result[key]=s[key];
  return result;
}
function createRadio(dataDir) {
  let servers=['https://de1.api.radio-browser.info','https://nl1.api.radio-browser.info'];
  let discovery;
  const cache=new Map();
  let generation=0, diskQueue=Promise.resolve();
  const scheduleDisk=operation=>(diskQueue=diskQueue.catch(()=>{}).then(operation));
  async function discover(){
    if(!discovery) discovery=(async()=>{
      try{
        const names=await Promise.race([dns.resolveSrv('_api._tcp.radio-browser.info'),new Promise((_,reject)=>setTimeout(()=>reject(new Error('DNS timeout')),4000))]);
        const valid=names.map(x=>x.name).filter(x=>/^[a-z\d-]+\.api\.radio-browser\.info$/i.test(x));
        if(valid.length)servers=valid.sort(()=>Math.random()-.5).map(x=>`https://${x}`);
      }catch{}
    })();
    await discovery;
  }
  async function request(endpoint){
    await discover();let last;
    for(const server of servers){try{return await fetchJson(server+endpoint);}catch(e){last=e;}}
    throw new Error(`방송국 목록에 연결할 수 없어. 잠시 후 다시 시도해줘. (${last?.message||'network'})`);
  }
  async function cached(key,endpoint,transform,ttl){
    const entry=cache.get(key);if(entry&&Date.now()-entry.time<ttl)return entry.data;
    const file=path.join(dataDir,`cache-${key}.json`),requestGeneration=generation;
    try{const raw=await request(endpoint);const data=transform(raw);const saved={time:Date.now(),data};if(requestGeneration===generation){cache.set(key,saved);await scheduleDisk(async()=>{if(requestGeneration===generation)await fs.writeFile(file,JSON.stringify(saved));}).catch(()=>{});}return data;}
    catch(error){if(entry)return entry.data;try{const saved=JSON.parse(await fs.readFile(file,'utf8'));if(Array.isArray(saved.data)&&requestGeneration===generation){cache.set(key,saved);return saved.data;}}catch{}throw error;}
  }
  return {
    clearCache:()=>{generation++;cache.clear();return scheduleDisk(async()=>{const failures=[];for(const file of await metadataFiles(dataDir)){try{await fs.unlink(file);}catch(error){if(error.code!=='ENOENT')failures.push(error);}}if(failures.length)throw new Error('Some station cache files could not be removed');});},
    countries:()=>cached('countries','/json/countrycodes?order=stationcount&reverse=true',rows=>{
      const names=new Intl.DisplayNames(['ko'],{type:'region'});
      return rows.filter(s=>/^[A-Z]{2}$/.test(s.name)).map(s=>({code:s.name,name:names.of(s.name)||s.name,stationcount:Number(s.stationcount)||0}));
    },6*60*60*1000),
    stations:code=>{
      if(!/^[A-Z]{2}$/.test(code))throw new Error('Invalid country');
      return cached(`stations-${code}`,`/json/stations/bycountrycodeexact/${code}?hidebroken=true&order=clickcount&reverse=true&limit=3000`,rows=>rows.map(cleanStation).filter(Boolean),20*60*1000);
    },
    click:async id=>{if(!/^[a-z\d-]{8,80}$/i.test(id))return;await request(`/json/url/${encodeURIComponent(id)}`).catch(()=>{});}
  };
}
module.exports={createRadio,cleanStation};
