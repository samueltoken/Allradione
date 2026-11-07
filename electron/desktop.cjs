'use strict';
const fs=require('node:fs/promises');
const path=require('node:path');
const APP_ID='io.github.samueltoken.allradione';
function sameWindowsPath(a,b){return path.win32.normalize(String(a)).toLowerCase()===path.win32.normalize(String(b)).toLowerCase();}
function createDesktopService({app,shell,platform=process.platform}){
 return {async createShortcut(){
  if(platform!=='win32'||!app.isPackaged)return {created:false,message:'Windows 설치 버전에서 사용할 수 있습니다.'};
  const target=app.getPath('exe'),link=path.join(app.getPath('desktop'),'Allradione.lnk');
  try{
   const stat=await fs.stat(target);if(!stat.isFile())throw new Error('Executable not found');
   const uninstaller=path.join(path.dirname(target),'Uninstall Allradione.exe');
   try{if(!(await fs.stat(uninstaller)).isFile())throw new Error('Not installed');}catch{return {created:false,message:'Windows 설치 버전에서 사용할 수 있습니다.'};}
   let exists=false;try{await fs.lstat(link);exists=true;}catch(error){if(error.code!=='ENOENT')throw error;}
   if(exists){const old=shell.readShortcutLink(link);if(!sameWindowsPath(old.target,target))return {created:false,message:'같은 이름의 다른 바로가기가 있어 덮어쓰지 않았습니다.'};}
   const created=shell.writeShortcutLink(link,exists?'update':'create',{target,cwd:path.dirname(target),description:'Allradione',icon:target,iconIndex:0,appUserModelId:APP_ID});
   return {created,message:created?'바탕화면 바로가기를 만들었습니다.':'바로가기를 만들지 못했습니다.'};
  }catch{return {created:false,message:'바탕화면 바로가기를 만들지 못했습니다. 폴더 권한을 확인해 주세요.'};}
 }};
}
module.exports={APP_ID,sameWindowsPath,createDesktopService};
