type PlaybackEntry = {
  stationuuid: string;
  url?: string;
  url_resolved?: string;
  lastcheckok?: number;
  lastchecktime_iso8601?: string;
};
export function addressSignature(station: PlaybackEntry): string;
export function isPlaybackAddress(value: unknown): boolean;
export function isAvailableStation(station: PlaybackEntry, now?: number): boolean;
export function wasDeniedInAudit(station: PlaybackEntry, now?: number): boolean;
