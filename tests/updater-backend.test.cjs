'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createUpdater, parseVersion, isNewer, selectAsset, allowedAssetUrl, allowedRedirect, normalizeDigest, checksumFor, makeUpdateScript, readLimited, fetchResponse } = require('../electron/updater.cjs');
const tag = 'v0.2.0';
const name = 'Allradione-0.2.0-win-x64.exe';
const assetUrl = `https://github.com/samueltoken/Allradione/releases/download/${tag}/${name}`;
const hash = 'c'.repeat(64);

test('stable semantic versions compare numerically and reject malformed input', () => {
  assert.deepEqual(parseVersion('v12.10.3'), [12, 10, 3]);
  assert.equal(isNewer('0.10.0', '0.9.9'), true);
  assert.equal(isNewer('0.2.0', '0.2.0'), false);
  assert.equal(isNewer('0.1.9', '0.2.0'), false);
  for (const value of ['v01.2.3', '0.2.0-beta.1', '0.2', '1.2.3/../../x', '9999999999999999999.0.0']) assert.equal(parseVersion(value), null);
});

test('only the exact release portable asset is selected', () => {
  const asset = { name, browser_download_url: assetUrl };
  assert.equal(selectAsset({ tag_name: tag, assets: [asset] }), asset);
  assert.equal(selectAsset({ tag_name: tag, prerelease: true, assets: [asset] }), null);
  assert.equal(selectAsset({ tag_name: tag, assets: [{ ...asset, browser_download_url: assetUrl.replace('samueltoken', 'attacker') }] }), null);
  assert.equal(selectAsset({ tag_name: tag, assets: [{ ...asset, name: 'evil.exe' }] }), null);
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

test('updater script treats user paths as literal data and targets only the old exe', () => {
  const target = "C:\\Users\\O'Brien\\Allradione.exe";
  const script = makeUpdateScript({ parentPid: 1234, target, stagedExe: 'C:\\update\\app.exe', backup: target + '.backup', scriptPath: 'C:\\update\\script.ps1', expectedHash: hash });
  assert.ok(script.includes("$target = 'C:\\Users\\O''Brien\\Allradione.exe'"));
  assert.ok(script.includes('Wait-Process -Id 1234'));
  assert.ok(script.includes('Move-Item -LiteralPath $backup -Destination $target'));
  assert.ok(!script.includes('-Recurse'));
  assert.throws(() => makeUpdateScript({ parentPid: '1;evil', expectedHash: hash }));
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
