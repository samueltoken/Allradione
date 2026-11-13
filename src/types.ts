export type OperatorKind = 'broadcaster' | 'independent' | 'unknown';
export type StreamSource = string | { url: string; backup?: string; endsAt?: number } | { offAir: true; nextAt?: number };
export interface Station { stationuuid:string; name:string; url_resolved:string; url:string; homepage:string; favicon:string; countrycode:string; language:string; tags:string; codec:string; bitrate:number; hls:number; lastcheckok:number; lastchecktime_iso8601?:string; votes:number; geo_lat?:number; geo_long?:number; operatorKind?:OperatorKind; operatorName?:string; operatorSource?:string; relayName?:string; programmeOriginName?:string; isPodcast?:boolean; }
export interface Country { code:string; name:string; stationcount:number; lat?:number; lng?:number; }
export type WidgetSize = 'small' | 'medium';
export interface Preferences { language:keyof typeof import("../electron/languages.json"); backgroundPlayback:boolean; volume:number; favorites:Station[]; recent:Station[]; widgetEnabled:boolean; widgetSize:WidgetSize; lastCountry:string; reducedMotion:boolean; }
export interface PlayerState { station:Station|null; playing:boolean; status:'idle'|'connecting'|'playing'|'paused'|'error'|'offair'; volume:number; error?:string; spectrum?:number[]; }
export interface UpdateInfo { available:boolean; version:string; currentVersion:string; url:string; assetUrl?:string; assetName?:string; digest?:string; message?:string; mode?:'installer'|'portable'|'development'; }
export interface CacheInfo { httpBytes:number|null; metadataBytes:number; codeBytes:number; totalBytes:number; errors:string[]; }
export interface CacheResult { beforeBytes:number; afterBytes:number; freedBytes:number; errors:string[]; }
export interface ChatAdminSession { resumeToken:string; expiresAt:number; }
export interface AllradioneBridge {
 getPreferences():Promise<Preferences>; savePreferences(patch:Partial<Preferences>):Promise<Preferences>;
 getChatAdminSession?():Promise<ChatAdminSession|null>; setChatAdminSession?(session:ChatAdminSession|null):Promise<boolean>;
 countries():Promise<Country[]>; stations(code:string):Promise<Station[]>;
 streamUrl(url:string):Promise<StreamSource>; stationClick(id:string):Promise<void>;
 setWidget(enabled:boolean,size:WidgetSize):Promise<void>;
 resizeWidget(width:number,save:boolean,relative?:boolean):Promise<void>;
 publishPlayer(state:PlayerState):void; onPlayer(fn:(state:PlayerState)=>void):()=>void;
 sendCommand(command:string,value?:unknown):void; onCommand(fn:(command:string,value?:unknown)=>void):()=>void;
 windowAction(action:'minimize'|'maximize'|'close'|'show'):void;
 checkUpdate():Promise<UpdateInfo>; installUpdate():Promise<{status:'retry'|'installing'|'opened'|'current';message:string}>;
 cacheInfo():Promise<CacheInfo>; clearCache():Promise<CacheResult>;
 createDesktopShortcut():Promise<{created:boolean;message:string}>;
 openExternal(url:string):Promise<void>; version():Promise<string>;
}
declare global { interface Window { allradione?:AllradioneBridge; } }
