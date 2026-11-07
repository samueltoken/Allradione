'use strict';
const fs=require('node:fs/promises');
const path=require('node:path');
const {cleanPreferences}=require('./preferences.cjs');
const {APP_ID}=require('./desktop.cjs');
const OWNER_FILE='allradione-owner.txt';
async function exists(file){try{await fs.access(file);return true;}catch{return false;}}
function portableSettingsCandidate(exe){
 if(typeof exe!=='string'||!path.isAbsolute(exe)||path.extname(exe).toLowerCase()!=='.exe')return null;
 return path.join(path.dirname(exe),'Allradione-data','settings.json');
}
async function prepareDataDir({app,env=process.env}){
 const dataDir=app.getPath('userData');await fs.mkdir(dataDir,{recursive:true});
 // Marker is used only to identify this app's exact data directory on uninstall.
 await fs.writeFile(path.join(dataDir,OWNER_FILE),APP_ID,'utf8');
 const target=path.join(dataDir,'settings.json');
 if(!await exists(target)){
  const candidates=[portableSettingsCandidate(env.PORTABLE_EXECUTABLE_FILE),portableSettingsCandidate(app.getPath('exe'))].filter(Boolean);
  for(const source of candidates){
   try{
    const stat=await fs.lstat(source);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>4*1024*1024)continue;
    const previous=JSON.parse(await fs.readFile(source,'utf8'));if(!previous||typeof previous!=='object'||Array.isArray(previous))continue;
    await fs.writeFile(target,JSON.stringify(cleanPreferences(previous),null,2),{flag:'wx'});
    break;
   }catch(error){if(error.code==='EEXIST')break;}
  }
 }
 return dataDir;
}
module.exports={OWNER_FILE,portableSettingsCandidate,prepareDataDir};
