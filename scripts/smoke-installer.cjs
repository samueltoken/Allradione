#!/usr/bin/env node
'use strict';
/** Windows CI only: install, retain preferences through an upgrade, test the installed app, uninstall. */
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const ROOT = path.resolve(__dirname, '..');
const OUTPUT = path.join(ROOT, 'artifacts');
const APP_ID = 'io.github.samueltoken.allradione';
const MARKER = 'allradione-owner.txt';

function sameWindowsPath(left, right) {
  return path.win32.normalize(left).replace(/[\\/]+$/, '').toLowerCase() === path.win32.normalize(right).replace(/[\\/]+$/, '').toLowerCase();
}

function nsisArguments(directory, { uninstall = false, noDesktopShortcut = false } = {}) {
  assert.ok(path.win32.isAbsolute(directory), 'NSIS destination must be an absolute Windows path');
  assert.ok(!/["\r\n]/.test(directory), 'NSIS destination cannot contain quotes or line breaks');
  assert.notEqual(path.win32.parse(directory).root.toLowerCase(), directory.toLowerCase(), 'Never install into a drive root');
  return ['/S', '/currentuser', ...(noDesktopShortcut ? ['--no-desktop-shortcut'] : []), `${uninstall ? '_?=' : '/D='}${directory}`];
}

function assertFreshSnapshot(snapshot) {
  assert.deepEqual(snapshot.installations, [], 'Refusing to alter a pre-existing Allradione installation');
  assert.deepEqual(snapshot.existingShortcuts, [], 'Refusing to alter pre-existing Allradione shortcuts');
  assert.deepEqual(snapshot.existingData, [], 'Refusing to alter pre-existing Allradione user data');
  assert.deepEqual(snapshot.runningProcesses, [], 'Refusing to alter a running Allradione instance');
}

async function exists(file) { try { await fs.access(file); return true; } catch { return false; } }
async function poll(check, label, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 250)); }
  throw new Error(`Timed out: ${label}`);
}

function runProcess(executable, args, { timeout = 180000, env = process.env, verbatim = false, inherit = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd: ROOT, env, windowsHide: true, windowsVerbatimArguments: verbatim, stdio: inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout?.on('data', chunk => { stdout = (stdout + chunk).slice(-262144); });
    child.stderr?.on('data', chunk => { stderr = (stderr + chunk).slice(-8192); });
    const timer = setTimeout(() => { child.kill(); reject(new Error(`${path.basename(executable)} exceeded ${timeout} ms`)); }, timeout);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout.replace(/^\uFEFF/, '').trim());
      else reject(new Error(`${path.basename(executable)} exited with ${code}: ${stderr.slice(-1500)}`));
    });
  });
}

async function windowsSnapshot() {
  const script = `
    $ErrorActionPreference = 'Stop'
    [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
    $desktop = [Environment]::GetFolderPath('DesktopDirectory')
    $programs = [Environment]::GetFolderPath('Programs')
    $appdata = [Environment]::GetFolderPath('ApplicationData')
    $localdata = [Environment]::GetFolderPath('LocalApplicationData')
    $links = @((Join-Path $desktop 'Allradione.lnk'), (Join-Path $programs 'Allradione.lnk'), (Join-Path ([Environment]::GetFolderPath('CommonDesktopDirectory')) 'Allradione.lnk'), (Join-Path ([Environment]::GetFolderPath('CommonPrograms')) 'Allradione.lnk'))
    $data = @((Join-Path $appdata 'Allradione'), (Join-Path $localdata 'Allradione'))
    $roots = @('HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*')
    $installs = @(Get-ItemProperty $roots -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -eq 'Allradione' } | ForEach-Object { @{ key=$_.PSPath; directory=$_.InstallLocation; version=$_.DisplayVersion; uninstall=$_.UninstallString } })
    $shell = New-Object -ComObject WScript.Shell
    $shortcutTargets = @($links | Where-Object { Test-Path -LiteralPath $_ } | ForEach-Object { @{ path=$_; target=$shell.CreateShortcut($_).TargetPath } })
    $processes = @(Get-CimInstance Win32_Process -Filter "Name = 'Allradione.exe'" | ForEach-Object { @{ pid=$_.ProcessId; path=$_.ExecutablePath } })
    @{ desktop=$desktop; programs=$programs; appdata=$appdata; localdata=$localdata; installations=$installs; existingShortcuts=@($links | Where-Object { Test-Path -LiteralPath $_ }); shortcutTargets=$shortcutTargets; existingData=@($data | Where-Object { Test-Path -LiteralPath $_ }); runningProcesses=$processes } | ConvertTo-Json -Depth 5 -Compress
  `;
  return JSON.parse(await runProcess('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { timeout: 30000 }));
}

async function withInstalledApp(executable, action) {
  const { _electron } = require('playwright');
  const environment = { ...process.env };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'ALLRADIONE_DEV_URL', 'PORTABLE_EXECUTABLE_FILE', 'PORTABLE_EXECUTABLE_DIR']) delete environment[key];
  const application = await _electron.launch({ executablePath: executable, args: [], cwd: ROOT, env: environment, timeout: 30000 });
  try {
    const page = await application.firstWindow();
    await page.locator('.desktop-shell').waitFor({ timeout: 30000 });
    return await action(application, page);
  } finally { await application.close(); }
}

async function main() {
  assert.equal(process.platform, 'win32', 'Installer smoke is supported only on Windows');
  assert.equal(process.env.CI, 'true', 'Installer smoke is restricted to a disposable CI machine');
  const packageJson = JSON.parse(await fs.readFile(path.join(ROOT, 'package.json'), 'utf8'));
  const installer = path.resolve(ROOT, process.env.ALLRADIONE_SMOKE_INSTALLER || `release/Allradione-Setup-${packageJson.version}-x64.exe`);
  assert.equal((await fs.stat(installer)).isFile(), true, 'Installer executable must exist');
  const initial = await windowsSnapshot();
  assertFreshSnapshot(initial);
  await fs.mkdir(OUTPUT, { recursive: true });
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'allradione-installer-smoke-'));
  const installDirectory = path.join(temporary, 'Allradione Custom Folder');
  const setupCopy = path.join(temporary, 'Allradione-Setup-smoke.exe');
  const portableData = path.join(temporary, 'Allradione-data');
  const unrelatedDirectory = path.join(temporary, 'unrelated-data');
  const executable = path.join(installDirectory, 'Allradione.exe');
  const userData = path.join(initial.appdata, 'Allradione');
  const desktopShortcut = path.join(initial.desktop, 'Allradione.lnk');
  const menuShortcut = path.join(initial.programs, 'Allradione.lnk');
  const results = [];
  let installed = false;
  let completed = false;
  let failure;
  const sentinel = { stationuuid: '00000000-0000-4000-8000-000000000099', name: 'Installer upgrade preservation fixture', url: 'https://example.com/no-audio', url_resolved: 'https://example.com/no-audio', homepage: '', favicon: '', countrycode: 'JP', language: '', tags: '', codec: 'MP3', bitrate: 128, hls: 0, lastcheckok: 1, votes: 0 };
  const legacyStation = { ...sentinel, stationuuid: '00000000-0000-4000-8000-000000000098', name: 'Portable migration fixture' };
  const legacyPreferences = JSON.stringify({ volume: 0.61, favorites: [legacyStation], widgetEnabled: false, widgetSize: 'small', lastCountry: 'JP', reducedMotion: false });

  const uninstall = async () => {
    const original = path.join(installDirectory, 'Uninstall Allradione.exe');
    assert.ok(await exists(original), 'Installed uninstaller must exist');
    const copy = path.join(temporary, 'uninstall-smoke.exe');
    await fs.copyFile(original, copy);
    // NSIS requires the final _?= path to remain unquoted, including when it has spaces.
    await runProcess(copy, nsisArguments(installDirectory, { uninstall: true }), { verbatim: true });
    await poll(async () => !(await exists(installDirectory)) && !(await exists(userData)), 'uninstaller removes application and its marked data');
    const after = await windowsSnapshot();
    assert.deepEqual(after.installations, [], 'Uninstall registry entries must be removed');
    assert.deepEqual(after.existingShortcuts, [], 'Desktop and Start menu shortcuts must be removed');
    assert.deepEqual(after.runningProcesses, [], 'No installed application process may remain');
    assert.equal(await fs.readFile(path.join(portableData, 'settings.json'), 'utf8'), legacyPreferences, 'Uninstall must preserve the original portable settings');
    if (await exists(unrelatedDirectory)) assert.equal(await fs.readFile(path.join(unrelatedDirectory, 'keep.txt'), 'utf8'), 'Never follow this junction during uninstall.', 'Uninstall must preserve files outside its owned directory');
    installed = false;
    results.push({ check: 'manual uninstall removes installed files, marked user data, shortcuts and uninstall registry', passed: true });
  };

  try {
    await fs.copyFile(installer, setupCopy);
    await fs.mkdir(portableData);
    await fs.writeFile(path.join(portableData, 'settings.json'), legacyPreferences);
    // Exercise a destination containing spaces and the supported desktop-shortcut opt-out.
    await runProcess(setupCopy, nsisArguments(installDirectory, { noDesktopShortcut: true }), { verbatim: true });
    installed = true;
    assert.ok(await exists(executable), 'The selected custom directory must contain the application');
    assert.equal(await exists(desktopShortcut), false, 'Desktop-shortcut opt-out must be respected');
    assert.ok(await exists(menuShortcut), 'Start menu shortcut must be created');
    const firstInstall = await windowsSnapshot();
    assert.equal(firstInstall.installations.length, 1, 'The installer must register exactly one uninstall entry');
    assert.ok(firstInstall.shortcutTargets.some(link => sameWindowsPath(link.path, menuShortcut) && sameWindowsPath(link.target, executable)), 'Start menu shortcut must target the installed executable');
    results.push({ check: 'silent per-user install, custom path with spaces and desktop-shortcut opt-out', passed: true });

    await withInstalledApp(executable, async (application, page) => {
      const actualData = await application.evaluate(({ app }) => app.getPath('userData'));
      assert.ok(sameWindowsPath(actualData, userData), 'Installed app must use its genuine per-user application data directory');
      assert.equal(await fs.readFile(path.join(actualData, MARKER), 'utf8'), APP_ID, 'App must create the exact ownership marker');
      const migrated = await page.evaluate(() => window.allradione.getPreferences());
      assert.equal(migrated.volume, 0.61, 'Fresh installation must migrate the adjacent portable preferences');
      assert.deepEqual(migrated.favorites.map(station => station.stationuuid), [legacyStation.stationuuid], 'Fresh installation must migrate portable favorites');
      await page.evaluate(station => window.allradione.savePreferences({ volume: 0.31, favorites: [station], widgetEnabled: false, widgetSize: 'medium', reducedMotion: true }), sentinel);
      const shortcut = await page.evaluate(() => window.allradione.createDesktopShortcut());
      assert.equal(shortcut.created, true, 'Explicit desktop shortcut creation must succeed');
    });
    results.push({ check: 'fresh installer migrates adjacent portable settings without changing the source', passed: true });
    const beforeUpgrade = await windowsSnapshot();
    assert.ok(beforeUpgrade.shortcutTargets.some(link => sameWindowsPath(link.path, desktopShortcut) && sameWindowsPath(link.target, executable)), 'Created desktop shortcut must target the actual installed app');

    // Reinstalling the same build executes NSIS's existing-install upgrade/uninstall path.
    // It verifies preservation through that path without claiming a cross-version update.
    await runProcess(setupCopy, nsisArguments(installDirectory), { verbatim: true });
    await withInstalledApp(executable, async (_application, page) => {
      const preferences = await page.evaluate(() => window.allradione.getPreferences());
      assert.equal(preferences.volume, 0.31, 'Upgrade must preserve volume');
      assert.equal(preferences.reducedMotion, true, 'Upgrade must preserve settings');
      assert.deepEqual(preferences.favorites.map(station => station.stationuuid), [sentinel.stationuuid], 'Upgrade must preserve favorites');
      assert.equal(await fs.readFile(path.join(userData, MARKER), 'utf8'), APP_ID, 'Upgrade must preserve the owned profile');
      await page.evaluate(() => window.allradione.savePreferences({ reducedMotion: false }));
    });
    results.push({ check: 'same-build reinstall exercises upgrade path and preserves settings/favorites', passed: true });

    await runProcess(process.execPath, [path.join(ROOT, 'scripts', 'smoke-electron.cjs')], { timeout: 480000, inherit: true, env: { ...process.env, ALLRADIONE_SMOKE_EXECUTABLE: executable, ALLRADIONE_SMOKE_INSTALLED: '1' } });
    results.push({ check: 'full native smoke against the installed executable and genuine installed profile', passed: true });
    await fs.mkdir(unrelatedDirectory);
    await fs.writeFile(path.join(unrelatedDirectory, 'keep.txt'), 'Never follow this junction during uninstall.');
    await fs.symlink(unrelatedDirectory, path.join(userData, 'smoke-external-junction'), 'junction');
    await uninstall();
    completed = true;
  } catch (error) {
    failure = error;
  } finally {
    if (installed) {
      // Cleanup only the application installed by this run. Do not manually delete user data
      // to conceal an uninstaller failure; the CI machine is disposable and the failure is retained.
      try { await uninstall(); } catch (cleanupError) { results.push({ check: 'cleanup', passed: false, error: cleanupError.message }); }
    }
    await fs.writeFile(path.join(OUTPUT, 'smoke-installer.json'), JSON.stringify({ passed: completed, version: packageJson.version, error: failure?.message, results }, null, 2));
    if (!(await exists(installDirectory))) await fs.rm(temporary, { recursive: true, force: true });
  }
  if (failure) throw failure;
  console.log(`Installer lifecycle smoke passed (${results.length} checks): installation, upgrade preservation, native UI and complete uninstall.`);
}

module.exports = { nsisArguments, sameWindowsPath, assertFreshSnapshot };
if (require.main === module) main().catch(error => { console.error('Installer lifecycle smoke failed:', error.message); process.exitCode = 1; });
