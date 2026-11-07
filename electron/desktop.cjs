'use strict';
const fs=require('node:fs/promises');
const path=require('node:path');
const {execFile}=require('node:child_process');
const {promisify}=require('node:util');
const APP_ID='io.github.samueltoken.allradione';
const INSTALL_MARKER='allradione-install-owner.txt';
function sameWindowsPath(a,b){return path.win32.normalize(String(a)).toLowerCase()===path.win32.normalize(String(b)).toLowerCase();}
async function defaultRunHelper(helper,args){
 try{await promisify(execFile)(helper,args,{windowsHide:true,timeout:20000,maxBuffer:64*1024});return 0;}
 catch(error){if(Number.isInteger(error.code))return error.code;throw error;}
}
function createDesktopService({app,platform=process.platform,runHelper=defaultRunHelper}){
 let pending=null;
 async function create(){
  if(platform!=='win32'||!app.isPackaged)return {created:false,message:'Windows 설치 버전에서 사용할 수 있습니다.'};
  const target=app.getPath('exe'),root=path.dirname(target);
  const helper=path.join(root,'resources','desktop-launcher.exe');
  try{
   for(const file of [target,path.join(root,'Uninstall Allradione.exe'),helper,path.join(root,INSTALL_MARKER)]){
    const stat=await fs.lstat(file);if(!stat.isFile()||stat.isSymbolicLink())return {created:false,message:'Windows 설치 버전에서 사용할 수 있습니다.'};
   }
   if((await fs.readFile(path.join(root,INSTALL_MARKER),'utf8'))!==APP_ID)return {created:false,message:'Windows 설치 버전에서 사용할 수 있습니다.'};
   const actualRoot=await fs.realpath(root),actualHelper=await fs.realpath(helper);
   if(!sameWindowsPath(actualHelper,path.join(actualRoot,'resources','desktop-launcher.exe')))return {created:false,message:'Windows 설치 버전에서 사용할 수 있습니다.'};
   // The signed-in user's native helper validates PE ownership and shortcut targets.
   // Only its fixed desktop operation is available; renderer-provided paths never run.
   const code=await runHelper(helper,['--install-desktop','--quiet']);
   if(code===0)return {created:true,message:'바탕화면 실행 아이콘을 만들었습니다.'};
   if(code===2)return {created:false,message:'같은 이름의 다른 파일이 있어 덮어쓰지 않았습니다.'};
   if(code===3)return {created:false,message:'Windows 설치 버전에서 사용할 수 있습니다.'};
   return {created:false,message:'바탕화면 실행 아이콘을 만들지 못했습니다. 폴더 권한을 확인해 주세요.'};
  }catch{return {created:false,message:'바탕화면 실행 아이콘을 만들지 못했습니다. 폴더 권한을 확인해 주세요.'};}
 }
 return {createShortcut(){if(!pending)pending=create().finally(()=>{pending=null;});return pending;}};
}
module.exports={APP_ID,INSTALL_MARKER,sameWindowsPath,createDesktopService};
