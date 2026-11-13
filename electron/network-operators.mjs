// Exact publisher-listed station endpoints, matched without transient query strings.
import { networkServices, verifiedNetworkStreams } from './network-streams.mjs';
import { publishedServices } from './publisher-endpoints.mjs';

const publisherByEndpoint = new Map();
for (const {endpoints, ...record} of publishedServices) {
  for (const endpoint of endpoints) publisherByEndpoint.set(endpoint, record);
}

function hasPublisherQuery(url) {
  if (!url.search) return true;
  const trackingKeys = url.hostname.endsWith('.streamabc.net') ? ['sABC','aw_0_1st.playerid','amsparams']
    : url.hostname.endsWith('.rndfnk.com') ? ['cid','sid','token','tvf'] : [];
  return [...url.searchParams.keys()].every(key => trackingKeys.includes(key));
}

export function networkOperator(station) {
  let url;
  try { url = new URL(station.url_resolved || station.url); } catch { return; }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return;
  const key = url.host.toLowerCase() + url.pathname;
  const publisher = publisherByEndpoint.get(key);
  if (publisher && hasPublisherQuery(url)) return publisher;
  // On generic shared players the query can select a different station.
  if (url.search && !/(^|\.)(ihrhls|musicradio)\.com$/i.test(url.hostname) &&
      url.hostname !== 'streaming.nrjaudio.fm') return;
  const service = networkServices[verifiedNetworkStreams[key]];
  if (service) return {...service, kind: 'broadcaster'};
}
