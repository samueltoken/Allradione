#!/usr/bin/env node
'use strict';
/** Windows CI only: install, retain preferences through an upgrade, test the installed app, uninstall. */
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { createReadStream, realpath } = require('node:fs');
const { promisify } = require('node:util');
const crypto = require('node:crypto');
const vm = require('node:vm');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const ROOT = path.resolve(__dirname, '..');
const OUTPUT = path.join(ROOT, 'artifacts');
const APP_ID = 'io.github.samueltoken.allradione';
const MARKER = 'allradione-owner.txt';
const BASELINE_VERSION = '0.2.0';
const BASELINE_URL = 'https://github.com/samueltoken/Allradione/releases/download/v0.2.0/Allradione-Setup-0.2.0-x64.exe';
const BASELINE_SHA256 = '953ad13fe8eacec88498c89df75fb2f7103923a71cc9dd62c1716dff058312ee';
const canonicalPath = promisify(realpath.native);

function sameWindowsPath(left, right) {
  return path.win32.normalize(left).replace(/[\\/]+$/, '').toLowerCase() === path.win32.normalize(right).replace(/[\\/]+$/, '').toLowerCase();
}

async function sameWindowsFile(left, right) {
  if (!left || !right) return false;
  try { return sameWindowsPath(await canonicalPath(left), await canonicalPath(right)); } catch { return false; }
}

async function assertShortcutTarget(snapshot, shortcut, executable, label) {
  for (const link of snapshot.shortcutTargets) {
    if (await sameWindowsFile(link.path, shortcut) && await sameWindowsFile(link.target, executable)) return;
  }
  const diagnostics = { expected: executable, canonicalExpected: await canonicalPath(executable), shortcuts: await Promise.all(snapshot.shortcutTargets.map(async link => ({ ...link, canonicalTarget: await canonicalPath(link.target).catch(() => null) }))) };
  assert.fail(`${label}: ${JSON.stringify(diagnostics)}`);
}

async function ownedProcesses(snapshot, executable) {
  const owned = [];
  for (const process of snapshot.runningProcesses) if (await sameWindowsFile(process.path, executable)) owned.push(process);
  return owned;
}

function nsisArguments(directory, { uninstall = false, noDesktopShortcut = false } = {}) {
  assert.ok(path.win32.isAbsolute(directory), 'NSIS destination must be an absolute Windows path');
  assert.ok(!/["\r\n]/.test(directory), 'NSIS destination cannot contain quotes or line breaks');
  assert.equal(sameWindowsPath(directory, path.win32.parse(directory).root), false, 'Never install into a drive or share root');
  return ['/S', '/currentuser', ...(noDesktopShortcut ? ['--no-desktop-shortcut'] : []), `${uninstall ? '_?=' : '/D='}${directory}`];
}

function assertFreshSnapshot(snapshot) {
  assert.deepEqual(snapshot.installations, [], 'Refusing to alter a pre-existing Allradione installation');
  assert.deepEqual(snapshot.existingShortcuts, [], 'Refusing to alter pre-existing Allradione shortcuts');
  assert.deepEqual(snapshot.existingData, [], 'Refusing to alter pre-existing Allradione user data');
  assert.deepEqual(snapshot.runningProcesses, [], 'Refusing to alter a running Allradione instance');
  assert.deepEqual(snapshot.existingLaunchers || [], [], 'Refusing to alter a pre-existing Desktop Allradione.exe');
}

async function exists(file) { try { await fs.access(file); return true; } catch { return false; } }
async function poll(check, label, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 250)); }
  throw new Error(`Timed out: ${label}`);
}

function runProcess(executable, args, { timeout = 180000, env = process.env, verbatim = false, inherit = false, waitForExit = false, captureOutput = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd: ROOT, env, windowsHide: true, windowsVerbatimArguments: verbatim, stdio: inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout?.on('data', chunk => { stdout = (stdout + chunk).slice(-262144); });
    child.stderr?.on('data', chunk => { stderr = (stderr + chunk).slice(-8192); });
    const details = code => ({ exitCode: code, stdout: stdout.replace(/^\uFEFF/, '').trim(), stderr: stderr.replace(/^\uFEFF/, '').trim() });
    const timer = setTimeout(() => { child.kill(); reject(Object.assign(new Error(`${path.basename(executable)} exceeded ${timeout} ms`), details(null))); }, timeout);
    child.once('error', error => { clearTimeout(timer); reject(Object.assign(error, details(null))); });
    child.once(waitForExit ? 'exit' : 'close', code => {
      clearTimeout(timer);
      if (code === 0) resolve(captureOutput ? details(code) : details(code).stdout);
      else reject(Object.assign(new Error(`${path.basename(executable)} exited with ${code}: ${stderr.slice(-1500)}`), details(code)));
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
    $processes = @(Get-CimInstance Win32_Process -Filter "Name = 'Allradione.exe'" | ForEach-Object { $p=Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue; @{ pid=$_.ProcessId; path=$_.ExecutablePath; windowHandle=if($p){$p.MainWindowHandle.ToInt64()}else{0} } })
    $launchers = @((Join-Path $desktop 'Allradione.exe'), (Join-Path ([Environment]::GetFolderPath('CommonDesktopDirectory')) 'Allradione.exe'))
    @{ desktop=$desktop; programs=$programs; appdata=$appdata; localdata=$localdata; installations=$installs; existingShortcuts=@($links | Where-Object { Test-Path -LiteralPath $_ }); shortcutTargets=$shortcutTargets; existingLaunchers=@($launchers | Where-Object { Test-Path -LiteralPath $_ }); existingData=@($data | Where-Object { Test-Path -LiteralPath $_ }); runningProcesses=$processes } | ConvertTo-Json -Depth 5 -Compress
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

async function stopOwnedRestart(executable) {
  const owned = await ownedProcesses(await windowsSnapshot(), executable);
  if (!owned.length) return;
  const script = `
    $ErrorActionPreference = 'Stop'
    $owned = ConvertFrom-Json -InputObject $env:ALLRADIONE_SMOKE_OWN_PROCESSES
    foreach($entry in $owned) {
      $current = Get-CimInstance Win32_Process -Filter ('ProcessId = ' + [int]$entry.pid) -ErrorAction SilentlyContinue
      if($current -and $current.ExecutablePath -eq $entry.path) {
        $p = Get-Process -Id $entry.pid -ErrorAction SilentlyContinue
        if($p -and $p.MainWindowHandle -ne 0) { $null = $p.CloseMainWindow() }
      }
    }
  `;
  await runProcess('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { timeout: 30000, env: { ...process.env, ALLRADIONE_SMOKE_OWN_PROCESSES: JSON.stringify(owned.map(({ pid, path }) => ({ pid, path }))) } });
  await poll(async () => (await ownedProcesses(await windowsSnapshot(), executable)).length === 0, 'restarted installed app closes before Playwright relaunch', 30000);
}

async function readReleasedUpdater(installDirectory) {
  const source = require('@electron/asar').extractFile(path.join(installDirectory, 'resources', 'app.asar'), 'electron/updater.cjs').toString('utf8');
  const allowed = new Set(['node:fs/promises', 'node:path', 'node:crypto', 'node:child_process']);
  const module = { exports: {} };
  const context = vm.createContext({ module, exports: module.exports, require: name => { assert.ok(allowed.has(name), `Unexpected released updater dependency: ${name}`); return require(name); } });
  new vm.Script(source, { filename: `released-v${BASELINE_VERSION}-updater.cjs` }).runInContext(context, { timeout: 1000 });
  assert.equal(typeof module.exports.makeUpdateScript, 'function', 'Released updater must export its real handoff generator');
  await fs.writeFile(path.join(OUTPUT, `released-v${BASELINE_VERSION}-updater.cjs`), source);
  return {
    source: `released v${BASELINE_VERSION} resources/app.asar`,
    sha256: crypto.createHash('sha256').update(source).digest('hex'),
    makeUpdateScript(parameters) {
      context.parameters = parameters;
      try { return vm.runInContext('module.exports.makeUpdateScript(parameters)', context, { timeout: 1000 }); }
      finally { delete context.parameters; }
    },
  };
}

async function exerciseUpdateHandoff({ installer, executable, userData, fromVersion, toVersion, releasedUpdater }) {
  const { makeUpdateScript } = releasedUpdater || require('../electron/updater.cjs');
  const artifact = name => path.join(OUTPUT, `update-${fromVersion}-to-${toVersion}-${name}`);
  const updateRoot = path.join(userData, 'updates');
  await fs.mkdir(updateRoot, { recursive: true });
  const stage = await fs.mkdtemp(path.join(updateRoot, 'release-smoke-'));
  const stagedInstaller = path.join(stage, path.basename(installer));
  const scriptPath = path.join(stage, 'apply-update.ps1');
  await fs.copyFile(installer, stagedInstaller);
  const hash = crypto.createHash('sha256');
  for await (const chunk of createReadStream(stagedInstaller)) hash.update(chunk);
  const digest = hash.digest('hex');

  // A controlled short-lived process stands in for the old app's PID. Its exit is
  // released only after checking that the unchanged production handoff is waiting.
  const oldProcess = spawn(process.execPath, ['-e', "process.stdin.once('data',()=>process.exit(0));setTimeout(()=>process.exit(0),60000)"], { windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'] });
  await new Promise((resolve, reject) => { oldProcess.once('spawn', resolve); oldProcess.once('error', reject); });
  if (!releasedUpdater) await require('../electron/update-staging.cjs').createStageMarker(stage, { pid: oldProcess.pid, installerName: path.basename(stagedInstaller) });
  const script = makeUpdateScript({ parentPid: oldProcess.pid, installer: stagedInstaller, appExe: executable, scriptPath, expectedHash: digest });
  assert.match(script, /-ArgumentList @\('\/S', '--updated', '--force-run'\)/, 'Execute the production silent-update and restart flags');
  await fs.writeFile(scriptPath, '\ufeff' + script, 'utf8');
  await fs.writeFile(artifact('generated.ps1'), '\ufeff' + script, 'utf8');
  const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  let finished = false;
  const handoff = runProcess(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { timeout: 180000, waitForExit: true, captureOutput: true })
    .then(output => ({ ok: true, output }), error => ({ ok: false, error, output: { exitCode: error.exitCode ?? null, stdout: error.stdout || '', stderr: error.stderr || '' } }))
    .then(async result => {
      await fs.writeFile(artifact('process.json'), JSON.stringify({ ok: result.ok, ...result.output, error: result.error?.message }, null, 2));
      return result;
    }).finally(() => { finished = true; });
  const checkHandoffFailure = async () => {
    const errorLog = path.join(stage, 'update-error.txt');
    if (await exists(errorLog)) {
      const message = (await fs.readFile(errorLog, 'utf8')).replace(/^\uFEFF/, '').slice(0, 16000);
      await fs.writeFile(artifact('error.txt'), message);
      throw new Error(`Generated update handoff failed: ${message}`);
    }
    if (finished) { const result = await handoff; if (!result.ok) throw result.error; }
  };
  let restartObserved = false;
  try {
    await new Promise(resolve => setTimeout(resolve, 2500));
    await checkHandoffFailure();
    assert.equal(oldProcess.exitCode, null, 'Controlled old process must still be alive');
    if (finished) {
      const result = await handoff;
      throw new Error(`Update handoff exited before the old process stopped: ${JSON.stringify(result.output)}`);
    }
    assert.ok(await exists(stagedInstaller), 'Waiting handoff must retain its staged installer');
    assert.equal((await ownedProcesses(await windowsSnapshot(), executable)).length, 0, 'The app must not restart before the old process exits');
    oldProcess.stdin.end('exit');
    await poll(() => oldProcess.exitCode !== null, 'controlled old process exits', 5000);

    await poll(async () => {
      await checkHandoffFailure();
      const snapshot = await windowsSnapshot();
      restartObserved ||= (await ownedProcesses(snapshot, executable)).some(process => process.windowHandle !== 0);
      return restartObserved && !(await exists(stage));
    }, 'production updater restarts installed app and removes its staging directory', 180000);
    const result = await handoff;
    if (!result.ok) throw result.error;
    assert.equal(await exists(stagedInstaller), false, 'Successful updater must delete its staged installer');
    assert.equal(await exists(scriptPath), false, 'Successful updater must delete its generated script');
    await stopOwnedRestart(executable);
    return { check: 'production PowerShell update handoff waits, upgrades, restarts and clears staging', passed: true, fromVersion, toVersion, helperSource: releasedUpdater?.source || 'current source build', helperSourceSha256: releasedUpdater?.sha256, flags: ['/S', '--updated', '--force-run'], parentWaitObserved: true, restartObserved, crossVersionUpdateTested: fromVersion !== toVersion };
  } catch (error) {
    let actualHash = null;
    if (await exists(stagedInstaller)) {
      const actual = crypto.createHash('sha256');
      for await (const chunk of createReadStream(stagedInstaller)) actual.update(chunk);
      actualHash = actual.digest('hex');
    }
    await fs.writeFile(artifact('context.json'), JSON.stringify({ parentPid: oldProcess.pid, parentExitCode: oldProcess.exitCode, handoffFinished: finished, stageFiles: await fs.readdir(stage).catch(() => []), expectedHash: digest, actualHash, error: error.message }, null, 2));
    throw error;
  } finally {
    if (oldProcess.exitCode === null && !oldProcess.stdin.writableEnded) oldProcess.stdin.end('exit');
    await handoff;
    // A failed handoff may also restart the original app. Close only this test's exact executable.
    await stopOwnedRestart(executable).catch(() => {});
  }
}

async function downloadBaselineInstaller(destination) {
  console.log(`Downloading SHA256-pinned released installer v${BASELINE_VERSION} for upgrade verification.`);
  const response = await fetch(BASELINE_URL, { signal: AbortSignal.timeout(180000) });
  assert.ok(response.ok && response.body, `Baseline installer download failed: HTTP ${response.status}`);
  const hash = crypto.createHash('sha256');
  const file = await fs.open(destination, 'wx');
  let bytes = 0;
  try {
    for await (const chunk of response.body) {
      bytes += chunk.length;
      assert.ok(bytes <= 768 * 1024 * 1024, 'Baseline installer exceeds the size limit');
      hash.update(chunk);
      await file.writeFile(chunk);
    }
  } finally { await file.close(); }
  assert.equal(hash.digest('hex'), BASELINE_SHA256, 'Released baseline installer must match its pinned SHA256 before execution');
  assert.ok(bytes > 1024, 'Baseline installer download must contain a real executable');
}

async function desktopFailureDiagnostics({ desktopExe, desktopShortcut, executable, phase }) {
  const prefix = `desktop-${phase}`;
  const manager = path.join(path.dirname(executable), 'resources', 'desktop-launcher.exe');
  const statusFile = path.join(path.dirname(executable), 'desktop-launcher-status.txt');
  const collect = async label => {
    const snapshot = await windowsSnapshot();
    const backups = (await fs.readdir(path.dirname(desktopExe))).filter(name => /^\.Allradione-desktop-.*\.bak$/i.test(name));
    const metadata = [];
    for (const file of [desktopShortcut, desktopExe, manager, statusFile, ...backups.map(name => path.join(path.dirname(desktopExe), name))]) {
      try {
        const stat = await fs.lstat(file);
        metadata.push({ path: file, canonical: await canonicalPath(file).catch(() => null), size: stat.size, mode: stat.mode, modified: stat.mtime.toISOString(), symlink: stat.isSymbolicLink() });
        if (stat.isFile() && stat.size <= 8 * 1024 * 1024 && (file === desktopShortcut || file === statusFile || backups.includes(path.basename(file)))) {
          await fs.copyFile(file, path.join(OUTPUT, `${prefix}-${label}-${path.basename(file)}`));
        }
      } catch (error) { metadata.push({ path: file, error: error.code || error.message }); }
    }
    const shortcuts = await Promise.all(snapshot.shortcutTargets.map(async link => ({ ...link, canonicalTarget: await canonicalPath(link.target).catch(() => null) })));
    return { metadata, shortcuts, nativeLaunchers: snapshot.existingLaunchers, managerStatus: await fs.readFile(statusFile, 'utf8').catch(() => null) };
  };
  const diagnostic = { phase, before: await collect('before') };
  // Failure-only diagnosis: never turn this retry into a passing migration assertion.
  try { diagnostic.retry = await runProcess(manager, ['--install-desktop', '--quiet'], { timeout: 15000, captureOutput: true }); }
  catch (error) { diagnostic.retry = { exitCode: error.exitCode, stdout: error.stdout, stderr: error.stderr, error: error.message }; }
  diagnostic.after = await collect('after');
  await fs.writeFile(path.join(OUTPUT, `${prefix}-failure.json`), JSON.stringify(diagnostic, null, 2));
}

async function assertNativeDesktopLaunch({ desktopExe, desktopShortcut, executable, phase = 'unknown' }) {
  const legacyPresent = await exists(desktopShortcut);
  if (legacyPresent) await desktopFailureDiagnostics({ desktopExe, desktopShortcut, executable, phase }).catch(async error => { await fs.writeFile(path.join(OUTPUT, `desktop-${phase}-diagnostic-error.txt`), error.stack || error.message); });
  assert.equal(legacyPresent, false, `An owned legacy Desktop .lnk must be removed (${phase}; failure-only diagnostics retained)`);
  const file = await fs.open(desktopExe, 'r');
  const magic = Buffer.alloc(2);
  try { await file.read(magic, 0, 2, 0); } finally { await file.close(); }
  assert.equal(magic.toString('ascii'), 'MZ', 'Desktop icon must be an actual native executable, not a renamed shortcut');
  await runProcess(desktopExe, [], { timeout: 30000 });
  await poll(async () => (await ownedProcesses(await windowsSnapshot(), executable)).some(process => process.windowHandle !== 0), 'native Desktop launcher opens the actual installed application');
  await stopOwnedRestart(executable);
}

async function assertOwnedLinkLockRetry({ desktopExe, desktopShortcut, executable, temporary }) {
  const ready = path.join(temporary, 'owned-link-lock-ready');
  const release = path.join(temporary, 'owned-link-lock-release');
  const environment = { ...process.env, ALLRADIONE_QA_LINK: desktopShortcut, ALLRADIONE_QA_TARGET: await canonicalPath(executable), ALLRADIONE_QA_READY: ready, ALLRADIONE_QA_RELEASE: release };
  const script = `
    $ErrorActionPreference = 'Stop'
    $shell = New-Object -ComObject WScript.Shell
    $link = $shell.CreateShortcut($env:ALLRADIONE_QA_LINK)
    $link.TargetPath = $env:ALLRADIONE_QA_TARGET
    $link.Save()
    $lock = [System.IO.File]::Open($env:ALLRADIONE_QA_LINK, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::Read)
    try {
      [System.IO.File]::WriteAllText($env:ALLRADIONE_QA_READY, 'ready')
      $deadline = [DateTime]::UtcNow.AddSeconds(15)
      while(-not [System.IO.File]::Exists($env:ALLRADIONE_QA_RELEASE)) {
        if([DateTime]::UtcNow -gt $deadline) { throw 'Controlled link lock timed out' }
        [System.Threading.Thread]::Sleep(25)
      }
    } finally { $lock.Dispose() }
  `;
  const holder = runProcess('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { timeout: 20000, env: environment, captureOutput: true }).then(output => ({ output }), error => ({ error }));
  let manager;
  try {
    await poll(() => exists(ready), 'controlled owned shortcut lock becomes ready', 10000);
    let settled = false;
    manager = runProcess(path.join(path.dirname(executable), 'resources', 'desktop-launcher.exe'), ['--install-desktop', '--quiet'], { timeout: 15000, captureOutput: true }).then(output => ({ output }), error => ({ error })).finally(() => { settled = true; });
    await new Promise(resolve => setTimeout(resolve, 1000));
    const finishedDuringLock = settled;
    await fs.writeFile(release, 'release');
    const holderResult = await holder;
    if (holderResult.error) throw holderResult.error;
    const managerResult = await manager;
    if (managerResult.error) throw managerResult.error;
    assert.equal(finishedDuringLock, false, 'Native manager must retry while the owned link is locked');
    assert.equal(await exists(desktopShortcut), false, 'Native retry must remove the owned link after the lock is released');
    assert.equal((await fs.readFile(desktopExe)).subarray(0, 2).toString('ascii'), 'MZ', 'Native Desktop launcher must survive the retry');
    return { check: 'native manager waits through a controlled one-second owned shortcut lock and completes migration', passed: true, exitCode: managerResult.output.exitCode };
  } catch (error) {
    const managerStatus = await fs.readFile(path.join(path.dirname(executable), 'desktop-launcher-status.txt'), 'utf8').catch(() => null);
    await fs.writeFile(path.join(OUTPUT, 'desktop-controlled-lock-failure.json'), JSON.stringify({ error: error.message, exitCode: error.exitCode, stdout: error.stdout, stderr: error.stderr, managerStatus, legacyLinkPresent: await exists(desktopShortcut), desktopExePresent: await exists(desktopExe) }, null, 2));
    throw error;
  } finally {
    await fs.writeFile(release, 'release').catch(() => {});
    await holder;
    if (manager) await manager;
  }
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
  const setupCopy = path.join(temporary, `Allradione-Setup-${packageJson.version}-x64.exe`);
  const baselineInstaller = path.join(temporary, `Allradione-Setup-${BASELINE_VERSION}-x64.exe`);
  const portableData = path.join(temporary, 'Allradione-data');
  const unrelatedDirectory = path.join(temporary, 'unrelated-data');
  const executable = path.join(installDirectory, 'Allradione.exe');
  const userData = path.join(initial.appdata, 'Allradione');
  const desktopShortcut = path.join(initial.desktop, 'Allradione.lnk');
  const desktopExe = path.join(initial.desktop, 'Allradione.exe');
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
    assert.deepEqual(after.existingLaunchers, [], 'Owned native Desktop launcher must be removed');
    assert.deepEqual(after.runningProcesses, [], 'No installed application process may remain');
    assert.equal(await fs.readFile(path.join(portableData, 'settings.json'), 'utf8'), legacyPreferences, 'Uninstall must preserve the original portable settings');
    if (await exists(unrelatedDirectory)) assert.equal(await fs.readFile(path.join(unrelatedDirectory, 'keep.txt'), 'utf8'), 'Never follow this junction during uninstall.', 'Uninstall must preserve files outside its owned directory');
    installed = false;
    results.push({ check: 'manual uninstall removes installed files, marked user data, shortcuts and uninstall registry', passed: true });
  };

  try {
    await fs.copyFile(installer, setupCopy);
    await downloadBaselineInstaller(baselineInstaller);
    await fs.mkdir(portableData);
    await fs.writeFile(path.join(portableData, 'settings.json'), legacyPreferences);
    // First verify a clean installation of the new build, independently of upgrade migration.
    await runProcess(setupCopy, nsisArguments(installDirectory), { verbatim: true });
    installed = true;
    assert.ok(await exists(executable), 'The selected custom directory must contain the application');
    assert.ok(await exists(menuShortcut), 'Start menu shortcut must be created');
    const firstInstall = await windowsSnapshot();
    assert.equal(firstInstall.installations.length, 1, 'The installer must register exactly one uninstall entry');
    await assertShortcutTarget(firstInstall, menuShortcut, executable, 'Start menu shortcut must target the installed executable');
    await assertNativeDesktopLaunch({ desktopExe, desktopShortcut, executable, phase: 'fresh' });
    results.push({ check: 'fresh latest install, custom path with spaces and real native Desktop launch', version: packageJson.version, passed: true });
    results.push(await assertOwnedLinkLockRetry({ desktopExe, desktopShortcut, executable, temporary }));

    await withInstalledApp(executable, async (application, page) => {
      const actualData = await application.evaluate(({ app }) => app.getPath('userData'));
      assert.ok(await sameWindowsFile(actualData, userData), `Installed app must use its genuine data directory: actual=${actualData}, expected=${userData}`);
      assert.equal(await fs.readFile(path.join(actualData, MARKER), 'utf8'), APP_ID, 'App must create the exact ownership marker');
      assert.equal(await page.evaluate(() => window.allradione.version()), packageJson.version, 'Fresh installed app must report the new version');
      const migrated = await page.evaluate(() => window.allradione.getPreferences());
      assert.equal(migrated.volume, 0.61, 'Fresh installation must migrate the adjacent portable preferences');
      assert.deepEqual(migrated.favorites.map(station => station.stationuuid), [legacyStation.stationuuid], 'Fresh installation must migrate portable favorites');
    });
    results.push({ check: 'fresh installer migrates adjacent portable settings without changing the source', passed: true });
    results.push(await exerciseUpdateHandoff({ installer: setupCopy, executable, userData, fromVersion: packageJson.version, toVersion: packageJson.version }));

    const savedLauncher = path.join(temporary, 'owned-desktop-launcher.exe');
    const unrelatedExe = Buffer.from('MZ unrelated QA fixture; never execute this file.');
    await fs.rename(desktopExe, savedLauncher);
    try {
      await fs.writeFile(desktopExe, unrelatedExe);
      await withInstalledApp(executable, async (_application, page) => {
        const result = await page.evaluate(() => window.allradione.createDesktopShortcut());
        assert.equal(result.created, false, 'Settings must refuse an unrelated same-name Desktop executable');
      });
      assert.deepEqual(await fs.readFile(desktopExe), unrelatedExe, 'An unrelated same-name Desktop file must remain byte-for-byte unchanged');
    } finally {
      await fs.rm(desktopExe, { force: true });
      await fs.rename(savedLauncher, desktopExe);
    }
    results.push({ check: 'unrelated same-name Desktop executable is refused without modification', passed: true });
    await uninstall();
    assertFreshSnapshot(await windowsSnapshot());

    // Install the real released previous version, not a modified current-build fixture.
    await runProcess(baselineInstaller, nsisArguments(installDirectory), { verbatim: true });
    installed = true;
    assert.ok(await exists(desktopShortcut), 'Released v0.2.0 must provide the legacy owned Desktop shortcut');
    const baselinePid = await withInstalledApp(executable, async (application, page) => {
      assert.equal(await page.evaluate(() => window.allradione.version()), BASELINE_VERSION, 'Upgrade baseline must be actual released v0.2.0');
      await page.evaluate(station => window.allradione.savePreferences({ volume: 0.31, favorites: [station], widgetEnabled: false, widgetSize: 'medium', reducedMotion: true }), sentinel);
      return application.process().pid;
    });
    const beforeUpgrade = await windowsSnapshot();
    await assertShortcutTarget(beforeUpgrade, desktopShortcut, executable, 'Created desktop shortcut must target the actual installed app');
    const releasedUpdater = await readReleasedUpdater(installDirectory);
    const obsolete = path.join(installDirectory, 'resources', 'obsolete-owned-qa-file.bin');
    await fs.writeFile(obsolete, 'Obsolete fixture only inside this test-owned installation.');
    await fs.writeFile(path.join(userData, 'code-cache-version.json'), JSON.stringify({ schemaVersion: 1, appId: APP_ID, version: BASELINE_VERSION }));
    const oldStage = path.join(userData, 'updates', 'release-stale-qa1234');
    const unownedStage = path.join(userData, 'updates', 'release-unowned-qa1234');
    await fs.mkdir(oldStage, { recursive: true });
    await fs.mkdir(unownedStage, { recursive: true });
    await require('../electron/update-staging.cjs').createStageMarker(oldStage, { pid: baselinePid, installerName: path.basename(baselineInstaller), now: Date.now() - 2 * 86400000 });
    await fs.writeFile(path.join(oldStage, path.basename(baselineInstaller)), 'Owned stale update fixture, never execute.');
    await fs.writeFile(path.join(unownedStage, 'keep.txt'), 'Unmarked data must be preserved.');
    await fs.mkdir(unrelatedDirectory);
    await fs.writeFile(path.join(unrelatedDirectory, 'keep.txt'), 'Never follow this junction during uninstall.');
    results.push(await exerciseUpdateHandoff({ installer: setupCopy, executable, userData, fromVersion: BASELINE_VERSION, toVersion: packageJson.version, releasedUpdater }));
    assert.equal(await exists(obsolete), false, 'Upgrade must remove obsolete files from the installer-owned application directory');
    assert.equal(await fs.readFile(path.join(unrelatedDirectory, 'keep.txt'), 'utf8'), 'Never follow this junction during uninstall.', 'Upgrade must preserve unrelated outside files');
    await assertNativeDesktopLaunch({ desktopExe, desktopShortcut, executable, phase: 'after-v020-upgrade' });
    await withInstalledApp(executable, async (_application, page) => {
      assert.equal(await page.evaluate(() => window.allradione.version()), packageJson.version, 'Upgraded app must report the new version');
      const preferences = await page.evaluate(() => window.allradione.getPreferences());
      assert.equal(preferences.volume, 0.31, 'Upgrade must preserve volume');
      assert.equal(preferences.reducedMotion, true, 'Upgrade must preserve settings');
      assert.deepEqual(preferences.favorites.map(station => station.stationuuid), [sentinel.stationuuid], 'Upgrade must preserve favorites');
      assert.equal(await fs.readFile(path.join(userData, MARKER), 'utf8'), APP_ID, 'Upgrade must preserve the owned profile');
      assert.equal(JSON.parse(await fs.readFile(path.join(userData, 'code-cache-version.json'), 'utf8')).version, packageJson.version, 'New version must complete its code-cache transition');
      assert.equal(await exists(oldStage), false, 'Startup must clean expired, positively owned update staging');
      assert.equal(await fs.readFile(path.join(unownedStage, 'keep.txt'), 'utf8'), 'Unmarked data must be preserved.', 'Startup must preserve unmarked legacy update data');
      await page.evaluate(() => window.allradione.savePreferences({ reducedMotion: false }));
    });
    results.push({ check: 'real released v0.2.0 upgrades to latest, preserves settings, replaces legacy shortcut and removes obsolete owned files', fromVersion: BASELINE_VERSION, toVersion: packageJson.version, passed: true });

    await runProcess(process.execPath, [path.join(ROOT, 'scripts', 'smoke-electron.cjs')], { timeout: 480000, inherit: true, env: { ...process.env, ALLRADIONE_SMOKE_EXECUTABLE: executable, ALLRADIONE_SMOKE_INSTALLED: '1' } });
    results.push({ check: 'full native smoke against the installed executable and genuine installed profile', passed: true });
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

module.exports = { nsisArguments, sameWindowsPath, assertFreshSnapshot, runProcess };
if (require.main === module) main().catch(error => { console.error('Installer lifecycle smoke failed:', error.message); process.exitCode = 1; });
