'use strict';
// Run with Electron, not node:test. Real decoded PCM exercises the production
// loopback proxy, permission policy and perceptual display processor offline.
const {app,BrowserWindow,session}=require('electron');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const {pathToFileURL}=require('node:url');
const {Readable}=require('node:stream');
const {createStreamProxy}=require('../electron/stream-proxy.cjs');
const {configurePermissions}=require('../electron/permissions.cjs');
const ts=require('typescript');
let proxy,window,temp;
const timeout=setTimeout(()=>finish(1,{error:'Native audio smoke timed out'}),30000);
function wav(kind){
 const rate=44100,samples=rate*3,buffer=Buffer.alloc(44+samples*2),pcm=new Float32Array(samples);
 buffer.write('RIFF',0);buffer.writeUInt32LE(buffer.length-8,4);buffer.write('WAVEfmt ',8);buffer.writeUInt32LE(16,16);buffer.writeUInt16LE(1,20);buffer.writeUInt16LE(1,22);buffer.writeUInt32LE(rate,24);buffer.writeUInt32LE(rate*2,28);buffer.writeUInt16LE(2,32);buffer.writeUInt16LE(16,34);buffer.write('data',36);buffer.writeUInt32LE(samples*2,40);
 const harmonics=kind==='tone'?1:kind==='lowpass-classical'?25:100;let peak=0;
 for(let i=0;i<rate*1.1;i++){
  const t=i/rate;let value=0;
  for(let h=1;h<=harmonics;h++)value+=Math.sin(t*2*Math.PI*(kind==='tone'?440:110*h)+h*.71)/Math.pow(h,.65);
  // Bowed-string-like partials under a phrase envelope, then exact PCM silence.
  value*=.65+.35*Math.sin(t*3)**2;pcm[i]=value;peak=Math.max(peak,Math.abs(value));
 }
 for(let i=0;i<samples;i++)buffer.writeInt16LE(Math.round(pcm[i]/peak*18000),44+i*2);
 return buffer;
}
async function finish(code,result){clearTimeout(timeout);console.log(JSON.stringify({nativeAudioSmoke:code===0,...result}));proxy?.close();window?.destroy();if(temp)await fs.rm(temp,{recursive:true,force:true});app.exit(code);}
app.whenReady().then(async()=>{
 temp=await fs.mkdtemp(path.join(os.tmpdir(),'allradione-native-audio-'));
 const file=path.join(temp,'index.html');await fs.writeFile(file,'<!doctype html><html><meta charset="utf-8"><title>Allradione audio smoke</title><body></body></html>');
 const spectrumSource=await fs.readFile(path.join(__dirname,'../src/spectrum.ts'),'utf8');
 const spectrumScript=ts.transpileModule(spectrumSource,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
 const fixtures=Object.fromEntries(['tone','wideband','lowpass-classical'].map(kind=>[kind,wav(kind)]));let proxyRequests=0;
 proxy=await createStreamProxy({request:async(url)=>{proxyRequests++;const fixture=fixtures[new URL(url).pathname.split('/').pop().replace('.wav','')];const response=Readable.from([fixture]);response.statusCode=200;response.headers={'content-type':'audio/wav','content-length':String(fixture.length),'accept-ranges':'bytes'};return{response,url};}});
 window=new BrowserWindow({show:false,webPreferences:{contextIsolation:true,sandbox:true,nodeIntegration:false,backgroundThrottling:false}});
 const sources=Object.fromEntries(Object.keys(fixtures).map(kind=>[kind,proxy.url('https://audio-fixture.example/'+kind+'.wav')]));
 configurePermissions(session.defaultSession,{getWindows:()=>[window],documentUrl:pathToFileURL(file).href,proxyEndpoint:sources.tone});
 await window.loadFile(file);
 const result=await window.webContents.executeJavaScript(`(async()=>{
  const {RadioSpectrum}=(()=>{const exports={};${spectrumScript};return exports;})();
  const context=new AudioContext();await context.resume();const cases=[];
  const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  for(const [kind,url] of Object.entries(${JSON.stringify(sources)})){
   const audio=new Audio();audio.crossOrigin='anonymous';audio.src=url;
   const node=context.createMediaElementSource(audio);const analyser=context.createAnalyser();analyser.fftSize=2048;analyser.smoothingTimeConstant=.15;node.connect(analyser);analyser.connect(context.destination);
   const frequencies=new Float32Array(analyser.frequencyBinCount),waveform=new Float32Array(analyser.fftSize);
   const spectrum=new RadioSpectrum(context.sampleRate,analyser.fftSize);
   function sample(){analyser.getFloatFrequencyData(frequencies);analyser.getFloatTimeDomainData(waveform);const rms=Math.sqrt(waveform.reduce((sum,value)=>sum+value*value,0)/waveform.length);return{rms,levels:spectrum.process(frequencies,rms).slice()};}
   await audio.play();await wait(300);
   let reading;for(let i=0;i<5;i++){reading=sample();await wait(50);}
   const spectrumMax=Math.max(...reading.levels),peakBand=reading.levels.indexOf(spectrumMax);
   const measured={kind,readyState:audio.readyState,paused:audio.paused,currentTime:audio.currentTime,spectrumMax,rms:reading.rms,peakFrequency:spectrum.centers[peakBand],lastBand:reading.levels[31],activeBands:reading.levels.filter(value=>value>.12).length,boundedSpectrum:reading.levels.length===32&&reading.levels.every(value=>Number.isFinite(value)&&value>=0&&value<=1)};
   audio.volume=0;await wait(120);measured.mutedRms=sample().rms;audio.volume=1;
   await wait(Math.max(0,(1.4-audio.currentTime)*1000));
   for(let i=0;i<20;i++){reading=sample();await wait(50);}
   measured.silentRms=reading.rms;measured.silentMax=Math.max(...reading.levels);
   audio.pause();await wait(100);measured.pausedRms=sample().rms;
   audio.src='';node.disconnect();analyser.disconnect();cases.push(measured);
  }
  let unownedLoopbackBlocked;try{await fetch(${JSON.stringify(new URL(sources.tone).origin+'/not-our-token')});unownedLoopbackBlocked=false;}catch{unownedLoopbackBlocked=true;}
  const result={contextState:context.state,cases,unownedLoopbackBlocked};await context.close();return result;
 })()`,true);
 const goodCase=item=>item.readyState>=2&&!item.paused&&item.currentTime>0&&item.spectrumMax>.6&&item.rms>.01&&item.boundedSpectrum&&item.silentMax===0&&item.mutedRms<1e-6&&item.silentRms<1e-6&&item.pausedRms<1e-6;
 const tone=result.cases.find(item=>item.kind==='tone');
 const music=result.cases.filter(item=>item.kind!=='tone');
 const ok=result.contextState==='running'&&result.cases.every(goodCase)&&Math.abs(Math.log2(tone.peakFrequency/440))<.4&&music.every(item=>item.lastBand>.15&&item.activeBands>=24)&&result.unownedLoopbackBlocked&&proxyRequests>=3;
 await finish(ok?0:1,{...result,proxyRequests});
}).catch(error=>finish(1,{error:error.stack}));
