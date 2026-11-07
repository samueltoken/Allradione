'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { VERSION_MARKER, refreshVersionCodeCache } = require('../electron/version-cache.cjs');

async function profile(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'allradione-code-cache-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

test('initial start clears code cache and records the installed version, matching version skips', async t => {
  const dataDir = await profile(t), calls = [];
  const ses = { clearCodeCaches: async options => { calls.push(options); } };
  assert.deepEqual(await refreshVersionCodeCache({ dataDir, version: '0.2.1', ses }), { cleared: true, changed: true });
  assert.deepEqual(calls, [{ urls: [] }]);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(dataDir, VERSION_MARKER), 'utf8')), { schemaVersion: 1, appId: 'io.github.samueltoken.allradione', version: '0.2.1' });
  assert.deepEqual(await refreshVersionCodeCache({ dataDir, version: '0.2.1', ses }), { cleared: false, changed: false });
  assert.equal(calls.length, 1);
});

test('changed versions clear through Chromium while preserving preferences and station metadata', async t => {
  const dataDir = await profile(t);
  const preferences = '{"favorites":["my-station"],"volume":0.5}';
  await fs.writeFile(path.join(dataDir, 'settings.json'), preferences);
  await fs.writeFile(path.join(dataDir, 'cache-stations-KR.json'), 'station metadata');
  let clears = 0;
  const ses = { clearCodeCaches: async () => { clears++; } };
  await refreshVersionCodeCache({ dataDir, version: '0.2.0', ses });
  await refreshVersionCodeCache({ dataDir, version: '0.2.1', ses });
  assert.equal(clears, 2);
  assert.equal(await fs.readFile(path.join(dataDir, 'settings.json'), 'utf8'), preferences);
  assert.equal(await fs.readFile(path.join(dataDir, 'cache-stations-KR.json'), 'utf8'), 'station metadata');
  assert.equal(JSON.parse(await fs.readFile(path.join(dataDir, VERSION_MARKER), 'utf8')).version, '0.2.1');
});

test('failed clearing keeps the previous version marker and retries successfully next time', async t => {
  const dataDir = await profile(t), markerPath = path.join(dataDir, VERSION_MARKER);
  await refreshVersionCodeCache({ dataDir, version: '0.2.0', ses: { clearCodeCaches: async () => {} } });
  const before = await fs.readFile(markerPath, 'utf8');
  await fs.writeFile(path.join(dataDir, 'settings.json'), 'preserve');
  const failed = await refreshVersionCodeCache({ dataDir, version: '0.2.1', ses: { clearCodeCaches: async () => { throw new Error('Access denied'); } } });
  assert.equal(failed.cleared, false);
  assert.equal(failed.changed, true);
  assert.match(failed.error, /정리하지 못했습니다/);
  assert.equal(await fs.readFile(markerPath, 'utf8'), before);
  assert.equal(await fs.readFile(path.join(dataDir, 'settings.json'), 'utf8'), 'preserve');
  const retried = await refreshVersionCodeCache({ dataDir, version: '0.2.1', ses: { clearCodeCaches: async () => {} } });
  assert.equal(retried.cleared, true);
  assert.equal(JSON.parse(await fs.readFile(markerPath, 'utf8')).version, '0.2.1');
});

test('concurrent requests serialize and only clear once for the same version', async t => {
  const dataDir = await profile(t);
  let release, clears = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const ses = { clearCodeCaches: async () => { clears++; await gate; } };
  const first = refreshVersionCodeCache({ dataDir, version: '0.2.1', ses });
  const second = refreshVersionCodeCache({ dataDir, version: '0.2.1', ses });
  release();
  assert.deepEqual(await first, { cleared: true, changed: true });
  assert.deepEqual(await second, { cleared: false, changed: false });
  assert.equal(clears, 1);
  assert.deepEqual((await fs.readdir(dataDir)).sort(), [VERSION_MARKER]);
});
