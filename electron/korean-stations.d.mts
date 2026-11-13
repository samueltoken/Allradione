import type { Station } from '../src/types';
export const koreanStations: Station[];
export function isKoreanBroadcasterStation(station: Station): boolean;
export function resolveKoreanStream(url: string, readText: (url: string) => Promise<string>): Promise<string>;
