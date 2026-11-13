'use strict';
// Revisit a snapshot's failed primary streams and check each distinct original URL.
// Usage: node scripts/review-station-failures.cjs <snapshot> <first.ndjson> <review.ndjson>
const fs = require('node:fs');
const { inspectStream, stationUrl } = require('./audit-stations.cjs');

const hardFailure = value => ['http-404', 'http-410', 'webpage'].includes(value);
function readLines(file) {
  if (!fs.existsSync(file)) return [];
  const data = fs.readFileSync(file, 'utf8');
  // A concurrently running audit may still be finishing the final line.
  return data.slice(0, data.lastIndexOf('\n') + 1).trim().split('\n').filter(Boolean).map(JSON.parse);
}
async function review(snapshot, first, output, revisitLegacy = false) {
  const rows = JSON.parse(fs.readFileSync(snapshot, 'utf8'));
  const byId = new Map(rows.map(row => [row.stationuuid, row]));
  const firstChecks = readLines(first);
  const lastReview = new Map(readLines(output).map(row => [row.id,row]));
  const pending = [];
  for (const {ids, outcome} of firstChecks) {
    if (outcome === 'media' || outcome === 'ineligible') continue;
    for (const id of ids) {
      const previous = lastReview.get(id);
      if (previous && !(revisitLegacy && !previous.icySupport &&
        [previous.retry, previous.alternate].some(value => value === 'legacy-icy' || value === 'connection-error'))) continue;
      const station = byId.get(id);
      if (!station) continue;
      pending.push({station, outcome});
    }
  }
  // Different entries sometimes share an identical original URL.
  const attempts = new Map(), hostQueues = new Map(), queues = new Map();
  async function check(url) {
    const target = stationUrl(url);
    if (!target) return 'ineligible';
    if (attempts.has(target)) return attempts.get(target);
    const host = new URL(target).hostname;
    const task = (hostQueues.get(host) || Promise.resolve()).then(() => inspectStream(target));
    hostQueues.set(host, task);
    attempts.set(target, task);
    return task;
  }
  const log = fs.openSync(output, 'a');
  for (const task of pending) {
    const url = stationUrl(task.station.url_resolved || task.station.url);
    const host = url ? new URL(url).hostname : '';
    if (!queues.has(host)) queues.set(host, []);
    queues.get(host).push(task);
  }
  const hosts = [...queues.keys()].sort((a,b) => queues.get(b).length - queues.get(a).length);
  let nextHost = 0;
  async function worker() {
    while (nextHost < hosts.length) {
      const queue = queues.get(hosts[nextHost++]);
      for (const {station, outcome} of queue) {
        const primary = station.url_resolved || station.url;
        const secondary = stationUrl(station.url) !== stationUrl(primary) ? station.url : null;
        const alternate = secondary ? await check(secondary) : '';
        // Confirm apparent permanent failures on both routes. For other failures, an
        // original URL success already verifies recovery; otherwise report the retry.
        const retry = alternate === 'media' ? '' : await check(primary);
        fs.writeSync(log, JSON.stringify({id: station.stationuuid, outcome, retry, alternate, icySupport: true,
          checkedAt: new Date().toISOString(), suppress: hardFailure(outcome) && hardFailure(retry) &&
            (!secondary || hardFailure(alternate))}) + '\n');
      }
    }
  }
  try { await Promise.all(Array.from({length: 40}, worker)); }
  finally { fs.closeSync(log); }
  console.log(pending.length + ' station failures reviewed');
}
if (require.main === module) {
  if (process.argv.length < 5 || process.argv.length > 6) throw new Error('Expected snapshot, first-pass results and review output paths, optionally --revisit-legacy');
  review(...process.argv.slice(2, 5), process.argv.includes('--revisit-legacy')).catch(error => { console.error(error); process.exitCode = 1; });
}
module.exports = { review, readLines, hardFailure };
