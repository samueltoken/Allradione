'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { createUpdater, parseVersion, isNewer, selectAsset, allowedAssetUrl, allowedRedirect, normalizeDigest, checksumFor, readLimited, fetchResponse } = require('../electron/updater.cjs');
const tag = 'v0.2.0';
const name = 'Allradione-Setup-0.2.0-x64.exe';
const assetUrl = `https://github.com/samueltoken/Allradione/releases/download/${tag}/${name}`;
const hash = 'c'.repeat(64);

async function windowsUpdateHarness(t, { launchError, env = {} } = {}) {
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
    shell: { openExternal: async () => { calls.opened++; } }, dataDir, platform: 'win32', env,
    fetchImpl: async url => {
      if (url === 'https://api.github.com/repos/samueltoken/Allradione/releases/latest') {
        calls.checks++;
        return new Response(JSON.stringify(release));
      }
      assert.equal(url, assetUrl, 'Only the exact release installer may be downloaded');
      calls.downloads++;
      return new Response(payload);
    },
    spawnImpl: (exe, args, options) => {
      assert.equal(calls.quit, 0, 'The application must remain open until helper handoff');
      launches.push({ exe, args, options });
      const child = new EventEmitter();
      child.pid = launchError ? undefined : 4000000;
      child.unref = () => {};
      children.push(child);
      process.nextTick(() => launchError ? child.emit('error', launchError) : child.emit('spawn'));
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
  assert.equal(result.status, 'opened');
  assert.deepEqual(calls, { checks: 2, downloads: 1, opened: 0, quit: 0 });
  assert.equal(launches.length, 1);
  const [stage] = await fs.readdir(path.join(dataDir, 'updates'));
  assert.equal(launches[0].exe, path.join(dataDir, 'updates', stage, name));
  assert.deepEqual(launches[0].args, ['--updated', '/ALLRADIONEAPP=' + process.pid]);
  assert.equal(launches[0].options.windowsHide, false);
  assert.equal(launches[0].options.shell, undefined);
  assert.deepEqual((await fs.readdir(path.dirname(launches[0].exe))).sort(), [name, 'allradione-update-stage.json'].sort());
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
  assert.equal((await updater.installUpdate()).status, 'opened');
  assert.deepEqual(calls, { checks: 2, downloads: 1, opened: 0, quit: 0 });
  assert.equal(launches.length, 1);
});

test('a failed Setup launch keeps the app running, cleans its download and permits another attempt', async t => {
  const { updater, calls, dataDir } = await windowsUpdateHarness(t, { launchError: new Error('Cannot launch Setup') });
  for (let i = 0; i < 2; i++) assert.equal((await updater.installUpdate()).status, 'retry');
  assert.equal(calls.quit, 0);
  assert.equal(calls.downloads, 2);
  assert.deepEqual(await fs.readdir(path.join(dataDir, 'updates')), []);
});

test('Setup runs outside the installation without app runtime overrides', async t => {
  const env = { SystemRoot: 'C:\\Windows', PATH: 'preserved-system-path', PORTABLE_EXECUTABLE_DIR: 'C:\\old', ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '--inspect', PSModulePath: 'C:\\OtherPowerShell\\Modules', ALLRADIONE_DEV_URL: 'http://localhost:5173' };
  const { updater, launches, dataDir } = await windowsUpdateHarness(t, { env });
  assert.equal((await updater.installUpdate()).status, 'opened');
  assert.equal(launches[0].options.cwd, dataDir);
  assert.equal(launches[0].options.stdio, 'ignore');
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
  assert.match(second.message, /진행하고/);
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

test('cancelling Setup cleans its stage and allows retry without quitting the player', async t => {
  const { updater, dataDir, calls, launches, children } = await windowsUpdateHarness(t);
  await updater.installUpdate();
  await updater.installUpdate();
  assert.equal(launches.length, 1);
  children[0].emit('exit', 1);
  for (let attempt = 0; attempt < 100 && (await fs.readdir(path.join(dataDir, 'updates'))).length; attempt++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(await fs.readdir(path.join(dataDir, 'updates')), []);
  assert.equal(calls.quit, 0);
  assert.equal((await updater.installUpdate()).status, 'opened');
  assert.equal(launches.length, 2);
});

test('the player exits once after the user confirms the native welcome page', async t => {
  const { updater, launches, calls } = await windowsUpdateHarness(t);
  await updater.installUpdate();
  assert.equal(calls.quit, 0);
  await fs.writeFile(path.join(path.dirname(launches[0].exe), 'setup-confirmed'), '1');
  for (let attempt = 0; attempt < 60 && !calls.quit; attempt++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(calls.quit, 1);
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
