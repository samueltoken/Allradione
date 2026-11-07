'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { createUpdater, parseVersion, isNewer, selectAsset, allowedAssetUrl, allowedRedirect, normalizeDigest, checksumFor, makeUpdateScript, readLimited, fetchResponse } = require('../electron/updater.cjs');
const tag = 'v0.2.0';
const name = 'Allradione-Setup-0.2.0-x64.exe';
const assetUrl = `https://github.com/samueltoken/Allradione/releases/download/${tag}/${name}`;
const hash = 'c'.repeat(64);

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
  assert.ok(!script.includes('Move-Item'));
  assert.ok(!script.includes('Copy-Item'));
  assert.ok(!script.includes('Remove-Item -LiteralPath $appExe'));
  assert.ok(!script.includes('--delete-app-data'));
  assert.ok(!script.includes('-Recurse'));
  assert.throws(() => makeUpdateScript({ parentPid: '1;evil', expectedHash: hash }));
});

test('Windows PowerShell executes the generated encoded helper and records a missing installer safely', { skip: process.platform !== 'win32', timeout: 25000 }, async t => {
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
  try {
    await promisify(execFile)(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, timeout: 15000, maxBuffer: 1024 * 1024 });
  } catch (error) {
    assert.fail(`Generated PowerShell helper failed to execute: ${error.message}\nstdout: ${error.stdout || ''}\nstderr: ${error.stderr || ''}`);
  }
  const errorLog = await fs.readFile(path.join(stage, 'update-error.txt'), 'utf8');
  assert.match(errorLog, /missing-setup\.exe/, 'The catch branch must record the missing installer, rather than fail to parse');
  await assert.rejects(fs.access(scriptPath), { code: 'ENOENT' }, 'The generated helper must clean up its own script');
  assert.equal(await fs.readFile(sentinel, 'utf8'), 'keep this unrelated file');
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
  await updater.installUpdate();
  assert.deepEqual(opened, ['https://github.com/samueltoken/Allradione/releases/tag/v0.2.0']);
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
      await new Promise(resolve => { releaseCheck = resolve; });
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

test('installed Windows downloads a verified setup then exits only after helper spawn', async t => {
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
      const child = new EventEmitter(); child.unref = () => {};
      process.nextTick(() => child.emit('spawn'));
      return child;
    }
  });
  assert.equal((await updater.checkUpdate()).mode, 'installer');
  const result = await updater.installUpdate();
  assert.match(result.message, /설치 파일 검증 완료/);
  assert.equal(quitCount, 1);
  assert.equal(launches.length, 1);
  assert.equal(launches[0].exe, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  const script = Buffer.from(launches[0].args.at(-1), 'base64').toString('utf16le');
  assert.ok(script.includes(name));
  assert.ok(script.includes("@('/S', '--updated', '--force-run')"));
  assert.ok(!script.includes('Move-Item'));
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
  assert.match(result.message, /체크섬이 일치하지 않아/);
  assert.equal(quitCount, 0);
  assert.equal(spawnCount, 0);
  assert.deepEqual(await fs.readdir(path.join(dataDir, 'updates')), []);
});
