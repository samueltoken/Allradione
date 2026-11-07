const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const {createCacheService,metadataFiles,treeBytes}=require('../electron/cache.cjs');
const {createRadio}=require('../electron/radio.cjs');
const {prepareDataDir,OWNER_FILE}=require('../electron/data.cjs');
const {APP_ID,INSTALL_MARKER,createDesktopService}=require('../electron/desktop.cjs');
async function temp(fn){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'allradione-install-test-'));try{return await fn(dir);}finally{await fs.rm(dir,{recursive:true,force:true});}}

test('cache cleanup removes only allowlisted metadata and preserves settings, favorites, unrelated files',()=>temp(async dir=>{
 await fs.writeFile(path.join(dir,'settings.json'),JSON.stringify({favorites:[{stationuuid:'fav-a',name:'Favorite'}],volume:.3}));
 await fs.writeFile(path.join(dir,'cache-countries.json'),'123456');await fs.writeFile(path.join(dir,'cache-stations-KR.json'),'1234');
 await fs.writeFile(path.join(dir,'cache-important.json'),'do not delete');await fs.writeFile(path.join(dir,'notes.txt'),'keep');
 const code=path.join(dir,'Code Cache');await fs.mkdir(code);await fs.writeFile(path.join(code,'compiled'),'abcdef');
 let http=123,clearCalls=0;const ses={getCacheSize:async()=>http,clearCache:async()=>{clearCalls++;http=0;},clearCodeCaches:async()=>{await fs.unlink(path.join(code,'compiled'));}};
 const service=createCacheService({ses,radio:createRadio(dir),dataDir:dir,codeCacheDir:code});
 const before=await service.info();assert.equal(before.totalBytes,139);assert.equal(before.metadataBytes,10);assert.equal(before.codeBytes,6);
 const result=await service.clear();assert.equal(result.freedBytes,139);assert.equal(result.afterBytes,0);assert.deepEqual(result.errors,[]);assert.equal(clearCalls,1);
 assert.equal(JSON.parse(await fs.readFile(path.join(dir,'settings.json'),'utf8')).favorites[0].stationuuid,'fav-a');assert.equal(await fs.readFile(path.join(dir,'notes.txt'),'utf8'),'keep');assert.equal(await fs.readFile(path.join(dir,'cache-important.json'),'utf8'),'do not delete');
}));

test('concurrent clears share one operation and report denied cache access honestly',()=>temp(async dir=>{
 let release;const gate=new Promise(resolve=>release=resolve);let clears=0;
 const ses={getCacheSize:async()=>{throw Error('denied');},clearCache:async()=>{clears++;await gate;throw Error('denied');},clearCodeCaches:async()=>{}};
 const service=createCacheService({ses,radio:{clearCache:async()=>{}},dataDir:dir,codeCacheDir:path.join(dir,'Code Cache')});
 const a=service.clear(),b=service.clear();assert.equal(a,b);release();const result=await a;assert.equal(clears,1);assert.ok(result.errors.length>=2);assert.equal(result.freedBytes,0);assert.equal((await service.info()).httpBytes,null);
}));

test('metadata enumeration and size accounting never follow symlinks',()=>temp(async dir=>{
 const outside=path.join(dir,'outside');await fs.mkdir(outside);await fs.writeFile(path.join(outside,'secret'),'123456789');
 const cache=path.join(dir,'cache');await fs.mkdir(cache);await fs.symlink(outside,path.join(cache,'linked-dir'),'junction');
 // Directory junctions work on Windows without developer-mode symlink privileges.
 // Exercise file links too wherever the OS permits them.
 try{await fs.symlink(path.join(outside,'secret'),path.join(cache,'cache-countries.json'));}catch(error){if(process.platform!=='win32'||!['EPERM','EACCES'].includes(error.code))throw error;}
 assert.equal(await treeBytes(cache),0);assert.deepEqual(await metadataFiles(cache),[]);
}));

test('portable settings handoff copies sanitized preferences once without modifying the old files',()=>temp(async dir=>{
 const old=path.join(dir,'portable'),data=path.join(dir,'profile');await fs.mkdir(path.join(old,'Allradione-data'),{recursive:true});
 const previous={volume:.4,favorites:[{stationuuid:'fav-a',name:'Station'}],unexpected:'discard'};const source=path.join(old,'Allradione-data','settings.json');await fs.writeFile(source,JSON.stringify(previous));
 const app={getPath:key=>key==='userData'?data:path.join(dir,'installed','Allradione.exe')};
 await prepareDataDir({app,env:{PORTABLE_EXECUTABLE_FILE:path.join(old,'Allradione.exe')}});
 const saved=JSON.parse(await fs.readFile(path.join(data,'settings.json'),'utf8'));assert.equal(saved.volume,.4);assert.equal(saved.favorites.length,1);assert.equal(saved.unexpected,undefined);assert.equal(await fs.readFile(path.join(data,OWNER_FILE),'utf8'),APP_ID);assert.deepEqual(JSON.parse(await fs.readFile(source,'utf8')),previous);
 await fs.writeFile(path.join(data,'settings.json'),JSON.stringify({volume:.9}));await prepareDataDir({app,env:{PORTABLE_EXECUTABLE_FILE:path.join(old,'Allradione.exe')}});assert.equal(JSON.parse(await fs.readFile(path.join(data,'settings.json'),'utf8')).volume,.9);
}));

async function installedFixture(dir){
 const exe=path.join(dir,'Allradione.exe');await fs.mkdir(path.join(dir,'resources'));
 for(const file of [exe,path.join(dir,'Uninstall Allradione.exe'),path.join(dir,'resources','desktop-launcher.exe')])await fs.writeFile(file,'MZtest');
 await fs.writeFile(path.join(dir,INSTALL_MARKER),APP_ID);return {isPackaged:true,getPath:key=>key==='exe'?exe:dir};
}
test('desktop creation invokes only the installed native helper and preserves its ownership-conflict result',()=>temp(async dir=>{
 const app=await installedFixture(dir),calls=[];let code=0;
 const service=createDesktopService({app,platform:'win32',runHelper:async(...args)=>{calls.push(args);return code;}});
 assert.equal((await service.createShortcut()).created,true);
 assert.deepEqual(calls[0],[path.join(dir,'resources','desktop-launcher.exe'),['--install-desktop','--quiet']]);
 code=2;assert.equal((await service.createShortcut()).created,false);
 assert.equal((await createDesktopService({app:{...app,isPackaged:false},platform:'win32',runHelper:()=>assert.fail('development must not run native files')}).createShortcut()).created,false);
 await fs.writeFile(path.join(dir,INSTALL_MARKER),'unrelated');assert.equal((await service.createShortcut()).created,false);assert.equal(calls.length,2);
}));
test('simultaneous desktop creation requests share one native operation',()=>temp(async dir=>{
 const app=await installedFixture(dir);let release,calls=0;const gate=new Promise(resolve=>{release=resolve;});
 const service=createDesktopService({app,platform:'win32',runHelper:async()=>{calls++;await gate;return 0;}});
 const first=service.createShortcut(),second=service.createShortcut();assert.equal(first,second);release();assert.equal((await first).created,true);assert.equal(calls,1);
}));
test('desktop creation refuses a resources junction that redirects the helper outside its installation',()=>temp(async dir=>{
 const app=await installedFixture(dir),outside=path.join(dir,'outside');
 await fs.rename(path.join(dir,'resources'),outside);await fs.symlink(outside,path.join(dir,'resources'),'junction');
 const service=createDesktopService({app,platform:'win32',runHelper:()=>assert.fail('Redirected helper must never execute')});
 assert.equal((await service.createShortcut()).created,false);
}));
