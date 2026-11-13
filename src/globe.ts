import { region, t } from './i18n';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { feature } from 'topojson-client';
import { numericToAlpha2 } from 'i18n-iso-countries';
import atlas from 'world-atlas/countries-50m.json';
import type { FeatureCollection, Polygon, MultiPolygon } from 'geojson';
import type { Topology, GeometryCollection } from 'topojson-specification';
import type { Country } from './types';
import { preparePolygon, countryAt, countryCenter, type GlobeCountry } from './globe-geo';
import { flagUrl } from './flags';
import './globe.css';

const WORLD = feature(atlas as unknown as Topology, atlas.objects.countries as unknown as GeometryCollection) as FeatureCollection<Polygon|MultiPolygon>;
const COUNTRIES:GlobeCountry[] = WORLD.features.map(item=>{
  const polygons=(item.geometry.type==='Polygon'?[item.geometry.coordinates]:item.geometry.coordinates).map(preparePolygon);
  let code=numericToAlpha2(String(item.id).padStart(3,'0'))??'';
  if(item.properties?.name==='Kosovo')code='XK';
  return {code,name:String(item.properties?.name??''),polygons,center:countryCenter(polygons)};
});

/** Bundled physical globe: no tile server, geolocation or network texture dependency. */
export class RadioGlobe {
  private container:HTMLElement;
  private onSelect:(code:string)=>void;
  private renderer?:THREE.WebGLRenderer;
  private scene=new THREE.Scene();
  private camera=new THREE.PerspectiveCamera(38,1,.1,100);
  private controls?:OrbitControls;
  private sphere?:THREE.Mesh<THREE.SphereGeometry,THREE.MeshStandardMaterial>;
  private texture?:THREE.CanvasTexture;
  private mapCanvas=document.createElement('canvas');
  private paths=new Map<GlobeCountry,Path2D>();
  private tooltip=document.createElement('div');
  private tooltipKey='';
  private available=new Map<string,Country>();
  private selected='';
  private hovered='';
  private pointer=new THREE.Vector2();
  private raycaster=new THREE.Raycaster();
  private resizeObserver?:ResizeObserver;
  private intersectionObserver?:IntersectionObserver;
  private disposed=false;
  private visible=true;
  private active=true;
  private reducedMotion=false;
  private dragging=false;
  private pointerStart?:{x:number;y:number;id:number};
  private frame=0;
  private lastFrame=0;
  private lastHover=0;
  private cancelFocus=false;
  private focusTarget?:THREE.Vector3;

  constructor(container:HTMLElement,onSelect:(code:string)=>void){
    this.container=container;this.onSelect=onSelect;
    container.classList.add('radio-globe');
    this.tooltip.className='globe-tooltip';
    this.tooltip.setAttribute('aria-live','polite');
    this.tooltip.setAttribute('role','status');
    this.mapCanvas.width=2048;this.mapCanvas.height=1024;
    this.createPaths();
    try{this.createScene();}catch(error){
      this.renderer?.dispose();
      this.renderer=undefined;
      container.replaceChildren();
      const fallback=document.createElement('div');fallback.className='globe-fallback';
      const label=document.createElement('p');label.textContent=t('지구본을 불러올 수 없습니다.');fallback.append(label);container.append(fallback);
      console.warn('Allradione: WebGL unavailable. Country list remains usable.',error);
      return;
    }
    container.append(this.tooltip);
    this.resizeObserver=new ResizeObserver(()=>this.resize());this.resizeObserver.observe(container);
    this.intersectionObserver=new IntersectionObserver(entries=>{
      this.visible=entries.some(entry=>entry.isIntersecting);
      if(this.visible)this.requestFrame();else this.stopFrame();
    });this.intersectionObserver.observe(container);
    document.addEventListener('visibilitychange',this.onVisibility);
    this.resize();this.requestFrame();
  }

  setCountries(countries:Country[]):void{
    this.available=new Map(countries.filter(c=>c.stationcount>0).map(c=>[c.code.toUpperCase(),c]));
    if(this.hovered)this.showCountry(COUNTRIES.find(country=>country.code===this.hovered));
  }
  selectCountry(code:string):void{
    this.selected=code.toUpperCase();this.paintMap();
    const country=COUNTRIES.find(c=>c.code===this.selected);
    if(!country||!this.controls)return;
    const [lon,lat]=country.center;
    const distance=this.camera.position.length();
    this.focusTarget=this.direction(lat,lon).multiplyScalar(distance);
    this.cancelFocus=false;
    if(this.reducedMotion){this.camera.position.copy(this.focusTarget);this.focusTarget=undefined;this.controls.update();}
    this.requestFrame();
  }
  /** Positive delta moves closer; negative delta moves farther away. */
  zoom(delta:number):void{
    if(!this.controls)return;
    this.focusTarget=undefined;
    const distance=THREE.MathUtils.clamp(this.camera.position.length()*Math.exp(-delta*.18),this.controls.minDistance,this.controls.maxDistance);
    this.camera.position.setLength(distance);this.controls.update();this.requestFrame();
  }
  reset():void{
    this.focusTarget=undefined;this.selected='';this.hovered='';
    this.camera.position.copy(this.direction(18,105).multiplyScalar(3.5));
    this.controls?.target.set(0,0,0);this.controls?.update();this.paintMap();this.hideTooltip();this.requestFrame();
  }
  setReducedMotion(value:boolean):void{
    if(this.reducedMotion===value)return;
    this.reducedMotion=value;
    if(this.controls)this.controls.enableDamping=!value;
    this.requestFrame();
  }
  /** Native window visibility is explicit because audio keeps background throttling off. */
  setActive(value:boolean):void{
    if(this.disposed||this.active===value)return;
    this.active=value;
    if(value){this.resize();this.requestFrame();}
    else {this.stopFrame();this.hideTooltip();}
  }
  destroy():void{
    if(this.disposed)return;this.disposed=true;this.stopFrame();
    this.resizeObserver?.disconnect();this.intersectionObserver?.disconnect();
    document.removeEventListener('visibilitychange',this.onVisibility);
    const canvas=this.renderer?.domElement;
    canvas?.removeEventListener('pointerdown',this.onPointerDown);
    canvas?.removeEventListener('pointerup',this.onPointerUp);
    canvas?.removeEventListener('pointermove',this.onPointerMove);
    canvas?.removeEventListener('pointerleave',this.onPointerLeave);
    canvas?.removeEventListener('pointercancel',this.onPointerCancel);
    canvas?.removeEventListener('keydown',this.onKeyDown);
    canvas?.removeEventListener('wheel',this.onWheel);
    this.controls?.removeEventListener('start',this.onControlStart);
    this.controls?.removeEventListener('end',this.onControlEnd);
    this.controls?.removeEventListener('change',this.onControlChange);
    this.controls?.dispose();
    this.scene.traverse(object=>{
      const mesh=object as THREE.Mesh;
      mesh.geometry?.dispose();
      if(Array.isArray(mesh.material))mesh.material.forEach(material=>material.dispose());else mesh.material?.dispose();
    });
    this.texture?.dispose();this.renderer?.dispose();this.renderer?.forceContextLoss();
    this.container.replaceChildren();this.container.classList.remove('radio-globe');this.paths.clear();
  }

  private direction(lat:number,lon:number):THREE.Vector3{
    const phi=THREE.MathUtils.degToRad(lat),theta=THREE.MathUtils.degToRad(lon);
    return new THREE.Vector3(Math.cos(phi)*Math.cos(theta),Math.sin(phi),-Math.cos(phi)*Math.sin(theta));
  }
  private createScene():void{
    this.renderer=new THREE.WebGLRenderer({antialias:true,alpha:true,powerPreference:'low-power'});
    const pixelRatio=Math.min(window.devicePixelRatio||1,2);
    if(this.renderer.getPixelRatio()!==pixelRatio)this.renderer.setPixelRatio(pixelRatio);
    this.renderer.setClearColor(0x000000,0);
    this.renderer.outputColorSpace=THREE.SRGBColorSpace;
    const canvas=this.renderer.domElement;canvas.tabIndex=0;
    canvas.setAttribute('role','application');canvas.setAttribute('aria-label',t('세계 라디오 지구본. 드래그로 회전, 휠로 확대 축소, 국가 클릭. 방향키로 회전하고 Enter로 중앙 국가 선택.'));
    this.container.append(canvas);
    this.texture=new THREE.CanvasTexture(this.mapCanvas);this.texture.colorSpace=THREE.SRGBColorSpace;
    this.texture.anisotropy=Math.min(4,this.renderer.capabilities.getMaxAnisotropy());
    this.paintMap();
    this.sphere=new THREE.Mesh(new THREE.SphereGeometry(1,96,64),new THREE.MeshStandardMaterial({map:this.texture,roughness:.94,metalness:.03}));
    this.scene.add(this.sphere);
    this.scene.add(new THREE.AmbientLight(0xffc3a4,1.5));
    const key=new THREE.DirectionalLight(0xfff1d8,2.4);key.position.set(-2,3,4);this.scene.add(key);
    const rim=new THREE.DirectionalLight(0xff4323,1.6);rim.position.set(3,0,-2);this.scene.add(rim);
    // A small rim only, so country edges and true land shapes stay legible.
    const atmosphere=new THREE.Mesh(new THREE.SphereGeometry(1.011,64,48),new THREE.ShaderMaterial({
      uniforms:{rimColor:{value:new THREE.Color('#ed4c30')}},
      vertexShader:'varying vec3 normalView; varying vec3 viewDir; void main(){ vec4 mv=modelViewMatrix*vec4(position,1.0); normalView=normalize(normalMatrix*normal); viewDir=normalize(-mv.xyz); gl_Position=projectionMatrix*mv; }',
      fragmentShader:'uniform vec3 rimColor; varying vec3 normalView; varying vec3 viewDir; void main(){ float rim=pow(1.0-abs(dot(normalize(normalView),normalize(viewDir))),4.0); gl_FragColor=vec4(rimColor,rim*0.35); }',
      transparent:true,depthWrite:false,blending:THREE.AdditiveBlending
    }));this.scene.add(atmosphere);
    this.camera.position.copy(this.direction(18,105).multiplyScalar(3.5));
    this.controls=new OrbitControls(this.camera,canvas);
    this.controls.enablePan=false;this.controls.enableDamping=true;this.controls.dampingFactor=.065;
    this.controls.autoRotate=false;
    this.controls.rotateSpeed=.55;this.controls.zoomSpeed=.65;
    this.controls.minDistance=1.65;this.controls.maxDistance=5.8;
    this.controls.minPolarAngle=.05;this.controls.maxPolarAngle=Math.PI-.05;
    this.controls.addEventListener('start',this.onControlStart);this.controls.addEventListener('end',this.onControlEnd);this.controls.addEventListener('change',this.onControlChange);
    canvas.addEventListener('pointerdown',this.onPointerDown);canvas.addEventListener('pointerup',this.onPointerUp);
    canvas.addEventListener('pointermove',this.onPointerMove);canvas.addEventListener('pointerleave',this.onPointerLeave);
    canvas.addEventListener('pointercancel',this.onPointerCancel);canvas.addEventListener('keydown',this.onKeyDown);
    canvas.addEventListener('wheel',this.onWheel,{passive:true});
  }
  private createPaths():void{
    const width=this.mapCanvas.width,height=this.mapCanvas.height;
    for(const country of COUNTRIES){
      const path=new Path2D();
      for(const polygon of country.polygons){
        for(const offset of [-720,-360,0,360,720]){
          if(polygon.bounds[2]+offset< -180||polygon.bounds[0]+offset>180)continue;
          for(const ring of polygon.rings){
            ring.points.forEach(([lon,lat],i)=>{
              const x=(lon+offset+180)/360*width,y=(90-lat)/180*height;
              if(i===0)path.moveTo(x,y);else path.lineTo(x,y);
            });path.closePath();
          }
        }
      }
      this.paths.set(country,path);
    }
  }
  private paintMap():void{
    const ctx=this.mapCanvas.getContext('2d');if(!ctx)return;
    const {width,height}=this.mapCanvas;
    ctx.fillStyle='#642b24';ctx.fillRect(0,0,width,height);
    ctx.strokeStyle='#b447302e';ctx.lineWidth=.7;ctx.beginPath();
    for(let lon=-180;lon<=180;lon+=15){const x=(lon+180)/360*width;ctx.moveTo(x,0);ctx.lineTo(x,height);}
    for(let lat=-75;lat<=75;lat+=15){const y=(90-lat)/180*height;ctx.moveTo(0,y);ctx.lineTo(width,y);}ctx.stroke();
    for(const country of COUNTRIES){
      const path=this.paths.get(country)!;
      ctx.fillStyle=country.code&&country.code===this.selected?'#f5e5b4':country.code&&country.code===this.hovered?'#ffad73':'#ee5638';
      ctx.fill(path,'evenodd');ctx.strokeStyle='#7e3127';ctx.lineWidth=.9;ctx.stroke(path);
    }
    if(this.texture)this.texture.needsUpdate=true;
    this.requestFrame();
  }
  private resize():void{
    if(!this.renderer||this.disposed)return;
    const width=Math.max(1,this.container.clientWidth),height=Math.max(1,this.container.clientHeight);
    const pixelRatio=Math.min(window.devicePixelRatio||1,2);
    if(this.renderer.getPixelRatio()!==pixelRatio)this.renderer.setPixelRatio(pixelRatio);
    this.renderer.setSize(width,height,false);this.camera.aspect=width/height;
    this.camera.updateProjectionMatrix();this.requestFrame();
  }
  private pick(x:number,y:number):GlobeCountry|undefined{
    if(!this.renderer||!this.sphere)return;
    const rect=this.renderer.domElement.getBoundingClientRect();
    this.pointer.set((x-rect.left)/rect.width*2-1,-(y-rect.top)/rect.height*2+1);
    this.camera.updateMatrixWorld();this.raycaster.setFromCamera(this.pointer,this.camera);
    const hit=this.raycaster.intersectObject(this.sphere,false)[0];if(!hit)return;
    const point=hit.point.normalize();
    const lat=THREE.MathUtils.radToDeg(Math.asin(point.y));
    const lon=THREE.MathUtils.radToDeg(Math.atan2(-point.z,point.x));
    return countryAt(COUNTRIES,lon,lat);
  }
  private showCountry(country?:GlobeCountry):void{
    const code=country?.code??'';
    if(this.hovered!==code){this.hovered=code;this.paintMap();}
    if(!country){this.hideTooltip();return;}
    const info=this.available.get(code);
    const tooltipKey=`${code}:${info?.name??country.name}`;
    if(this.tooltipKey!==tooltipKey){
      this.tooltipKey=tooltipKey;this.tooltip.replaceChildren();
      const source=flagUrl(code);
      if(source){const flag=document.createElement('img');flag.className='globe-tooltip-flag';flag.src=source;flag.alt='';flag.width=24;flag.height=18;flag.addEventListener('error',()=>flag.remove(),{once:true});this.tooltip.append(flag);}
      const name=document.createElement('span');name.className='globe-tooltip-name';name.textContent=code?region(code):country.name;this.tooltip.append(name);
    }
    this.tooltip.classList.add('is-visible');
    if(this.renderer)this.renderer.domElement.style.cursor=code?'pointer':'grab';
  }
  private hideTooltip():void{this.tooltip.classList.remove('is-visible');if(this.renderer)this.renderer.domElement.style.cursor=this.dragging?'grabbing':'grab';}
  private onPointerDown=(event:PointerEvent):void=>{if(event.button!==0)return;this.pointerStart={x:event.clientX,y:event.clientY,id:event.pointerId};this.cancelFocus=true;};
  private onPointerUp=(event:PointerEvent):void=>{
    const start=this.pointerStart;this.pointerStart=undefined;
    if(!start||start.id!==event.pointerId||Math.hypot(event.clientX-start.x,event.clientY-start.y)>7)return;
    const country=this.pick(event.clientX,event.clientY);
    if(country?.code){this.selected=country.code;this.paintMap();this.onSelect(country.code);}
  };
  private onPointerMove=(event:PointerEvent):void=>{
    if(this.dragging||performance.now()-this.lastHover<65)return;this.lastHover=performance.now();this.showCountry(this.pick(event.clientX,event.clientY));
  };
  private onPointerLeave=():void=>{if(this.hovered){this.hovered='';this.paintMap();}this.hideTooltip();};
  private onPointerCancel=():void=>{this.pointerStart=undefined;this.dragging=false;this.hideTooltip();};
  private onControlStart=():void=>{this.dragging=true;this.focusTarget=undefined;this.hideTooltip();this.requestFrame();};
  private onControlEnd=():void=>{this.dragging=false;this.hideTooltip();this.requestFrame();};
  private onControlChange=():void=>{this.requestFrame();};
  private onWheel=():void=>{this.focusTarget=undefined;this.requestFrame();};
  private onKeyDown=(event:KeyboardEvent):void=>{
    const movements:Record<string,[number,number]>={ArrowLeft:[-.12,0],ArrowRight:[.12,0],ArrowUp:[0,-.1],ArrowDown:[0,.1]};
    if(event.key in movements){
      event.preventDefault();this.focusTarget=undefined;
      const spherical=new THREE.Spherical().setFromVector3(this.camera.position);const [theta,phi]=movements[event.key];
      spherical.theta+=theta;spherical.phi=THREE.MathUtils.clamp(spherical.phi+phi,.05,Math.PI-.05);this.camera.position.setFromSpherical(spherical);this.controls?.update();this.requestFrame();
    }else if(event.key==='+'||event.key==='='){event.preventDefault();this.zoom(1);}else if(event.key==='-'){event.preventDefault();this.zoom(-1);}
    else if(event.key==='Home'){event.preventDefault();this.reset();}
    else if(event.key==='Enter'&&this.renderer){event.preventDefault();const rect=this.renderer.domElement.getBoundingClientRect();const country=this.pick(rect.left+rect.width/2,rect.top+rect.height/2);if(country?.code)this.onSelect(country.code);}
  };
  private onVisibility=():void=>{if(document.hidden)this.stopFrame();else this.requestFrame();};
  private stopFrame():void{if(this.frame)cancelAnimationFrame(this.frame);this.frame=0;this.lastFrame=0;}
  private requestFrame():void{if(!this.frame&&!this.disposed&&this.renderer&&this.active&&this.visible&&!document.hidden&&this.container.isConnected)this.frame=requestAnimationFrame(this.animate);}
  private animate=(time:number):void=>{
    this.frame=0;if(this.disposed||!this.renderer||!this.active||!this.visible||document.hidden||!this.container.isConnected){this.lastFrame=0;return;}
    const elapsed=this.lastFrame?(time-this.lastFrame)/1000:1/60;
    if(this.lastFrame && elapsed<1/32){this.requestFrame();return;}
    this.lastFrame=time;
    if(this.focusTarget&&!this.cancelFocus){
      const turn=new THREE.Quaternion().setFromUnitVectors(this.camera.position.clone().normalize(),this.focusTarget.clone().normalize());
      const step=new THREE.Quaternion().slerp(turn,this.reducedMotion?1:Math.min(1,elapsed*6));
      this.camera.position.applyQuaternion(step).setLength(this.focusTarget.length());
      if(this.camera.position.distanceTo(this.focusTarget)<.004){this.camera.position.copy(this.focusTarget);this.focusTarget=undefined;}
    }
    let changed=false;
    if(this.controls)changed=this.controls.update(Math.min(.1,elapsed));
    this.renderer.render(this.scene,this.camera);
    this.renderer.domElement.dataset.rendered='true';
    // No idle rotation or held-pointer loop: only focus motion and damping need more frames.
    if(this.focusTarget||changed)this.requestFrame();
    if(!this.frame)this.lastFrame=0;
  };
}
