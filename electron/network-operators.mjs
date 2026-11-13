// Exact publisher-listed station endpoints, matched without transient query strings.
import { networkServices, verifiedNetworkStreams } from './network-streams.mjs';

export function networkOperator(station) {
  try {
    const url = new URL(station.url_resolved || station.url);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return;
    // On generic shared players the query can select a different station.
    if (url.search && !/(^|\.)(ihrhls|musicradio)\.com$/i.test(url.hostname) &&
        url.hostname !== 'streaming.nrjaudio.fm') return;
    const key = url.host.toLowerCase() + url.pathname;
    const service = networkServices[verifiedNetworkStreams[key]];
    if (service) return {...service, kind: 'broadcaster'};
  } catch { /* Unknown or malformed station URL. */ }
}
