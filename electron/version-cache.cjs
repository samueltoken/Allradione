'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const APP_ID = 'io.github.samueltoken.allradione';
const VERSION_MARKER = 'code-cache-version.json';
const VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
const pending = new Map();

async function readVersion(markerPath) {
  let stat;
  try { stat = await fs.lstat(markerPath); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Unsafe code cache version marker');
  if (stat.size > 1024) return null;
  let marker;
  try { marker = JSON.parse(await fs.readFile(markerPath, 'utf8')); } catch (error) { if (error instanceof SyntaxError) return null; throw error; }
  return marker?.schemaVersion === 1 && marker.appId === APP_ID && VERSION.test(marker.version) ? marker.version : null;
}

async function refresh({ dataDir, version, ses }) {
  if (typeof version !== 'string' || !VERSION.test(version)) return { cleared: false, changed: false, error: '앱 버전을 확인하지 못해 코드 캐시를 정리하지 못했습니다.' };
  const markerPath = path.join(dataDir, VERSION_MARKER);
  let oldVersion;
  try { oldVersion = await readVersion(markerPath); }
  catch { return { cleared: false, changed: false, error: '코드 캐시 버전 기록을 읽지 못했습니다. 다음 실행 때 다시 확인합니다.' }; }
  if (oldVersion === version) return { cleared: false, changed: false };
  try { await ses.clearCodeCaches({ urls: [] }); }
  catch { return { cleared: false, changed: true, error: '이전 버전의 코드 캐시를 정리하지 못했습니다. 다음 실행 때 다시 시도합니다.' }; }
  // Chromium owns its cache files. Only this small version marker is written here.
  const temporary = path.join(dataDir, `.allradione-code-cache-version-${crypto.randomUUID()}.tmp`);
  try {
    const handle = await fs.open(temporary, 'wx');
    try {
      await handle.writeFile(JSON.stringify({ schemaVersion: 1, appId: APP_ID, version }), 'utf8');
      await handle.sync();
    } finally { await handle.close(); }
    await fs.rename(temporary, markerPath);
    return { cleared: true, changed: true };
  } catch {
    return { cleared: true, changed: true, error: '코드 캐시는 정리했지만 버전 기록을 저장하지 못했습니다. 다음 실행 때 다시 확인합니다.' };
  } finally { await fs.unlink(temporary).catch(() => {}); }
}

function refreshVersionCodeCache(options) {
  const dataDir = path.resolve(options.dataDir);
  const previous = pending.get(dataDir) || Promise.resolve();
  const operation = previous.catch(() => {}).then(() => refresh({ ...options, dataDir }));
  pending.set(dataDir, operation);
  operation.finally(() => { if (pending.get(dataDir) === operation) pending.delete(dataDir); }).catch(() => {});
  return operation;
}

module.exports = { VERSION_MARKER, refreshVersionCodeCache };
