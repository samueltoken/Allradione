'use strict';
// Run with Electron, not node:test. Exercises the production loopback proxy and
// permission policy with real decoded PCM audio, without public network access.
const {app,BrowserWindow,session}=require('electron');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const {pathToFileURL}=require('node:url');
const {Readable}=require('node:stream');
const {createStreamProxy}=require('../electron/stream-proxy.cjs');
const {configurePermissions}=require('../electron/permissions.cjs');
let proxy,window,temp;
const timeout=setTimeout(()=>finish(1,{error:'Native audio smoke timed out'}),25000);
function wav(){
 const rate=44100,samples=rate*4,buffer=Buffer.alloc(44+samples*2);
 buffer.write('RIFF',0);buffer.writeUInt32LE(buffer.length-8,4);buffer.write('WAVEfmt ',8);buffer.writeUInt32LE(16,16);buffer.writeUInt16LE(1,20);buffer.writeUInt16LE(1,22);buffer.writeUInt32LE(rate,24);buffer.writeUInt32LE(rate*2,28);buffer.writeUInt16LE(2,32);buffer.writeUInt16LE(16,34);buffer.write('data',36);buffer.writeUInt32LE(samples*2,40);
 for(let i=0;i<samples;i++)buffer.writeInt16LE(Math.round(Math.sin(i*2*Math.PI*440/rate)*12000),44+i*2);
 return buffer;
}
async function finish(code,result){clearTimeout(timeout);console.log(JSON.stringify({nativeAudioSmoke:code===0,...result}));proxy?.close();window?.destroy();if(temp)await fs.rm(temp,{recursive:true,force:true});app.exit(code);}
app.whenReady().then(async()=>{
 temp=await fs.mkdtemp(path.join(os.tmpdir(),'allradione-native-audio-'));
 const file=path.join(temp,'index.html');await fs.writeFile(file,'<!doctype html><html><meta charset="utf-8"><title>Allradione audio smoke</title><body></body></html>');
 const fixture=wav();let proxyRequests=0;
 proxy=await createStreamProxy({request:async(url)=>{proxyRequests++;const response=Readable.from([fixture]);response.statusCode=200;response.headers={'content-type':'audio/wav','content-length':String(fixture.length),'accept-ranges':'bytes'};return{response,url};}});
 window=new BrowserWindow({show:false,webPreferences:{contextIsolation:true,sandbox:true,nodeIntegration:false,backgroundThrottling:false}});
 const source=proxy.url('https://audio-fixture.example/tone.wav');
 configurePermissions(session.defaultSession,{getWindows:()=>[window],documentUrl:pathToFileURL(file).href,proxyEndpoint:source});
 await window.loadFile(file);
 const result=await window.webContents.executeJavaScript(`(async()=>{
  const audio=new Audio();audio.crossOrigin='anonymous';audio.src=${JSON.stringify(source)};
  const context=new AudioContext();const node=context.createMediaElementSource(audio);const analyser=context.createAnalyser();analyser.fftSize=1024;node.connect(analyser);analyser.connect(context.destination);
  await context.resume();await audio.play();
  await new Promise(resolve=>setTimeout(resolve,450));
  const frequencies=new Uint8Array(analyser.frequencyBinCount);analyser.getByteFrequencyData(frequencies);
  const result={readyState:audio.readyState,paused:audio.paused,currentTime:audio.currentTime,contextState:context.state,spectrumMax:Math.max(...frequencies)};
  try{await fetch(${JSON.stringify(new URL(source).origin+'/not-our-token')});result.unownedLoopbackBlocked=false;}catch{result.unownedLoopbackBlocked=true;}
  audio.pause();audio.src='';await context.close();return result;
 })()`,true);
 const ok=result.readyState>=2&&!result.paused&&result.currentTime>0&&result.contextState==='running'&&result.spectrumMax>0&&result.unownedLoopbackBlocked&&proxyRequests>0;
 await finish(ok?0:1,{...result,proxyRequests});
}).catch(error=>finish(1,{error:error.stack}));
