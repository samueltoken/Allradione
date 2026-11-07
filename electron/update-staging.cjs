'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const APP_ID = 'io.github.samueltoken.allradione';
const STAGE_MARKER = 'allradione-update-stage.json';
const MIN_STAGE_AGE_MS = 24 * 60 * 60 * 1000;
const INSTALLER_NAME = /^Allradione-Setup-(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)-x64\.exe$/;
const STAGE_NAME = /^release-[A-Za-z0-9_-]{6,100}$/;
const runningCleanups = new Map();

function unsafePath() { const error = new Error('Unsafe update staging path'); error.code = 'UNSAFE_PATH'; return error; }
function validPid(pid) { return Number.isSafeInteger(pid) && pid > 0 && pid <= 0xffffffff; }
function sameFile(left, right) { return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeMs === right.mtimeMs; }

// Check every ancestor as well: a junction at updates or its parent must never
// turn cleanup of an owned stage into cleanup in another directory.
async function plainDirectoryChain(directory) {
  const absolute = path.resolve(directory), root = path.parse(absolute).root;
  let current = root;
  for (const part of absolute.slice(root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const stat = await fs.lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw unsafePath();
  }
  return fs.lstat(absolute);
}

function stagePath(stageDir) {
  const absolute = path.resolve(stageDir);
  if (path.basename(path.dirname(absolute)) !== 'updates' || !STAGE_NAME.test(path.basename(absolute))) throw unsafePath();
  return absolute;
}

function validateMarker(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (value.schemaVersion !== 1 || value.appId !== APP_ID || !validPid(value.ownerPid) || !INSTALLER_NAME.test(value.installerName)) return false;
  if (typeof value.createdAt !== 'string') return false;
  const time = Date.parse(value.createdAt);
  return Number.isFinite(time) && new Date(time).toISOString() === value.createdAt;
}

async function readMarker(stageDir) {
  const markerPath = path.join(stageDir, STAGE_MARKER);
  const stat = await fs.lstat(markerPath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > 4096) throw unsafePath();
  const text = await fs.readFile(markerPath, 'utf8');
  const marker = JSON.parse(text);
  if (!validateMarker(marker)) throw unsafePath();
  return { marker, markerPath, stat, text };
}

async function createStageMarker(stageDir, { pid = process.pid, now = Date.now(), installerName } = {}) {
  const directory = stagePath(stageDir);
  if (!validPid(pid) || !Number.isFinite(now) || !INSTALLER_NAME.test(installerName)) throw new TypeError('Invalid update stage metadata');
  await plainDirectoryChain(directory);
  const marker = { schemaVersion: 1, appId: APP_ID, createdAt: new Date(now).toISOString(), ownerPid: pid, installerName };
  await fs.writeFile(path.join(directory, STAGE_MARKER), JSON.stringify(marker), { encoding: 'utf8', flag: 'wx' });
  return marker;
}

async function setStageOwner(stageDir, ownerPid) {
  const directory = stagePath(stageDir);
  if (!validPid(ownerPid)) throw new TypeError('Invalid update stage owner');
  await plainDirectoryChain(directory);
  const before = await readMarker(directory);
  const handle = await fs.open(before.markerPath, 'r+');
  try {
    if (!sameFile(await handle.stat(), before.stat)) throw unsafePath();
    const marker = { ...before.marker, ownerPid };
    const contents = Buffer.from(JSON.stringify(marker));
    await handle.write(contents, 0, contents.length, 0);
    await handle.truncate(contents.length);
    await handle.sync();
    return marker;
  } finally { await handle.close(); }
}

function isProcessAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== 'ESRCH'; }
}

async function cleanup(dataDir, { now = Date.now(), isProcessAlive: processAlive = isProcessAlive, minAgeMs = MIN_STAGE_AGE_MS } = {}) {
  const summary = { removed: [], retained: [], errors: [] };
  const updates = path.join(path.resolve(dataDir), 'updates');
  const age = Math.max(MIN_STAGE_AGE_MS, Number.isFinite(minAgeMs) ? minAgeMs : MIN_STAGE_AGE_MS);
  if (!Number.isFinite(now)) throw new TypeError('Invalid cleanup time');
  let entries;
  try { await plainDirectoryChain(updates); entries = await fs.readdir(updates, { withFileTypes: true }); }
  catch (error) {
    if (error.code !== 'ENOENT') summary.errors.push(`updates: ${error.code || 'IO_ERROR'}`);
    return summary;
  }
  for (const entry of entries) {
    if (!STAGE_NAME.test(entry.name)) continue;
    const directory = path.join(updates, entry.name);
    let removed = false;
    try {
      if (!entry.isDirectory() || entry.isSymbolicLink()) throw unsafePath();
      const directoryStat = await plainDirectoryChain(directory);
      const { marker, markerPath, text } = await readMarker(directory);
      const createdAt = Date.parse(marker.createdAt);
      if (now - createdAt <= age || marker.ownerPid === process.pid || await processAlive(marker.ownerPid)) {
        summary.retained.push(entry.name); continue;
      }
      const allowlist = new Set([marker.installerName, 'apply-update.ps1', 'helper-ready.json', 'helper-ready.json.tmp', 'update-error.txt', STAGE_MARKER]);
      const files = await fs.readdir(directory, { withFileTypes: true });
      if (files.some(file => !allowlist.has(file.name) || !file.isFile() || file.isSymbolicLink())) {
        summary.retained.push(entry.name); continue;
      }
      const snapshots = new Map();
      for (const file of files) {
        const stat = await fs.lstat(path.join(directory, file.name));
        if (!stat.isFile() || stat.isSymbolicLink()) throw unsafePath();
        snapshots.set(file.name, stat);
      }
      // Recheck ownership and contents immediately before mutation. Marker goes
      // last, so a locked file leaves enough information for a later safe retry.
      const currentDirectory = await plainDirectoryChain(directory);
      if (currentDirectory.dev !== directoryStat.dev || currentDirectory.ino !== directoryStat.ino || await fs.readFile(markerPath, 'utf8') !== text) throw unsafePath();
      const latestNames = await fs.readdir(directory);
      if (latestNames.length !== snapshots.size || latestNames.some(name => !snapshots.has(name))) throw unsafePath();
      for (const name of [...snapshots.keys()].sort((a, b) => (a === STAGE_MARKER ? 1 : b === STAGE_MARKER ? -1 : a.localeCompare(b)))) {
        await plainDirectoryChain(directory);
        const file = path.join(directory, name), current = await fs.lstat(file);
        if (!current.isFile() || current.isSymbolicLink() || !sameFile(current, snapshots.get(name))) throw unsafePath();
        await fs.unlink(file);
      }
      await fs.rmdir(directory);
      summary.removed.push(entry.name);
      removed = true;
    } catch (error) {
      // Missing/malformed ownership markers are legacy or unrelated data, never
      // permission to delete. Other IO problems remain visible to the caller.
      if (!['ENOENT', 'UNSAFE_PATH'].includes(error.code) && !(error instanceof SyntaxError)) summary.errors.push(`${entry.name}: ${error.code || 'IO_ERROR'}`);
    }
    if (!removed) summary.retained.push(entry.name);
  }
  return summary;
}

function cleanupUpdateStages(dataDir, options) {
  const key = path.resolve(dataDir);
  if (runningCleanups.has(key)) return runningCleanups.get(key);
  const operation = cleanup(key, options).finally(() => runningCleanups.delete(key));
  runningCleanups.set(key, operation);
  return operation;
}

module.exports = { STAGE_MARKER, MIN_STAGE_AGE_MS, createStageMarker, setStageOwner, cleanupUpdateStages, isProcessAlive };
