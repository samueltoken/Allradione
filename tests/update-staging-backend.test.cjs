'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { STAGE_MARKER, MIN_STAGE_AGE_MS, createStageMarker, setStageOwner, cleanupUpdateStages, isProcessAlive } = require('../electron/update-staging.cjs');
const INSTALLER = 'Allradione-Setup-0.2.1-x64.exe';
const NOW = Date.UTC(2026, 10, 7);

async function temporary(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'allradione-stage-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}
async function stage(dataDir, name, { age = MIN_STAGE_AGE_MS * 2, pid = 700001, marker = true } = {}) {
  const directory = path.join(dataDir, 'updates', `release-${name}`);
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, INSTALLER), 'old installer');
  await fs.writeFile(path.join(directory, 'apply-update.ps1'), 'old helper');
  if (marker) await createStageMarker(directory, { pid, now: NOW - age, installerName: INSTALLER });
  return directory;
}
async function exists(file) { try { await fs.access(file); return true; } catch { return false; } }

test('stale inactive stages remove only owned files while preserving settings and legacy unmarked stages', async t => {
  const dataDir = await temporary(t);
  await fs.writeFile(path.join(dataDir, 'settings.json'), '{"favorites":["station"]}');
  const stale = await stage(dataDir, 'stale001');
  await fs.writeFile(path.join(stale, 'update-error.txt'), 'prior failure');
  const legacy = await stage(dataDir, 'legacy01', { marker: false });
  const result = await cleanupUpdateStages(dataDir, { now: NOW, isProcessAlive: () => false });
  assert.deepEqual(result.removed, ['release-stale001']);
  assert.deepEqual(result.retained, ['release-legacy01']);
  assert.deepEqual(result.errors, []);
  assert.equal(await exists(stale), false);
  assert.equal(await fs.readFile(path.join(legacy, INSTALLER), 'utf8'), 'old installer');
  assert.equal(await fs.readFile(path.join(dataDir, 'settings.json'), 'utf8'), '{"favorites":["station"]}');
});

test('fresh, boundary-age, active and current-process stages are retained', async t => {
  const dataDir = await temporary(t);
  await stage(dataDir, 'fresh001', { age: 1000 });
  await stage(dataDir, 'exactday', { age: MIN_STAGE_AGE_MS });
  await stage(dataDir, 'active01', { pid: 700002 });
  await stage(dataDir, 'current1', { pid: process.pid });
  const checked = [];
  const result = await cleanupUpdateStages(dataDir, { now: NOW, minAgeMs: 0, isProcessAlive: pid => { checked.push(pid); return pid === 700002; } });
  assert.deepEqual(result.removed, []);
  assert.equal(result.retained.length, 4);
  assert.deepEqual(checked, [700002]);
  assert.equal(isProcessAlive(process.pid), true);
});

test('unknown files, additional installer versions and invalid ownership metadata retain the entire stage', async t => {
  const dataDir = await temporary(t);
  const unknown = await stage(dataDir, 'unknown1');
  await fs.writeFile(path.join(unknown, 'my-notes.txt'), 'keep');
  const extraVersion = await stage(dataDir, 'version2');
  await fs.writeFile(path.join(extraVersion, 'Allradione-Setup-0.1.0-x64.exe'), 'unclaimed');
  const foreign = await stage(dataDir, 'foreign1');
  const markerPath = path.join(foreign, STAGE_MARKER);
  const marker = JSON.parse(await fs.readFile(markerPath, 'utf8'));
  marker.appId = 'unrelated.application';
  await fs.writeFile(markerPath, JSON.stringify(marker));
  const result = await cleanupUpdateStages(dataDir, { now: NOW, isProcessAlive: () => false });
  assert.deepEqual(result.removed, []);
  assert.equal(result.retained.length, 3);
  for (const directory of [unknown, extraVersion, foreign]) assert.equal(await fs.readFile(path.join(directory, INSTALLER), 'utf8'), 'old installer');
});

test('stage, updates-root and nested junctions are never followed or removed', async t => {
  const temporaryRoot = await temporary(t), dataDir = path.join(temporaryRoot, 'profile');
  const outside = await stage(path.join(temporaryRoot, 'outside'), 'outside1');
  await fs.mkdir(path.join(dataDir, 'updates'), { recursive: true });
  const linkedStage = path.join(dataDir, 'updates', 'release-linked01');
  await fs.symlink(outside, linkedStage, 'junction');
  const nested = await stage(dataDir, 'nested01');
  await fs.symlink(outside, path.join(nested, 'nested-link'), 'junction');
  const first = await cleanupUpdateStages(dataDir, { now: NOW, isProcessAlive: () => false });
  assert.deepEqual(first.removed, []);
  assert.equal((await fs.lstat(linkedStage)).isSymbolicLink(), true);
  assert.equal(await fs.readFile(path.join(outside, INSTALLER), 'utf8'), 'old installer');
  const linkedProfile = path.join(temporaryRoot, 'linked-profile');
  await fs.mkdir(linkedProfile);
  await fs.symlink(path.join(dataDir, 'updates'), path.join(linkedProfile, 'updates'), 'junction');
  const second = await cleanupUpdateStages(linkedProfile, { now: NOW, isProcessAlive: () => false });
  assert.deepEqual(second.removed, []);
  assert.match(second.errors[0], /UNSAFE_PATH/);
  assert.equal(await fs.readFile(path.join(nested, INSTALLER), 'utf8'), 'old installer');
});

test('stage marker creation is exclusive and can transfer ownership to the live helper', async t => {
  const dataDir = await temporary(t);
  const directory = await stage(dataDir, 'handoff1');
  const markerPath = path.join(directory, STAGE_MARKER);
  const initial = JSON.parse(await fs.readFile(markerPath, 'utf8'));
  await assert.rejects(createStageMarker(directory, { pid: 1, now: NOW, installerName: INSTALLER }), { code: 'EEXIST' });
  const transferred = await setStageOwner(directory, 700003);
  assert.deepEqual(transferred, { ...initial, ownerPid: 700003 });
  assert.deepEqual(JSON.parse(await fs.readFile(markerPath, 'utf8')), transferred);
  await assert.rejects(setStageOwner(directory, 0), TypeError);
  const result = await cleanupUpdateStages(dataDir, { now: NOW, isProcessAlive: pid => pid === 700003 });
  assert.deepEqual(result.removed, []);
});

test('concurrent cleanup requests share one operation and uncertain process status keeps files', async t => {
  const dataDir = await temporary(t);
  const directory = await stage(dataDir, 'pending1');
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const options = { now: NOW, isProcessAlive: async () => { await gate; throw new Error('Cannot inspect process'); } };
  const first = cleanupUpdateStages(dataDir, options), second = cleanupUpdateStages(dataDir, options);
  assert.equal(first, second);
  release();
  const result = await first;
  assert.deepEqual(result.removed, []);
  assert.equal(result.errors.length, 1);
  assert.equal(await fs.readFile(path.join(directory, INSTALLER), 'utf8'), 'old installer');
});
