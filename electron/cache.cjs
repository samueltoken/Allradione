'use strict';
const fs=require('node:fs/promises');
const path=require('node:path');
const METADATA_FILE=/^cache-(?:countries|stations-[A-Z]{2})\.json$/;
async function metadataFiles(dir){
 let entries;try{entries=await fs.readdir(dir,{withFileTypes:true});}catch(error){if(error.code==='ENOENT')return[];throw error;}
 return entries.filter(item=>item.isFile()&&METADATA_FILE.test(item.name)).map(item=>path.join(dir,item.name));
}
async function treeBytes(dir){
 let info;try{info=await fs.lstat(dir);}catch(error){if(error.code==='ENOENT')return 0;throw error;}
 if(info.isSymbolicLink())return 0;
 if(info.isFile())return info.size;
 if(!info.isDirectory())return 0;
 let bytes=0;for(const name of await fs.readdir(dir))bytes+=await treeBytes(path.join(dir,name));return bytes;
}
function createCacheService({ses,radio,dataDir,codeCacheDir}){
 let clearing=null;
 async function info(){
  const errors=[];let httpBytes=null,metadataBytes=0,codeBytes=0;
  try{httpBytes=await ses.getCacheSize();}catch{errors.push('브라우저 캐시 크기를 확인하지 못했습니다.');}
  try{for(const file of await metadataFiles(dataDir))metadataBytes+=(await fs.lstat(file)).size;}catch{errors.push('방송 목록 캐시 크기를 확인하지 못했습니다.');}
  try{codeBytes=await treeBytes(codeCacheDir);}catch{errors.push('코드 캐시 크기를 확인하지 못했습니다.');}
  return {httpBytes,metadataBytes,codeBytes,totalBytes:(httpBytes||0)+metadataBytes+codeBytes,errors};
 }
 function clear(){
  if(clearing)return clearing;
  clearing=(async()=>{
   const before=await info(),errors=[...before.errors];
   for(const [label,operation] of [['브라우저 캐시',()=>ses.clearCache()],['코드 캐시',()=>ses.clearCodeCaches({urls:[]})],['방송 목록 캐시',()=>radio.clearCache()]]){
    try{await operation();}catch{errors.push(`${label} 일부를 정리하지 못했습니다.`);}
   }
   const after=await info();errors.push(...after.errors);
   return {beforeBytes:before.totalBytes,afterBytes:after.totalBytes,freedBytes:Math.max(0,before.totalBytes-after.totalBytes),errors:[...new Set(errors)]};
  })().finally(()=>{clearing=null;});
  return clearing;
 }
 return {info,clear};
}
module.exports={METADATA_FILE,metadataFiles,treeBytes,createCacheService};
