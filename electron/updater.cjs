'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const REPO = 'samueltoken/Allradione';
const LATEST_API = `https://api.github.com/repos/${REPO}/releases/latest`;
const RELEASES_URL = `https://github.com/${REPO}/releases`;
const DOWNLOAD_HOSTS = new Set(['github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com']);
const MAX_EXE_BYTES = 768 * 1024 * 1024;

function parseVersion(value) {
  if (typeof value !== 'string') return null;
  const match = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(value);
  if (!match) return null;
  const version = match.slice(1).map(Number);
  return version.every(Number.isSafeInteger) ? version : null;
}

function isNewer(candidate, current) {
  const a = parseVersion(candidate), b = parseVersion(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
}

function allowedAssetUrl(value, tag, fileName) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.username || url.password || url.port || url.search || url.hash) return false;
    const expected = `/${REPO}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(fileName)}`;
    return url.pathname === expected;
  } catch { return false; }
}

function selectAsset(release) {
  const version = parseVersion(release?.tag_name);
  if (!version || release.draft || release.prerelease || !Array.isArray(release.assets)) return null;
  const name = `Allradione-${version.join('.')}-win-x64.exe`;
  return release.assets.find(asset => asset.name === name && allowedAssetUrl(asset.browser_download_url, release.tag_name, name)) || null;
}

function normalizeDigest(value) {
  if (typeof value !== 'string') return null;
  const match = /^(?:sha256:)?([0-9a-f]{64})$/i.exec(value.trim());
  return match ? match[1].toLowerCase() : null;
}

function checksumFor(text, fileName) {
  if (typeof text !== 'string' || text.length > 1024 * 1024) return null;
  const lines = text.split(/\r?\n/);
  const matches = [];
  for (const line of lines) {
    const match = /^([a-fA-F0-9]{64})\s+\*?(.+?)\s*$/.exec(line);
    if (match && match[2] === fileName) matches.push(match[1].toLowerCase());
  }
  // Reject ambiguous manifests, even when duplicate hashes happen to match.
  return matches.length === 1 ? matches[0] : null;
}

function allowedRedirect(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && DOWNLOAD_HOSTS.has(url.hostname) && !url.username && !url.password && !url.port && !url.hash;
  } catch { return false; }
}

async function fetchResponse(url, { fetchImpl = fetch, signal, api = false } = {}) {
  let next = url;
  for (let hop = 0; hop < 6; hop++) {
    if (!(api && next === LATEST_API) && !allowedRedirect(next)) throw new Error('업데이트 주소가 허용된 GitHub 주소가 아니야.');
    const response = await fetchImpl(next, { redirect: 'manual', signal, headers: { 'User-Agent': 'Allradione-Updater', Accept: api ? 'application/vnd.github+json' : 'application/octet-stream' } });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      if (!location) throw new Error('업데이트 다운로드 주소가 없어.');
      next = new URL(location, next).href;
      await response.body?.cancel();
      api = false;
      continue;
    }
    return response;
  }
  throw new Error('업데이트 다운로드 주소가 너무 많이 변경됐어.');
}

async function readLimited(response, limit) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limit) throw new Error('업데이트 파일 크기가 허용 범위를 초과했어.');
  if (!response.ok || !response.body) throw new Error(`업데이트 서버 응답 오류 (${response.status}).`);
  const chunks = [];
  let total = 0;
  for await (const chunk of response.body) {
    total += chunk.length;
    if (total > limit) throw new Error('업데이트 파일 크기가 허용 범위를 초과했어.');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function psLiteral(value) { return `'${String(value).replaceAll("'", "''")}'`; }

function makeUpdateScript({ parentPid, target, stagedExe, backup, scriptPath, expectedHash }) {
  if (!Number.isSafeInteger(parentPid) || parentPid < 1 || !normalizeDigest(expectedHash)) throw new Error('Invalid updater parameters');
  return `$ErrorActionPreference = 'Stop'
$target = ${psLiteral(target)}
$staged = ${psLiteral(stagedExe)}
$backup = ${psLiteral(backup)}
$scriptPath = ${psLiteral(scriptPath)}
$stageDir = Split-Path -Parent $staged
$expected = ${psLiteral(expectedHash.toLowerCase())}
$moved = $false
$installed = $false
try {
  if ((Get-FileHash -LiteralPath $staged -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expected) { throw 'SHA256 mismatch' }
  Wait-Process -Id ${parentPid} -Timeout 90 -ErrorAction SilentlyContinue
  if (Get-Process -Id ${parentPid} -ErrorAction SilentlyContinue) { throw 'Original process did not stop' }
  for ($attempt = 0; $attempt -lt 100; $attempt++) {
    try {
      Move-Item -LiteralPath $target -Destination $backup -ErrorAction Stop
      $moved = $true
      break
    } catch { Start-Sleep -Milliseconds 300 }
  }
  if (-not $moved) { throw 'Could not replace portable executable' }
  Copy-Item -LiteralPath $staged -Destination $target -ErrorAction Stop
  if ((Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expected) { throw 'Installed SHA256 mismatch' }
  $next = Start-Process -FilePath $target -WorkingDirectory (Split-Path -Parent $target) -PassThru -ErrorAction Stop
  Start-Sleep -Seconds 3
  if ($next.HasExited -and $next.ExitCode -ne 0) { throw 'New version failed to start' }
  $installed = $true
  Remove-Item -LiteralPath $backup -ErrorAction SilentlyContinue
} catch {
  $_ | Out-String | Set-Content -LiteralPath (Join-Path $stageDir 'update-error.txt') -Encoding UTF8
  if ($moved -and -not $installed -and (Test-Path -LiteralPath $backup)) {
    if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -ErrorAction SilentlyContinue }
    Move-Item -LiteralPath $backup -Destination $target -ErrorAction SilentlyContinue
    Start-Process -FilePath $target -WorkingDirectory (Split-Path -Parent $target) -ErrorAction SilentlyContinue
  }
} finally {
  Remove-Item -LiteralPath $staged -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $scriptPath -ErrorAction SilentlyContinue
  if ($installed) { Remove-Item -LiteralPath $stageDir -ErrorAction SilentlyContinue }
}
`;
}

function createUpdater({ app, shell, dataDir, fetchImpl = fetch, platform = process.platform, env = process.env, spawnImpl = spawn }) {
  let checked = null;
  let installing = false;
  const currentVersion = app.getVersion();
  const result = (patch = {}) => ({ available: false, version: currentVersion, currentVersion, url: RELEASES_URL, ...patch });

  async function checkUpdate() {
    checked = null;
    try {
      const response = await fetchResponse(LATEST_API, { fetchImpl, api: true, signal: AbortSignal.timeout(15000) });
      if (response.status === 404) return result({ message: '아직 공개된 릴리즈가 없어.' });
      const release = JSON.parse((await readLimited(response, 2 * 1024 * 1024)).toString('utf8'));
      const version = parseVersion(release.tag_name);
      if (!version || release.draft || release.prerelease) return result({ message: '안정 버전 릴리즈를 찾지 못했어.' });
      const url = `${RELEASES_URL}/tag/${encodeURIComponent(release.tag_name)}`;
      if (!isNewer(release.tag_name, currentVersion)) return result({ version: version.join('.'), url, message: '최신 버전이야.' });
      const asset = selectAsset(release);
      checked = { release, asset, url, version: version.join('.') };
      return result({ available: true, version: checked.version, url, ...(asset ? { assetUrl: asset.browser_download_url, assetName: asset.name, digest: normalizeDigest(asset.digest) || undefined } : {}), message: asset ? '새 버전을 사용할 수 있어.' : '릴리즈 페이지에서 새 버전을 확인할 수 있어.' });
    } catch (error) {
      return result({ message: `업데이트를 확인하지 못했어. ${error.message}` });
    }
  }

  async function installUpdate() {
    if (installing) return { message: '업데이트를 다운로드하고 있어.' };
    // Acquire before any await: two first-time clicks must not both check/install.
    installing = true;
    let stageDir;
    let handedOff = false;
    try {
      if (!checked) {
        const state = await checkUpdate();
        if (!state.available) return { message: state.message || '업데이트가 없어.' };
      }
      const { release, asset, url } = checked;
      const portablePath = env.PORTABLE_EXECUTABLE_FILE;
      if (platform !== 'win32' || !asset || !portablePath || path.win32.extname(portablePath).toLowerCase() !== '.exe' || !path.win32.isAbsolute(portablePath)) {
        await shell.openExternal(url);
        return { message: '릴리즈 페이지를 열었어. 새 무설치 파일을 내려받아 실행해줘.' };
      }
      // The existing launcher is the sole replacement target; renderer input cannot choose paths.
      const targetStat = await fs.stat(portablePath);
      if (!targetStat.isFile()) throw new Error('현재 무설치 실행 파일을 찾지 못했어.');
      let digest = normalizeDigest(asset.digest);
      if (!digest) {
        const checksum = release.assets.find(item => item.name === 'SHA256SUMS.txt' && allowedAssetUrl(item.browser_download_url, release.tag_name, item.name));
        if (!checksum) throw new Error('릴리즈에 무결성 확인용 체크섬이 없어.');
        const response = await fetchResponse(checksum.browser_download_url, { fetchImpl, signal: AbortSignal.timeout(20000) });
        digest = checksumFor((await readLimited(response, 1024 * 1024)).toString('utf8'), asset.name);
      }
      if (!digest) throw new Error('이 실행 파일의 체크섬을 확인하지 못했어.');
      const updateRoot = path.join(dataDir, 'updates');
      await fs.mkdir(updateRoot, { recursive: true });
      stageDir = await fs.mkdtemp(path.join(updateRoot, 'release-'));
      const stagedExe = path.join(stageDir, 'Allradione-update.exe');
      const response = await fetchResponse(asset.browser_download_url, { fetchImpl, signal: AbortSignal.timeout(10 * 60 * 1000) });
      if (!response.ok || !response.body) throw new Error(`다운로드 오류 (${response.status}).`);
      const declared = Number(response.headers.get('content-length'));
      if (declared > MAX_EXE_BYTES) throw new Error('업데이트 파일이 너무 커.');
      const handle = await fs.open(stagedExe, 'wx');
      let bytes = 0;
      const hash = crypto.createHash('sha256');
      let magic = Buffer.alloc(0);
      try {
        for await (const chunk of response.body) {
          bytes += chunk.length;
          if (bytes > MAX_EXE_BYTES) throw new Error('업데이트 파일이 너무 커.');
          if (magic.length < 2) magic = Buffer.concat([magic, Buffer.from(chunk)]).subarray(0, 2);
          hash.update(chunk);
          await handle.writeFile(chunk);
        }
        await handle.sync();
      } finally { await handle.close(); }
      if (bytes < 1024 || magic.toString('ascii') !== 'MZ') throw new Error('정상적인 Windows 실행 파일이 아니야.');
      if (hash.digest('hex') !== digest) throw new Error('다운로드 파일의 체크섬이 일치하지 않아.');
      const backup = `${portablePath}.allradione-${crypto.randomUUID()}.bak`;
      const scriptPath = path.join(stageDir, 'apply-update.ps1');
      const script = makeUpdateScript({ parentPid: process.pid, target: portablePath, stagedExe, backup, scriptPath, expectedHash: digest });
      await fs.writeFile(scriptPath, '\ufeff' + script, 'utf8');
      const systemRoot = env.SystemRoot || env.WINDIR || 'C:\\Windows';
      const powershell = path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      // Execute our generated literal script directly. No machine or process policy changes.
      const child = spawnImpl(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { detached: true, windowsHide: true, stdio: 'ignore' });
      await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
      child.unref();
      handedOff = true;
      setTimeout(() => app.quit(), 400);
      return { message: '검증 완료. 새 버전으로 다시 시작할게.' };
    } catch (error) {
      // Only our unique staging directory is removed. Existing app/settings stay intact.
      if (stageDir) await fs.rm(stageDir, { recursive: true, force: true }).catch(() => {});
      return { message: `업데이트를 적용하지 못했어. ${error.message}` };
    } finally { if (!handedOff) installing = false; }
  }
  return { checkUpdate, installUpdate };
}

module.exports = { createUpdater, parseVersion, isNewer, allowedAssetUrl, allowedRedirect, selectAsset, normalizeDigest, checksumFor, makeUpdateScript, readLimited, fetchResponse };
