'use strict';
const {contextBridge,ipcRenderer}=require('electron');
const subscribe=(channel,callback)=>(ipcRenderer.on(channel,callback),()=>ipcRenderer.removeListener(channel,callback));
contextBridge.exposeInMainWorld('allradione',{
 getPreferences:()=>ipcRenderer.invoke('preferences:get'),
 savePreferences:patch=>ipcRenderer.invoke('preferences:save',patch),
 countries:()=>ipcRenderer.invoke('radio:countries'),
 stations:code=>ipcRenderer.invoke('radio:stations',code),
 streamUrl:url=>ipcRenderer.invoke('radio:stream',url),
 stationClick:id=>ipcRenderer.invoke('radio:click',id),
 setWidget:(enabled,size)=>ipcRenderer.invoke('widget:set',enabled,size),
 resizeWidget:(width,save,relative)=>ipcRenderer.invoke('widget:resize',width,save,relative===true),
 publishPlayer:state=>ipcRenderer.send('player:publish',state),
 onPlayer:fn=>{let active=true;const off=subscribe('player:state',(_event,state)=>{if(active)fn(state);});ipcRenderer.invoke('player:get').then(state=>{if(active)fn(state);}).catch(()=>{});return()=>{active=false;off();};},
 sendCommand:(command,value)=>ipcRenderer.send('player:command',command,value),
 onCommand:fn=>subscribe('player:command',(_event,command,value)=>fn(command,value)),
 windowAction:action=>ipcRenderer.send('window:action',action),
 checkUpdate:()=>ipcRenderer.invoke('update:check'),
 installUpdate:()=>ipcRenderer.invoke('update:install'),
 cacheInfo:()=>ipcRenderer.invoke('cache:info'),
 clearCache:()=>ipcRenderer.invoke('cache:clear'),
 createDesktopShortcut:()=>ipcRenderer.invoke('desktop:shortcut'),
 openExternal:url=>ipcRenderer.invoke('external:open',url),
 version:()=>ipcRenderer.invoke('app:version')
});
