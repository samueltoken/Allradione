'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { execFile, spawn } = require('node:child_process');
const { promisify } = require('node:util');
const { createUpdater, parseVersion, isNewer, selectAsset, allowedAssetUrl, allowedRedirect, normalizeDigest, checksumFor, makeUpdateScript, waitForHelperReady, HELPER_READY, readLimited, fetchResponse } = require('../electron/updater.cjs');
const tag = 'v0.2.0';
const name = 'Allradione-Setup-0.2.0-x64.exe';
const assetUrl = `https://github.com/samueltoken/Allradione/releases/download/${tag}/${name}`;
const hash = 'c'.repeat(64);

function fakeHelper() {
  const child = new EventEmitter();
  child.pid = process.pid; child.exitCode = null; child.signalCode = null; child.killed = false;
  child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.unref = () => {};
  child.kill = () => { child.killed = true; child.signalCode = 'SIGTERM'; child.emit('exit', null, 'SIGTERM'); return true; };
  return child;
}

async function windowsUpdateHarness(t, { ready = true, onSpawn, helperTimeoutMs = 30000, env = {} } = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'allradione-update-test-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const payload = Buffer.alloc(2048, 0x40); payload.write('MZ');
  const digest = crypto.createHash('sha256').update(payload).digest('hex');
  const asset = { name, browser_download_url: assetUrl, digest: 'sha256:' + digest, state: 'uploaded' };
  const release = { tag_name: tag, assets: [asset] };
  const calls = { checks: 0, downloads: 0, opened: 0, quit: 0 };
  const launches = [];
  const children = [];
  const updater = createUpdater({
    app: { getVersion: () => '0.1.0', isPackaged: true, getPath: () => 'C:\\Programs\\Allradione\\Allradione.exe', quit: () => { calls.quit++; } },
    shell: { openExternal: async () => { calls.opened++; } }, dataDir, platform: 'win32', env, helperTimeoutMs,
    fetchImpl: async url => {
      if (url === 'https://api.github.com/repos/samueltoken/Allradione/releases/latest') {
        calls.checks++;
        return new Response(JSON.stringify(release));
      }
      assert.equal(url, assetUrl, 'Only the exact release installer may be downloaded');
      calls.downloads++;
      return new Response(payload);
    },
    scheduleQuit: callback => callback(),
    spawnImpl: (exe, args, options) => {
      assert.equal(calls.quit, 0, 'The application must remain open until helper handoff');
      launches.push({ exe, args, options });
      const child = fakeHelper(); children.push(child);
      process.nextTick(() => { child.emit('spawn'); onSpawn?.(child); if (ready) child.stdout.write(HELPER_READY + '\r\n'); });
      return child;
    }
  });
  return { updater, release, asset, payload, digest, dataDir, calls, launches, children };
}

test('stable semantic versions compare numerically and reject malformed input', () => {
  assert.deepEqual(parseVersion('v12.10.3'), [12, 10, 3]);
  assert.equal(isNewer('0.10.0', '0.9.9'), true);
  assert.equal(isNewer('0.2.0', '0.2.0'), false);
  assert.equal(isNewer('0.1.9', '0.2.0'), false);
  for (const value of ['v01.2.3', '0.2.0-beta.1', '0.2', '1.2.3/../../x', '9999999999999999999.0.0']) assert.equal(parseVersion(value), null);
});

test('only the exact release NSIS installer asset is selected', () => {
  const asset = { name, browser_download_url: assetUrl };
  assert.equal(selectAsset({ tag_name: tag, assets: [asset] }), asset);
  assert.equal(selectAsset({ tag_name: tag, prerelease: true, assets: [asset] }), null);
  assert.equal(selectAsset({ tag_name: tag, assets: [{ ...asset, browser_download_url: assetUrl.replace('samueltoken', 'attacker') }] }), null);
  assert.equal(selectAsset({ tag_name: tag, assets: [{ ...asset, name: 'evil.exe' }] }), null);
  assert.equal(selectAsset({ tag_name: tag, assets: [{ name: 'Allradione-0.2.0-win-x64.exe', browser_download_url: assetUrl.replace(name, 'Allradione-0.2.0-win-x64.exe') }] }), null);
});

test('partially uploaded release assets are unavailable until GitHub marks them uploaded', () => {
  const asset = { name, browser_download_url: assetUrl, state: 'uploaded' };
  assert.equal(selectAsset({ tag_name: tag, assets: [asset] }), asset);
  for (const state of ['uploading', 'starter', 'failed', '', null]) {
    assert.equal(selectAsset({ tag_name: tag, assets: [{ ...asset, state }] }), null, `Unready state: ${state}`);
  }
});

test('asset URL validation rejects credentials, alternate hosts, ports and suffixes', () => {
  assert.equal(allowedAssetUrl(assetUrl, tag, name), true);
  for (const candidate of [assetUrl + '?x=1', assetUrl + '#x', assetUrl.replace('github.com', 'github.com.evil.test'), assetUrl.replace('https:', 'http:'), assetUrl.replace('github.com', 'user:pass@github.com'), assetUrl.replace('github.com', 'github.com:443'), assetUrl.replace(tag, 'v0.1.0')]) {
    // URL canonicalization drops an explicit default TLS port, which is harmless.
    if (!candidate.includes(':443')) assert.equal(allowedAssetUrl(candidate, tag, name), false, candidate);
  }
  assert.equal(allowedRedirect('https://release-assets.githubusercontent.com/a?signature=x'), true);
  assert.equal(allowedRedirect('https://localhost/x'), false);
  assert.equal(allowedRedirect('https://release-assets.githubusercontent.com.evil.test/x'), false);
});

test('checksum manifests match one exact filename and reject duplicates', () => {
  assert.equal(normalizeDigest('sha256:' + hash.toUpperCase()), hash);
  assert.equal(normalizeDigest('sha1:' + hash), null);
  assert.equal(checksumFor(`${hash}  ${name}\n`, name), hash);
  assert.equal(checksumFor(`${hash} *${name}\r\n`, name), hash);
  assert.equal(checksumFor(`${hash}  ../${name}\n`, name), null);
  assert.equal(checksumFor(`${hash}  ${name}\n${hash}  ${name}`, name), null);
});

test('updater script waits for clean exit and delegates replacement/restart to NSIS', () => {
  const appExe = "C:\\Users\\O'Brien\\Allradione.exe";
  const script = makeUpdateScript({ parentPid: 1234, appExe, installer: 'C:\\update\\setup.exe', scriptPath: 'C:\\update\\script.ps1', expectedHash: hash });
  assert.ok(script.includes("$appExe = 'C:\\Users\\O''Brien\\Allradione.exe'"));
  assert.ok(script.includes('Wait-Process -Id 1234'));
  assert.ok(script.includes("-ArgumentList @('/S', '--updated', '--force-run')"));
  const setupLaunch = script.split('\n').find(line => line.includes('$setup = Start-Process'));
  assert.match(setupLaunch, /-PassThru -ErrorAction Stop/);
  assert.doesNotMatch(setupLaunch, /-Wait(?:\s|$)/);
  assert.ok(script.indexOf('$null = $setup.Handle') < script.indexOf('$setup.WaitForExit()'));
  assert.ok(script.indexOf('$setup.WaitForExit()') > script.indexOf(setupLaunch));
  assert.ok(script.indexOf('$setup.WaitForExit()') < script.indexOf('if ($setup.ExitCode -ne 0)'));
  assert.ok(script.indexOf('SHA256 mismatch') < script.indexOf(HELPER_READY), 'Readiness follows checksum verification');
  assert.ok(script.indexOf(HELPER_READY) < script.indexOf('Wait-Process -Id 1234'), 'Readiness precedes waiting for the application to exit');
  assert.ok(script.includes('if (-not $running)'), 'A failed shell restart has a direct executable fallback');
  assert.ok(script.includes('-not (Test-ParentRunning)'), 'Preflight failures must not start a duplicate of the still-open app');
  assert.ok(!script.includes('Move-Item'));
  assert.ok(!script.includes('Copy-Item'));
  assert.ok(!script.includes('Remove-Item -LiteralPath $appExe'));
  assert.ok(!script.includes('--delete-app-data'));
  assert.ok(!script.includes('-Recurse'));
  assert.throws(() => makeUpdateScript({ parentPid: '1;evil', expectedHash: hash }));
});

test('helper readiness requires the complete exact protocol line, not a process spawn', async () => {
  const child = fakeHelper();
  let ready = false;
  const waiting = waitForHelperReady(child, { timeoutMs: 1000 }).then(() => { ready = true; });
  child.emit('spawn');
  child.stdout.write('diagnostic line\r\n' + HELPER_READY.slice(0, 12));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(ready, false);
  child.stdout.write(HELPER_READY.slice(12) + '\r\n');
  await waiting;
  assert.equal(ready, true);
});

test('helper exit before readiness and readiness timeout reject the handoff', async () => {
  const exited = fakeHelper();
  const failure = assert.rejects(waitForHelperReady(exited, { timeoutMs: 1000 }), /준비되기 전에 종료/);
  exited.exitCode = 1; exited.emit('exit', 1, null);
  await failure;
  await assert.rejects(waitForHelperReady(fakeHelper(), { timeoutMs: 10 }), /응답하지 않아/);
});

test('Windows PowerShell executes the generated encoded helper and safely rejects missing or corrupt installers', { skip: process.platform !== 'win32', timeout: 40000 }, async t => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'allradione-powershell-test-'));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const stage = path.join(temporary, "O'Brien 한글");
  await fs.mkdir(stage);
  const installer = path.join(stage, 'missing-setup.exe');
  const scriptPath = path.join(stage, 'apply-update.ps1');
  const sentinel = path.join(stage, 'keep.txt');
  await fs.writeFile(sentinel, 'keep this unrelated file');
  const script = makeUpdateScript({ parentPid: process.pid, installer, appExe: path.join(stage, 'nonexistent-app.exe'), scriptPath, expectedHash: hash });
  await fs.writeFile(scriptPath, '\ufeff' + script, 'utf8');
  const powershell = path.join(process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const execute = async () => {
    try {
      await promisify(execFile)(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, timeout: 15000, maxBuffer: 1024 * 1024 });
    } catch (error) {
      assert.fail(`Generated PowerShell helper failed to execute: ${error.message}\nstdout: ${error.stdout || ''}\nstderr: ${error.stderr || ''}`);
    }
  };
  await execute();
  const errorLog = await fs.readFile(path.join(stage, 'update-error.txt'), 'utf8');
  assert.match(errorLog, /missing-setup\.exe/, 'The catch branch must record the missing installer, rather than fail to parse');
  await assert.rejects(fs.access(scriptPath), { code: 'ENOENT' }, 'The generated helper must clean up its own script');
  assert.equal(await fs.readFile(sentinel, 'utf8'), 'keep this unrelated file');
  // A present file exercises .NET streaming SHA256 before the controlled parent wait.
  await fs.writeFile(installer, 'MZ deliberately incorrect installer bytes');
  await fs.writeFile(scriptPath, '\ufeff' + script, 'utf8');
  await execute();
  assert.match(await fs.readFile(path.join(stage, 'update-error.txt'), 'utf8'), /SHA256 mismatch/);
  await assert.rejects(fs.access(installer), { code: 'ENOENT' });
  await assert.rejects(fs.access(scriptPath), { code: 'ENOENT' });
  assert.equal(await fs.readFile(sentinel, 'utf8'), 'keep this unrelated file');
});

test('real Windows PowerShell acknowledges readiness while the original app remains alive', { skip: process.platform !== 'win32', timeout: 30000 }, async t => {
  const stage = await fs.mkdtemp(path.join(os.tmpdir(), 'allradione-helper-ready-'));
  t.after(() => fs.rm(stage, { recursive: true, force: true }));
  const installer = path.join(stage, 'never-execute-fixture.exe');
  const scriptPath = path.join(stage, 'apply-update.ps1');
  const payload = Buffer.alloc(2048, 0x40); payload.write('MZ');
  await fs.writeFile(installer, payload);
  const expectedHash = crypto.createHash('sha256').update(payload).digest('hex');
  const script = makeUpdateScript({ parentPid: process.pid, installer, appExe: process.execPath, scriptPath, expectedHash });
  await fs.writeFile(scriptPath, '\ufeff' + script, 'utf8');
  const powershell = path.join(process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const child = spawn(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { cwd: stage, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    await waitForHelperReady(child, { timeoutMs: 15000 });
    assert.equal(child.exitCode, null, 'The helper must wait after acknowledging readiness');
    assert.equal(process.kill(process.pid, 0), true, 'The original application process remains alive');
    assert.deepEqual(await fs.readFile(installer), payload, 'The installer must remain untouched while its parent is alive');
    await assert.rejects(fs.access(path.join(stage, 'update-error.txt')), { code: 'ENOENT' });
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const stopped = new Promise(resolve => child.once('exit', resolve));
      child.kill();
      await stopped;
    }
  }
});

test('download follows only trusted redirects and enforces body size', async () => {
  await assert.rejects(fetchResponse(assetUrl, { fetchImpl: async () => new Response('', { status: 302, headers: { location: 'http://127.0.0.1/secrets' } }) }), /GitHub/);
  await assert.rejects(readLimited(new Response('too long'), 3), /크기/);
  assert.equal((await readLimited(new Response('ok'), 3)).toString(), 'ok');
});

test('checkUpdate handles missing releases and exposes a real newer asset', async () => {
  const app = { getVersion: () => '0.1.0' };
  const missing = createUpdater({ app, shell: {}, dataDir: '/unused', fetchImpl: async () => new Response('', { status: 404 }) });
  assert.equal((await missing.checkUpdate()).available, false);
  const release = { tag_name: tag, assets: [{ name, browser_download_url: assetUrl, digest: 'sha256:' + hash }] };
  const opened = [];
  const updater = createUpdater({ app, shell: { openExternal: async value => opened.push(value) }, dataDir: '/unused', platform: 'linux', fetchImpl: async () => new Response(JSON.stringify(release)) });
  const state = await updater.checkUpdate();
  assert.equal(state.available, true);
  assert.equal(state.assetUrl, assetUrl);
  assert.equal(state.digest, hash);
  assert.equal(state.version, '0.2.0');
  assert.equal(state.mode, 'development');
  assert.equal((await updater.installUpdate()).status, 'opened');
  assert.deepEqual(opened, ['https://github.com/samueltoken/Allradione/releases/tag/v0.2.0']);
});

test('a release checked before asset upload becomes installable without restarting the app', async t => {
  const { updater, release, asset, payload, digest, dataDir, calls, launches } = await windowsUpdateHarness(t);
  release.assets = [];
  const pending = await updater.checkUpdate();
  assert.equal(pending.available, false);
  assert.equal(pending.version, '0.2.0');
  assert.equal(pending.message, '업데이트 파일을 준비 중이야. 잠시 후 다시 확인해줘.');
  release.assets = [asset];
  const result = await updater.installUpdate();
  assert.equal(result.status, 'installing');
  assert.deepEqual(calls, { checks: 2, downloads: 1, opened: 0, quit: 1 });
  assert.equal(launches.length, 1);
  const script = Buffer.from(launches[0].args.at(-1), 'base64').toString('utf16le');
  assert.ok(script.includes(digest), 'The helper must verify the downloaded installer again');
  assert.ok(script.includes("@('/S', '--updated', '--force-run')"), 'Verified updates must use silent installation and restart');
  const [stage] = await fs.readdir(path.join(dataDir, 'updates'));
  assert.deepEqual(await fs.readFile(path.join(dataDir, 'updates', stage, name)), payload);
});

test('an unfinished release remains retryable without opening a browser or quitting Windows', async t => {
  const { updater, release, dataDir, calls, launches } = await windowsUpdateHarness(t);
  release.assets = [];
  assert.equal((await updater.checkUpdate()).available, false);
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await updater.installUpdate();
    assert.equal(result.status, 'retry');
    assert.equal(result.message, '업데이트 파일을 준비 중이야. 잠시 후 다시 확인해줘.');
  }
  assert.deepEqual(calls, { checks: 3, downloads: 0, opened: 0, quit: 0 });
  assert.equal(launches.length, 0);
  assert.deepEqual(await fs.readdir(dataDir), [], 'No installation stage should exist before an asset is ready');
});

test('a cached ready asset removed before installation is not downloaded or executed', async t => {
  const { updater, release, calls, launches } = await windowsUpdateHarness(t);
  assert.equal((await updater.checkUpdate()).available, true);
  release.assets = [];
  assert.equal((await updater.installUpdate()).status, 'retry');
  assert.deepEqual(calls, { checks: 2, downloads: 0, opened: 0, quit: 0 });
  assert.equal(launches.length, 0);
});

test('an uploading asset can be retried and installed after upload completes', async t => {
  const { updater, asset, calls, launches } = await windowsUpdateHarness(t);
  asset.state = 'uploading';
  assert.equal((await updater.installUpdate()).status, 'retry');
  assert.deepEqual(calls, { checks: 1, downloads: 0, opened: 0, quit: 0 });
  asset.state = 'uploaded';
  assert.equal((await updater.installUpdate()).status, 'installing');
  assert.deepEqual(calls, { checks: 2, downloads: 1, opened: 0, quit: 1 });
  assert.equal(launches.length, 1);
});

test('a helper that exits before readiness leaves the app running and clears its download', async t => {
  const { updater, calls, dataDir } = await windowsUpdateHarness(t, {
    ready: false,
    onSpawn: child => { child.exitCode = 1; child.emit('exit', 1, null); }
  });
  const result = await updater.installUpdate();
  assert.equal(result.status, 'retry');
  assert.match(result.message, /준비되기 전에 종료/);
  assert.equal(calls.quit, 0);
  assert.deepEqual(await fs.readdir(path.join(dataDir, 'updates')), []);
});

test('a stalled helper is stopped before cleanup and never closes the application', async t => {
  const { updater, calls, dataDir, children } = await windowsUpdateHarness(t, { ready: false, helperTimeoutMs: 10 });
  const result = await updater.installUpdate();
  assert.equal(result.status, 'retry');
  assert.match(result.message, /응답하지 않아/);
  assert.equal(calls.quit, 0);
  assert.equal(children[0].killed, true);
  assert.deepEqual(await fs.readdir(path.join(dataDir, 'updates')), []);
});

test('the helper runs outside the app directory and does not inherit runtime override variables', async t => {
  const env = { SystemRoot: 'C:\\Windows', PATH: 'preserved-system-path', PORTABLE_EXECUTABLE_DIR: 'C:\\old', ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '--inspect', PSModulePath: 'C:\\OtherPowerShell\\Modules', ALLRADIONE_DEV_URL: 'http://localhost:5173' };
  const { updater, launches, dataDir } = await windowsUpdateHarness(t, { env });
  assert.equal((await updater.installUpdate()).status, 'installing');
  assert.equal(launches[0].options.cwd, dataDir);
  assert.deepEqual(launches[0].options.stdio, ['ignore', 'pipe', 'pipe']);
  assert.deepEqual(launches[0].options.env, { SystemRoot: 'C:\\Windows', PATH: 'preserved-system-path' });
  assert.equal(env.ELECTRON_RUN_AS_NODE, '1', 'Sanitization must not mutate the current application environment');
});

test('first-time concurrent install calls share the early lock across a delayed release check', async () => {
  let releaseCheck;
  let fetchCount = 0;
  let openCount = 0;
  const release = { tag_name: tag, assets: [{ name, browser_download_url: assetUrl, digest: 'sha256:' + hash }] };
  const updater = createUpdater({
    app: { getVersion: () => '0.1.0' },
    shell: { openExternal: async () => { openCount++; } },
    dataDir: '/unused', platform: 'linux',
    fetchImpl: async () => {
      fetchCount++;
      if (fetchCount === 1) await new Promise(resolve => { releaseCheck = resolve; });
      return new Response(JSON.stringify(release));
    }
  });
  const first = updater.installUpdate();
  assert.equal(fetchCount, 1);
  const second = await updater.installUpdate();
  assert.match(second.message, /다운로드하고/);
  assert.equal(fetchCount, 1, 'a concurrent initial install must not start another network check');
  releaseCheck();
  await first;
  assert.equal(openCount, 1, 'only one installation/fallback action is performed');
  await updater.installUpdate();
  assert.equal(openCount, 2, 'non-handoff completion releases the lock for a later user retry');
  assert.equal(fetchCount, 2, 'Every new install attempt refreshes the release metadata');
});

test('an early check failure releases the install lock for retry', async () => {
  let fetchCount = 0;
  const updater = createUpdater({
    app: { getVersion: () => '0.1.0' }, shell: {}, dataDir: '/unused',
    fetchImpl: async () => { fetchCount++; return new Response('', { status: 404 }); }
  });
  await updater.installUpdate();
  await updater.installUpdate();
  assert.equal(fetchCount, 2);
});

test('installed Windows downloads a verified setup then exits only after helper readiness', async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'allradione-update-test-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const payload = Buffer.alloc(2048, 0x40);
  payload.write('MZ');
  const digest = crypto.createHash('sha256').update(payload).digest('hex');
  const release = { tag_name: tag, assets: [{ name, browser_download_url: assetUrl, digest: 'sha256:' + digest }] };
  let quitCount = 0;
  const launches = [];
  const updater = createUpdater({
    app: { getVersion: () => '0.1.0', isPackaged: true, getPath: () => 'C:\\Users\\listener\\AppData\\Local\\Programs\\Allradione\\Allradione.exe', quit: () => { quitCount++; } },
    shell: {}, dataDir, platform: 'win32', env: { SystemRoot: 'C:\\Windows' },
    fetchImpl: async url => new Response(url === assetUrl ? payload : JSON.stringify(release)),
    scheduleQuit: callback => callback(),
    spawnImpl: (exe, args, options) => {
      assert.equal(quitCount, 0);
      launches.push({ exe, args, options });
      const child = fakeHelper();
      process.nextTick(() => {
        child.emit('spawn');
        setTimeout(() => { assert.equal(quitCount, 0, 'Spawn alone must never close the app'); child.stdout.write(HELPER_READY + '\r\n'); }, 20);
      });
      return child;
    }
  });
  assert.equal((await updater.checkUpdate()).mode, 'installer');
  const result = await updater.installUpdate();
  assert.equal(result.status, 'installing');
  assert.match(result.message, /설치 파일 검증 완료/);
  assert.equal(quitCount, 1);
  assert.equal(launches.length, 1);
  assert.equal(launches[0].exe, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  const script = Buffer.from(launches[0].args.at(-1), 'base64').toString('utf16le');
  assert.ok(script.includes(name));
  assert.ok(script.includes("@('/S', '--updated', '--force-run')"));
  assert.ok(!script.includes('Move-Item'));
  const [stageName] = await fs.readdir(path.join(dataDir, 'updates'));
  const stageMarker = JSON.parse(await fs.readFile(path.join(dataDir, 'updates', stageName, 'allradione-update-stage.json'), 'utf8'));
  assert.equal(stageMarker.ownerPid, process.pid, 'The stage is transferred to the spawned helper PID');
  assert.equal(stageMarker.installerName, name);
  await updater.installUpdate();
  assert.equal(launches.length, 1, 'the handed-off update remains locked until exit');
});

test('legacy portable mode opens the setup release instead of replacing its launcher', async () => {
  const release = { tag_name: tag, assets: [{ name, browser_download_url: assetUrl, digest: 'sha256:' + hash }] };
  let openCount = 0, spawnCount = 0;
  const updater = createUpdater({
    app: { getVersion: () => '0.1.0', isPackaged: true },
    shell: { openExternal: async () => { openCount++; } }, dataDir: '/unused', platform: 'win32',
    env: { PORTABLE_EXECUTABLE_FILE: 'C:\\Downloads\\Allradione.exe' },
    fetchImpl: async () => new Response(JSON.stringify(release)),
    spawnImpl: () => { spawnCount++; throw new Error('must not spawn'); }
  });
  assert.equal((await updater.checkUpdate()).mode, 'portable');
  const result = await updater.installUpdate();
  assert.equal(result.status, 'opened');
  assert.match(result.message, /새 설치 파일/);
  assert.equal(openCount, 1);
  assert.equal(spawnCount, 0);
});

test('checksum mismatch discards the setup and keeps the installed application running', async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'allradione-update-test-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const payload = Buffer.alloc(2048, 0x40); payload.write('MZ');
  const release = { tag_name: tag, assets: [{ name, browser_download_url: assetUrl, digest: 'sha256:' + hash }] };
  let quitCount = 0, spawnCount = 0;
  const updater = createUpdater({
    app: { getVersion: () => '0.1.0', isPackaged: true, getPath: () => 'C:\\Programs\\Allradione\\Allradione.exe', quit: () => { quitCount++; } },
    shell: {}, dataDir, platform: 'win32', env: {},
    fetchImpl: async url => new Response(url === assetUrl ? payload : JSON.stringify(release)),
    spawnImpl: () => { spawnCount++; throw new Error('must not launch'); }
  });
  const result = await updater.installUpdate();
  assert.equal(result.status, 'retry');
  assert.match(result.message, /체크섬이 일치하지 않아/);
  assert.equal(quitCount, 0);
  assert.equal(spawnCount, 0);
  assert.deepEqual(await fs.readdir(path.join(dataDir, 'updates')), []);
});
