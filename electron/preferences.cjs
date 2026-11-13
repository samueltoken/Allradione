'use strict';
const fs=require('node:fs/promises');
const path=require('node:path');
const {savedStations}=require('./station-catalog.mjs');
const DEFAULTS={volume:.7,favorites:[],recent:[],widgetEnabled:false,widgetSize:'small',lastCountry:'KR',reducedMotion:false};
function cleanPreferences(patch,old=DEFAULTS){
  const out={...old};if(!patch||typeof patch!=='object')return out;
  if(Number.isFinite(patch.volume))out.volume=Math.min(1,Math.max(0,patch.volume));
  for(const key of ['widgetEnabled','reducedMotion'])if(typeof patch[key]==='boolean')out[key]=patch[key];
  if(['small','medium'].includes(patch.widgetSize))out.widgetSize=patch.widgetSize;
  if(/^[A-Z]{2}$/.test(patch.lastCountry))out.lastCountry=patch.lastCountry;
  for(const key of ['favorites','recent'])if(Array.isArray(patch[key]))out[key]=savedStations(patch[key].slice(0,key==='favorites'?1000:100));
  return out;
}
async function createPreferences(dataDir){
  const file=path.join(dataDir,'settings.json');let state={...DEFAULTS};
  try{state=cleanPreferences(JSON.parse(await fs.readFile(file,'utf8')));}catch{}
  let writing=Promise.resolve();
  return {get:()=>structuredClone(state),save(patch){state=cleanPreferences(patch,state);const snapshot=JSON.stringify(state,null,2);writing=writing.catch(()=>{}).then(async()=>{await fs.writeFile(file+'.tmp',snapshot);await fs.rename(file+'.tmp',file);});return writing.then(()=>structuredClone(state));}};
}
module.exports={createPreferences,cleanPreferences,DEFAULTS};
