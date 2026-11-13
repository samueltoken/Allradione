import type { Country, Station } from '../src/types';
export function savedStations(rows:unknown):Station[];
export function countriesFromRows(rows:unknown[]):Country[];
export function createStationReader(request:(endpoint:string)=>Promise<unknown[]>):(code:string)=>Promise<Station[]>;
