'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { STAGE_MARKER, createStageMarker, setStageOwner } = require('./update-staging.cjs');

const REPO = 'samueltoken/Allradione';
const LATEST_API = `https://api.github.com/repos/${REPO}/releases/latest`;
const RELEASES_URL = `https://github.com/${REPO}/releases`;
const DOWNLOAD_HOSTS = new Set(['github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com']);
const MAX_EXE_BYTES = 768 * 1024 * 1024;
const HELPER_READY = 'ALLRADIONE_UPDATER_READY';

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
  const name = `Allradione-Setup-${version.join('.')}-x64.exe`;
  return release.assets.find(asset => asset.name === name && (asset.state === undefined || asset.state === 'uploaded') && allowedAssetUrl(asset.browser_download_url, release.tag_name, name)) || null;
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

function waitForHelperReady(child, { timeoutMs = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    if (!child.stdout || !child.stderr) { reject(new Error('업데이트 도우미 응답 통로를 열지 못했어.')); return; }
    let pending = '', received = 0, settled = false;
    const finish = error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout.removeListener('data', onData);
      child.stderr.removeListener('data', onStderr);
      child.removeListener('error', onError);
      child.removeListener('exit', onExit);
      child.stdout.resume();
      child.stderr.resume();
      if (error) reject(error); else resolve();
    };
    const onData = chunk => {
      received += chunk.length;
      if (received > 64 * 1024) { finish(new Error('업데이트 도우미 응답을 확인하지 못했어.')); return; }
      pending += chunk.toString('utf8');
      const lines = pending.split(/\r?\n/); pending = lines.pop();
      if (lines.includes(HELPER_READY)) finish();
      else if (pending.length > 4096) finish(new Error('업데이트 도우미 응답을 확인하지 못했어.'));
    };
    // Drain stderr while waiting; helper failures are reported through a controlled message.
    const onStderr = () => {};
    const onError = () => finish(new Error('업데이트 도우미를 실행하지 못했어.'));
    const onExit = () => finish(new Error('업데이트 도우미가 준비되기 전에 종료됐어. 다시 시도해줘.'));
    const timer = setTimeout(() => finish(new Error('업데이트 도우미가 응답하지 않아. 다시 시도해줘.')), timeoutMs);
    child.stdout.on('data', onData);
    child.stderr.on('data', onStderr);
    child.once('error', onError);
    child.once('exit', onExit);
    if (child.exitCode != null || child.signalCode != null) onExit();
  });
}

async function stopHelper(child) {
  if (!child || child.exitCode != null || child.signalCode != null) return;
  await new Promise(resolve => {
    const finish = () => { clearTimeout(timer); child.removeListener('exit', finish); resolve(); };
    const timer = setTimeout(finish, 2000);
    child.once('exit', finish);
    try { if (!child.kill()) finish(); } catch { finish(); }
  });
}

function makeUpdateScript({ parentPid, installer, appExe, scriptPath, expectedHash }) {
  if (!Number.isSafeInteger(parentPid) || parentPid < 1 || !normalizeDigest(expectedHash)) throw new Error('Invalid updater parameters');
  // The signed-in user's NSIS installer owns file replacement, registration and restart.
  // These switches are defined by electron-builder's NsisTarget and installSection.nsh.
  return `$ErrorActionPreference = 'Stop'
$installer = ${psLiteral(installer)}
$appExe = ${psLiteral(appExe)}
$scriptPath = ${psLiteral(scriptPath)}
$stageDir = [System.IO.Path]::GetDirectoryName($installer)
$expected = ${psLiteral(expectedHash.toLowerCase())}
$installed = $false
function Test-ParentRunning {
  try { return -not [System.Diagnostics.Process]::GetProcessById(${parentPid}).HasExited } catch { return $false }
}
function Find-AppProcess {
  foreach ($candidate in [System.Diagnostics.Process]::GetProcessesByName([System.IO.Path]::GetFileNameWithoutExtension($appExe))) {
    try {
      if (-not $candidate.HasExited -and [string]::Equals($candidate.MainModule.FileName, $appExe, [System.StringComparison]::OrdinalIgnoreCase)) { return $candidate }
    } catch {}
  }
  return $null
}
try {
  # Use Windows' own module even when another PowerShell edition changed PSModulePath.
  Import-Module "$PSHOME/Modules/Microsoft.PowerShell.Management/Microsoft.PowerShell.Management.psd1" -ErrorAction Stop
  # Use .NET directly: inherited PSModulePath can hide Get-FileHash in Windows PowerShell.
  $hashAlgorithm = [System.Security.Cryptography.SHA256]::Create()
  $installerStream = $null
  try {
    $installerStream = [System.IO.File]::OpenRead($installer)
    $actualHash = ([System.BitConverter]::ToString($hashAlgorithm.ComputeHash($installerStream))).Replace('-', '').ToLowerInvariant()
  } finally {
    if ($installerStream) { $installerStream.Dispose() }
    $hashAlgorithm.Dispose()
  }
  if ($actualHash -ne $expected) { throw 'SHA256 mismatch' }
  if (-not [System.IO.File]::Exists($appExe)) { throw 'Installed application was not found' }
  # Spawn only confirms powershell.exe exists. Acknowledge successful script startup
  # and checksum verification before the application is allowed to close.
  [Console]::Out.WriteLine('${HELPER_READY}')
  [Console]::Out.Flush()
  Wait-Process -Id ${parentPid} -Timeout 90 -ErrorAction SilentlyContinue
  if (Get-Process -Id ${parentPid} -ErrorAction SilentlyContinue) { throw 'Original process did not stop' }
  $setup = Start-Process -FilePath $installer -ArgumentList @('/S', '--updated', '--force-run') -PassThru -ErrorAction Stop
  # Cache the handle before exit so Windows PowerShell can read ExitCode reliably.
  $null = $setup.Handle
  # Wait only for NSIS. Start-Process -Wait also waits for the restarted app.
  $setup.WaitForExit()
  if ($setup.ExitCode -ne 0) { throw ('Installer failed or was canceled. Exit code: ' + $setup.ExitCode) }
  # Explorer's shell-based launch can fail while NSIS still reports success.
  # Give its launch a moment, then start the installed executable only if absent.
  $restartDeadline = [DateTime]::UtcNow.AddSeconds(3)
  $running = Find-AppProcess
  while (-not $running -and [DateTime]::UtcNow -lt $restartDeadline) {
    [System.Threading.Thread]::Sleep(200)
    $running = Find-AppProcess
  }
  if (-not $running) {
    Start-Process -FilePath $appExe -WorkingDirectory ([System.IO.Path]::GetDirectoryName($appExe)) -ErrorAction Stop
    $restartDeadline = [DateTime]::UtcNow.AddSeconds(15)
    while (-not $running -and [DateTime]::UtcNow -lt $restartDeadline) {
      [System.Threading.Thread]::Sleep(200)
      $running = Find-AppProcess
    }
  }
  if (-not $running) { throw 'Updated application did not restart' }
  $installed = $true
} catch {
  try { [System.IO.File]::WriteAllText([System.IO.Path]::Combine($stageDir, 'update-error.txt'), [string]$_, [System.Text.Encoding]::UTF8) } catch {}
  if (-not (Test-ParentRunning) -and -not (Find-AppProcess) -and [System.IO.File]::Exists($appExe)) {
    Start-Process -FilePath $appExe -WorkingDirectory ([System.IO.Path]::GetDirectoryName($appExe)) -ErrorAction SilentlyContinue
  }
} finally {
  try { [System.IO.File]::Delete($installer) } catch {}
  try { [System.IO.File]::Delete($scriptPath) } catch {}
  if ($installed) {
    try { [System.IO.File]::Delete([System.IO.Path]::Combine($stageDir, '${STAGE_MARKER}')) } catch {}
    try { [System.IO.Directory]::Delete($stageDir) } catch {}
  }
}
`;
}

function createUpdater({ app, shell, dataDir, fetchImpl = fetch, platform = process.platform, env = process.env, spawnImpl = spawn, helperTimeoutMs = 30000, scheduleQuit = callback => setTimeout(callback, 400) }) {
  let checked = null;
  let installing = false;
  const currentVersion = app.getVersion();
  const mode = platform === 'win32' && app.isPackaged ? (env.PORTABLE_EXECUTABLE_FILE ? 'portable' : 'installer') : 'development';
  const result = (patch = {}) => ({ available: false, status: 'retry', version: currentVersion, currentVersion, url: RELEASES_URL, mode, ...patch });

  async function checkUpdate() {
    checked = null;
    try {
      const response = await fetchResponse(LATEST_API, { fetchImpl, api: true, signal: AbortSignal.timeout(15000) });
      if (response.status === 404) return result({ message: '아직 공개된 릴리즈가 없어.' });
      const release = JSON.parse((await readLimited(response, 2 * 1024 * 1024)).toString('utf8'));
      const version = parseVersion(release.tag_name);
      if (!version || release.draft || release.prerelease) return result({ message: '안정 버전 릴리즈를 찾지 못했어.' });
      const url = `${RELEASES_URL}/tag/${encodeURIComponent(release.tag_name)}`;
      if (!isNewer(release.tag_name, currentVersion)) return result({ status: 'current', version: version.join('.'), url, message: '최신 버전이야.' });
      const asset = selectAsset(release);
      // A release can be visible while GitHub Actions is still uploading its setup.
      // Do not offer an install action until the matching Windows asset is ready.
      if (!asset) return result({ version: version.join('.'), url, message: '업데이트 파일을 준비 중이야. 잠시 후 다시 확인해줘.' });
      checked = { release, asset, url, version: version.join('.') };
      return result({ available: true, status: 'available', version: checked.version, url, assetUrl: asset.browser_download_url, assetName: asset.name, digest: normalizeDigest(asset.digest) || undefined, message: '새 버전을 사용할 수 있어.' });
    } catch (error) {
      return result({ message: `업데이트를 확인하지 못했어. ${error.message}` });
    }
  }

  async function installUpdate() {
    if (installing) return { status: 'installing', message: '업데이트를 다운로드하고 있어.' };
    // Acquire before any await: two first-time clicks must not both check/install.
    installing = true;
    let stageDir;
    let helper;
    let handedOff = false;
    try {
      // Refresh even after an earlier check: assets may have finished uploading,
      // been replaced or been withdrawn while the Settings window stayed open.
      const state = await checkUpdate();
      if (!state.available || !checked) return { status: state.status === 'current' ? 'current' : 'retry', message: state.message || '업데이트가 없어.' };
      const { release, asset, url } = checked;
      if (platform !== 'win32' || !app.isPackaged || env.PORTABLE_EXECUTABLE_FILE) {
        await shell.openExternal(url);
        return { status: 'opened', message: '릴리즈 페이지를 열었어. 새 설치 파일을 내려받아 실행해줘.' };
      }
      const appExe = app.getPath('exe');
      if (!path.win32.isAbsolute(appExe) || path.win32.extname(appExe).toLowerCase() !== '.exe') throw new Error('현재 앱 실행 경로를 확인하지 못했어.');
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
      await createStageMarker(stageDir, { installerName: asset.name });
      const stagedExe = path.join(stageDir, asset.name);
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
      const scriptPath = path.join(stageDir, 'apply-update.ps1');
      const script = makeUpdateScript({ parentPid: process.pid, installer: stagedExe, appExe, scriptPath, expectedHash: digest });
      await fs.writeFile(scriptPath, '\ufeff' + script, 'utf8');
      const systemRoot = env.SystemRoot || env.WINDIR || 'C:\\Windows';
      const powershell = path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      const helperEnv = { ...env };
      const blockedEnv = new Set(['PORTABLE_EXECUTABLE_FILE', 'PORTABLE_EXECUTABLE_DIR', 'ELECTRON_RUN_AS_NODE', 'ELECTRON_NO_ASAR', 'NODE_OPTIONS', 'ALLRADIONE_DEV_URL', 'PSMODULEPATH']);
      for (const key of Object.keys(helperEnv)) if (blockedEnv.has(key.toUpperCase())) delete helperEnv[key];
      // Execute our generated literal script directly. No machine or process policy changes.
      // Its working directory must remain outside the installation being replaced.
      helper = spawnImpl(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { detached: true, windowsHide: true, cwd: dataDir, env: helperEnv, stdio: ['ignore', 'pipe', 'pipe'] });
      await waitForHelperReady(helper, { timeoutMs: helperTimeoutMs });
      await setStageOwner(stageDir, helper.pid);
      helper.stdout.unref?.();
      helper.stderr.unref?.();
      helper.unref();
      handedOff = true;
      scheduleQuit(() => app.quit());
      return { status: 'installing', message: '설치 파일 검증 완료. 업데이트 후 다시 시작할게.' };
    } catch (error) {
      // The still-open app keeps the helper waiting. Stop it before deleting its
      // installer, including when readiness or the ownership handoff failed.
      if (!handedOff) await stopHelper(helper);
      // Only our unique staging directory is removed. Existing app/settings stay intact.
      if (stageDir) await fs.rm(stageDir, { recursive: true, force: true }).catch(() => {});
      return { status: 'retry', message: `업데이트를 적용하지 못했어. ${error.message}` };
    } finally { if (!handedOff) installing = false; }
  }
  return { checkUpdate, installUpdate };
}

module.exports = { createUpdater, parseVersion, isNewer, allowedAssetUrl, allowedRedirect, selectAsset, normalizeDigest, checksumFor, makeUpdateScript, waitForHelperReady, HELPER_READY, readLimited, fetchResponse };
