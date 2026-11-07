'use strict';
const {app,BrowserWindow,ipcMain,screen,Tray,Menu,nativeImage,shell,session}=require('electron');
const path=require('node:path');
const fs=require('node:fs/promises');
const {pathToFileURL}=require('node:url');
const {createStreamProxy}=require('./stream-proxy.cjs');
const {createPreferences}=require('./preferences.cjs');
const {createRadio,cleanStation}=require('./radio.cjs');
const {createUpdater}=require('./updater.cjs');
const {configurePermissions}=require('./permissions.cjs');
const {createCacheService}=require('./cache.cjs');
const {createDesktopService}=require('./desktop.cjs');
const {prepareDataDir}=require('./data.cjs');
const ROOT=path.join(__dirname,'..');
const INDEX=path.join(ROOT,'dist','index.html');
const DEV=process.env.ALLRADIONE_DEV_URL;
const ALLOWED_COMMANDS=new Set(['toggle-play','play','pause','next','previous','volume','favorite','show']);
let mainWindow,widgetWindow,tray,preferences,radio,proxy,updater,cacheService,desktopService,quitting=false;
let player={station:null,playing:false,status:'idle',volume:.7};
let widgetGeneration=0;
app.setAppUserModelId('io.github.samueltoken.allradione');
if(!app.requestSingleInstanceLock())app.quit();
else {
 app.on('second-instance',()=>showMain());
 app.whenReady().then(start).catch(error=>{console.error('Allradione startup failed:',error);app.quit();});
}
function isTrusted(event){
 const sender=event.sender;
 return (sender===mainWindow?.webContents||sender===widgetWindow?.webContents)&&event.senderFrame===sender.mainFrame;
}
function handle(channel,fn){ipcMain.handle(channel,(event,...args)=>{if(!isTrusted(event))throw new Error('Untrusted caller');return fn(event,...args);});}
function on(channel,fn){ipcMain.on(channel,(event,...args)=>{if(isTrusted(event))fn(event,...args);});}
function broadcastVisibility(){if(mainWindow&&!mainWindow.isDestroyed())mainWindow.webContents.send('player:command','window-visibility',mainWindow.isVisible()&&!mainWindow.isMinimized());}
function showMain(){if(mainWindow&&!mainWindow.isDestroyed()){if(mainWindow.isMinimized())mainWindow.restore();mainWindow.show();mainWindow.focus();}}

function configureWindow(win){
 win.webContents.setWindowOpenHandler(()=>({action:'deny'}));
 win.webContents.on('will-navigate',(event,url)=>{const current=win.webContents.getURL();if(url.split('?')[0]!==current.split('?')[0])event.preventDefault();});
 win.webContents.on('will-attach-webview',event=>event.preventDefault());
 win.webContents.on('render-process-gone',(_event,details)=>{
   if(quitting)return;
   if(win===mainWindow){player={...player,playing:false,status:'error',error:'재생 창이 중단됐어. 다시 연결해줘.'};broadcastState();win.reload();}
 });
}
function load(win,query){
 if(DEV&&!app.isPackaged){try{const url=new URL(DEV);if(url.protocol==='http:'&&['localhost','127.0.0.1'].includes(url.hostname)&&!url.username&&!url.password){for(const[k,v]of Object.entries(query||{}))url.searchParams.set(k,v);return win.loadURL(url.href);}}catch{}}
 return win.loadFile(INDEX,{query});
}
function createMain(){
 const primary=screen.getPrimaryDisplay().workArea;
 mainWindow=new BrowserWindow({width:Math.min(1440,primary.width),height:Math.min(960,primary.height),minWidth:960,minHeight:640,show:false,frame:false,backgroundColor:'#12100f',title:'Allradione',icon:path.join(ROOT,'assets','icon.png'),webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true,backgroundThrottling:false,webSecurity:true}});
 mainWindow.removeMenu();configureWindow(mainWindow);
 mainWindow.once('ready-to-show',()=>mainWindow.show());
 mainWindow.on('close',event=>{
   if(quitting)return;
   if(widgetWindow&&!widgetWindow.isDestroyed()){event.preventDefault();mainWindow.hide();}
 });
 mainWindow.on('closed',()=>{mainWindow=null;if(!widgetWindow)app.quit();});
 for(const event of ['show','hide','minimize','restore'])mainWindow.on(event,broadcastVisibility);
 mainWindow.webContents.on('did-finish-load',()=>{broadcastState();broadcastVisibility();});
 load(mainWindow);
}
function anchorWidget(){
 if(!widgetWindow||widgetWindow.isDestroyed())return;
 const bounds=mainWindow&&!mainWindow.isDestroyed()?mainWindow.getBounds():screen.getPrimaryDisplay().workArea;
 const area=screen.getDisplayMatching(bounds).workArea;
 const size=widgetWindow.getSize();widgetWindow.setPosition(area.x+area.width-size[0]-20,area.y+area.height-size[1]-20,false);
 widgetWindow.setAlwaysOnTop(true,'screen-saver');
}
async function setWidget(enabled,size){
 const generation=++widgetGeneration;
 await preferences.save({widgetEnabled:Boolean(enabled),widgetSize:size});
 broadcastPreferences();
 if(generation!==widgetGeneration)return;
 if(widgetWindow&&!widgetWindow.isDestroyed()){widgetWindow.destroy();widgetWindow=null;}
 if(!enabled){showMain();return;}
 const medium=size==='medium';
 widgetWindow=new BrowserWindow({width:medium?460:176,height:medium?230:190,resizable:false,movable:false,show:false,frame:false,transparent:true,backgroundColor:'#00000000',hasShadow:false,roundedCorners:false,skipTaskbar:true,alwaysOnTop:true,focusable:true,title:'Allradione · Widget',webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true,backgroundThrottling:false,webSecurity:true}});
 configureWindow(widgetWindow);anchorWidget();
 widgetWindow.setVisibleOnAllWorkspaces(true,{visibleOnFullScreen:true});
 const current=widgetWindow;
 current.once('ready-to-show',()=>{if(!current.isDestroyed()){anchorWidget();current.showInactive();broadcastState();}});
 current.webContents.on('did-finish-load',()=>broadcastState());
 current.on('closed',()=>{if(widgetWindow===current)widgetWindow=null;});
 await load(current,{widget:medium?'medium':'small'});
}
function broadcastPreferences(){const current=preferences.get();for(const win of [mainWindow,widgetWindow])if(win&&!win.isDestroyed())win.webContents.send('player:command','preferences-changed',current);}
function broadcastState(){if(widgetWindow&&!widgetWindow.isDestroyed())widgetWindow.webContents.send('player:state',player);}
function sanitizeState(value){
 if(!value||typeof value!=='object')return null;
 const statuses=['idle','connecting','playing','paused','error'];
 return {station:cleanStation(value.station),playing:Boolean(value.playing),status:statuses.includes(value.status)?value.status:'idle',volume:Math.min(1,Math.max(0,Number(value.volume)||0)),error:typeof value.error==='string'?value.error.slice(0,400):undefined,spectrum:Array.isArray(value.spectrum)?value.spectrum.slice(0,96).map(x=>Math.min(255,Math.max(0,Number(x)||0))):undefined};
}
async function start(){
 const dataDir=await prepareDataDir({app});
 // A legacy portable may launch Setup with its environment still attached.
 // Once the NSIS-installed executable is running, that variable is only migration input.
 if(app.isPackaged){try{if((await fs.stat(path.join(path.dirname(app.getPath('exe')),'Uninstall Allradione.exe'))).isFile())delete process.env.PORTABLE_EXECUTABLE_FILE;}catch{}}
 preferences=await createPreferences(dataDir);radio=createRadio(dataDir);proxy=await createStreamProxy();updater=createUpdater({app,shell,dataDir});
 const codeCacheDir=path.join(dataDir,'Code Cache');
 session.defaultSession.setCodeCachePath(codeCacheDir);
 cacheService=createCacheService({ses:session.defaultSession,radio,dataDir,codeCacheDir});
 desktopService=createDesktopService({app,shell});
 let devUrl;
 if(DEV&&!app.isPackaged){try{const u=new URL(DEV);if(u.protocol==='http:'&&['localhost','127.0.0.1'].includes(u.hostname)&&!u.username&&!u.password)devUrl=u;}catch{}}
 configurePermissions(session.defaultSession,{getWindows:()=>[mainWindow,widgetWindow],documentUrl:devUrl?.href||pathToFileURL(INDEX).href,proxyEndpoint:proxy.url('https://example.com/'),devOrigin:devUrl?.origin});
 player.volume=preferences.get().volume;
 handle('preferences:get',()=>preferences.get());
 handle('preferences:save',async(_e,patch)=>{const saved=await preferences.save(patch);broadcastPreferences();return saved;});
 handle('radio:countries',()=>radio.countries());
 handle('radio:stations',(_e,code)=>radio.stations(String(code)));
 handle('radio:stream',(_e,url)=>proxy.url(url));
 handle('radio:click',(_e,id)=>radio.click(id));
 handle('widget:set',(_e,enabled,size)=>setWidget(Boolean(enabled),size==='medium'?'medium':'small'));
 handle('app:version',()=>app.getVersion());
 handle('player:get',()=>player);
 handle('update:check',()=>updater.checkUpdate());
 handle('update:install',()=>updater.installUpdate());
 handle('cache:info',()=>cacheService.info());
 handle('cache:clear',()=>cacheService.clear());
 handle('desktop:shortcut',()=>desktopService.createShortcut());
 handle('external:open',async(_e,raw)=>{
  const u=new URL(String(raw));if(u.protocol!=='https:'&&u.protocol!=='http:')throw new Error('Unsupported link');if(u.username||u.password)throw new Error('Invalid link');await shell.openExternal(u.href);
 });
 on('player:publish',(event,value)=>{if(event.sender!==mainWindow?.webContents)return;const state=sanitizeState(value);if(state){player=state;broadcastState();}});
 on('player:command',(_event,command,value)=>{
  if(!ALLOWED_COMMANDS.has(command))return;
  if(command==='show'){showMain();return;}
  if(command==='volume')value=Math.max(0,Math.min(1,Number(value)||0));else value=undefined;
  if(mainWindow&&!mainWindow.isDestroyed())mainWindow.webContents.send('player:command',command,value);
 });
 on('window:action',(_event,action)=>{
  if(action==='show')showMain();
  else if(mainWindow&&!mainWindow.isDestroyed()){
   if(action==='minimize')mainWindow.minimize();
   else if(action==='maximize')mainWindow.isMaximized()?mainWindow.unmaximize():mainWindow.maximize();
   else if(action==='close')mainWindow.close();
  }
 });
 createMain();
 const icon=nativeImage.createFromPath(path.join(ROOT,'assets','icon.png'));
 if(!icon.isEmpty()){
  tray=new Tray(icon.resize({width:24,height:24}));tray.setToolTip('Allradione');
  tray.setContextMenu(Menu.buildFromTemplate([{label:'Allradione 열기',click:showMain},{label:'재생 / 일시정지',click:()=>mainWindow?.webContents.send('player:command','toggle-play')},{type:'separator'},{label:'종료',click:()=>{quitting=true;app.quit();}}]));
  tray.on('double-click',showMain);
 }
 if(preferences.get().widgetEnabled)await setWidget(true,preferences.get().widgetSize);
 for(const event of ['display-added','display-removed','display-metrics-changed'])screen.on(event,anchorWidget);
}
app.on('before-quit',()=>{quitting=true;proxy?.close();});
app.on('activate',()=>mainWindow?showMain():createMain());
app.on('window-all-closed',()=>{if(process.platform!=='darwin')app.quit();});
