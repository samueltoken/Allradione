import type { StreamSource } from '../src/types';
export function resolveStationStream(url:string, readText:(url:string)=>Promise<string>, now?:number):Promise<StreamSource>;
