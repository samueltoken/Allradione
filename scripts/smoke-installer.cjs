#!/usr/bin/env node
'use strict';
/** Windows CI only: install, retain preferences through an upgrade, test the installed app, uninstall. */
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { createReadStream, realpath } = require('node:fs');
const { promisify } = require('node:util');
const crypto = require('node:crypto');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { readLatestTrace } = require('./trace-snapshots.cjs');
const ROOT = path.resolve(__dirname, '..');
const OUTPUT = path.join(ROOT, 'artifacts');
const APP_ID = 'io.github.samueltoken.allradione';
const MARKER = 'allradione-owner.txt';
const BASELINE_VERSION = '0.2.4';
const BASELINE_URL = `https://github.com/samueltoken/Allradione/releases/download/v${BASELINE_VERSION}/Allradione-Setup-${BASELINE_VERSION}-x64.exe`;
const BASELINE_SHA256 = '9ae1cccc7b8e372d9643ba2ce1319b9dcbd5bc0a065e66177b2a3fc5de51d63f';
const canonicalPath = promisify(realpath.native);

function sameWindowsPath(left, right) {
  return path.win32.normalize(left).replace(/[\\/]+$/, '').toLowerCase() === path.win32.normalize(right).replace(/[\\/]+$/, '').toLowerCase();
}

function registeredInstallDirectory(installation) {
  if (typeof installation.directory === 'string' && installation.directory) return installation.directory;
  // electron-builder's NSIS uninstall entry need not expose InstallLocation.
  const match = /^(?:"([^"]+)"|(\S+))/.exec(installation.uninstall || '');
  return match ? path.win32.dirname(match[1] || match[2]) : null;
}

function processAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
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

function extractInstalledFile(installDirectory, file) {
  const archive = path.join(installDirectory, 'resources', 'app.asar');
  const asar = require('@electron/asar');
  // This lifecycle test replaces the archive repeatedly at the same path.
  // ASAR caches its header/offset table by path, so refresh before each read.
  asar.uncache(archive);
  return asar.extractFile(archive, file);
}

async function readReleasedUpdater(installDirectory) {
  const source = extractInstalledFile(installDirectory, 'electron/updater.cjs');
  await fs.writeFile(path.join(OUTPUT, `released-v${BASELINE_VERSION}-updater.cjs`), source);
  // Fingerprint the packaged source here; the Settings test loads and executes
  // it inside the real installed Electron app with its packaged dependencies.
  return {
    source: `released v${BASELINE_VERSION} resources/app.asar`,
    sha256: crypto.createHash('sha256').update(source).digest('hex'),
  };
}

async function operateSetupWindow(pid, cancel = false) {
  assert.ok(Number.isSafeInteger(pid) && pid > 0);
  const script = `
    $ErrorActionPreference = 'Stop'
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class SetupControls {
  [DllImport("user32")] public static extern IntPtr GetDlgItem(IntPtr hwnd, int id);
  [DllImport("user32")] public static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32")] public static extern bool IsWindowEnabled(IntPtr hwnd);
  [DllImport("user32")] public static extern IntPtr GetLastActivePopup(IntPtr hwnd);
  [DllImport("user32")] public static extern bool PostMessage(IntPtr hwnd, uint msg, IntPtr wParam, IntPtr lParam);
}
'@
    $setup = Get-Process -Id ${pid}
    [void]$setup.Handle # Keep the handle available to read the final exit code.
    $visible = $false
    $clicked = 0
    $deadline = [DateTime]::UtcNow.AddMinutes(2)
    while (-not $setup.HasExited -and [DateTime]::UtcNow -lt $deadline) {
      $setup.Refresh()
      $window = $setup.MainWindowHandle
      if ($window -ne [IntPtr]::Zero -and [SetupControls]::IsWindowVisible($window)) {
        $visible = $true
        $active = [SetupControls]::GetLastActivePopup($window)
        if ($active -eq [IntPtr]::Zero) { $active = $window }
        $id = ${cancel ? 2 : 1}
        if (${cancel ? '$true' : '$false'}) {
          $yes = [SetupControls]::GetDlgItem($active, 6)
          if ($yes -ne [IntPtr]::Zero) { $id = 6 }
        }
        $button = [SetupControls]::GetDlgItem($active, $id)
        if ($button -ne [IntPtr]::Zero -and [SetupControls]::IsWindowVisible($button) -and [SetupControls]::IsWindowEnabled($button)) {
          [void][SetupControls]::PostMessage($button, 0x00F5, [IntPtr]::Zero, [IntPtr]::Zero)
          $clicked++
        }
      }
      Start-Sleep -Milliseconds 500
    }
    if (-not $setup.HasExited -or -not $visible -or $clicked -eq 0) { throw 'Visible Allradione installer did not finish' }
    @{ visible = $visible; clicks = $clicked; exitCode = $setup.ExitCode } | ConvertTo-Json -Compress
  `;
  return JSON.parse(await runProcess('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { timeout: 150000 }));
}

async function startRadioFixture(application, page) {
  // Exercise the real favorites control, RadioPlayer and decoder. Only the
  // broadcast source is replaced with a deterministic three-minute PCM tone.
  const url = await page.evaluate(() => {
    const rate = 8000, count = rate * 180;
    const bytes = new ArrayBuffer(44 + count * 2);
    const view = new DataView(bytes);
    const tag = (offset, text) => [...text].forEach((char, index) => view.setUint8(offset + index, char.charCodeAt(0)));
    tag(0, 'RIFF'); view.setUint32(4, bytes.byteLength - 8, true); tag(8, 'WAVEfmt ');
    view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
    view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true);
    view.setUint16(34, 16, true); tag(36, 'data'); view.setUint32(40, count * 2, true);
    for (let i = 0; i < count; i++) view.setInt16(44 + i * 2, Math.round(2000 * Math.sin(i * 440 * 2 * Math.PI / rate)), true);
    const originalPlay = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () {
      window.__setupTestRadio = this;
      return originalPlay.call(this);
    };
    return URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' }));
  });
  await application.evaluate(({ ipcMain }, blobUrl) => {
    ipcMain.removeHandler('radio:stream');
    ipcMain.handle('radio:stream', () => blobUrl);
    ipcMain.removeHandler('radio:click');
    ipcMain.handle('radio:click', () => null);
  }, url);
  await page.locator('[data-action="favorites"]').click();
  await page.locator('.station-select').first().click();
  await page.waitForFunction(() => window.__setupTestRadio?.currentTime > 0.1);
}

async function exerciseInstalledAppUpdate({ installer, executable, userData, fromVersion, toVersion, releasedUpdater, reportedCurrentVersion = null, legacyDiagnostic = false }) {
  const { _electron } = require('playwright');
  const prefix = `installed-update-${releasedUpdater ? 'baseline' : 'current'}-${fromVersion}-to-${toVersion}`;
  const traceFile = path.join(OUTPUT, `${prefix}-trace.json`);
  const traceDirectory = await fs.mkdtemp(path.join(OUTPUT, `${prefix}-snapshots-`));
  const traceHelperPath = path.join(__dirname, 'trace-snapshots.cjs');
  const helperStdout = path.join(OUTPUT, `${prefix}-helper-stdout.txt`);
  const helperStderr = path.join(OUTPUT, `${prefix}-helper-stderr.txt`);
  const environment = { ...process.env };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'ALLRADIONE_DEV_URL', 'PORTABLE_EXECUTABLE_FILE', 'PORTABLE_EXECUTABLE_DIR']) delete environment[key];
  const hash = crypto.createHash('sha256');
  for await (const chunk of createReadStream(installer)) hash.update(chunk);
  const digest = hash.digest('hex');
  const expectedSourceHash = releasedUpdater?.sha256 || crypto.createHash('sha256').update(await fs.readFile(path.join(ROOT, 'electron', 'updater.cjs'))).digest('hex');
  let beforeSettings = JSON.parse(await fs.readFile(path.join(userData, 'settings.json'), 'utf8'));
  // Match a normal Start-menu launch: an inherited helper working directory inside
  // the installation must not be concealed by launching the app from the checkout.
  const application = await _electron.launch({ executablePath: executable, args: [], cwd: path.dirname(executable), env: environment, timeout: 30000 });
  const parent = application.process();
  const parentExit = { observed: false, code: null, signal: null };
  parent.once('exit', (code, signal) => { Object.assign(parentExit, { observed: true, code, signal }); });
  let trace;
  const readTrace = async () => { trace = await readLatestTrace(traceDirectory); return trace; };
  const checkFailure = async () => {
    const current = await readTrace();
    if (current.result && current.result.status !== (releasedUpdater ? 'installing' : 'opened')) throw new Error(`Released updater did not hand off: ${current.result.message}`);
    for (const stage of current.stageDirectories) {
      const errorFile = path.join(stage, 'update-error.txt');
      if (await exists(errorFile)) {
        const message = (await fs.readFile(errorFile, 'utf8')).replace(/^\ufeff/, '').slice(0, 16000);
        await fs.writeFile(path.join(OUTPUT, `${prefix}-error.txt`), message);
        throw new Error(`Released app update failed: ${message}`);
      }
    }
    if (legacyDiagnostic && current.helper?.exitCode != null && current.helper.exitCode !== 0) throw new Error(`Released updater helper exited with code ${current.helper.exitCode}`);
  };
  try {
    const page = await application.firstWindow();
    await page.locator('.desktop-shell').waitFor({ timeout: 30000 });
    assert.equal(await page.evaluate(() => window.allradione.version()), fromVersion, 'Exercise the real installed application before updating');
    const actual = await application.evaluate(({ app, ipcMain, shell }, fixture) => {
      // Playwright evaluates in the real Electron main process. Its CJS entry point
      // resolves the packaged updater without copying or rewriting any source.
      const require = process.mainModule.require.bind(process.mainModule);
      const fs = require('node:fs');
      const path = require('node:path');
      const crypto = require('node:crypto');
      const { Readable } = require('node:stream');
      const sourcePath = path.join(app.getAppPath(), 'electron', 'updater.cjs');
      const sourceHash = crypto.createHash('sha256').update(fs.readFileSync(sourcePath)).digest('hex');
      const updateRoot = path.join(app.getPath('userData'), 'updates');
      const existingStages = new Set(fs.existsSync(updateRoot) ? fs.readdirSync(updateRoot) : []);
      const trace = { sourcePath, sourceHash, cwd: process.cwd(), parentPid: process.pid, currentVersion: app.getVersion(), reportedUpdaterVersion: fixture.reportedCurrentVersion || app.getVersion(), requests: [], stageDirectories: [], result: null, helper: null };
      const writeTrace = require(fixture.traceHelperPath).createTraceWriter(fixture.traceDirectory);
      const persist = () => writeTrace(trace);
      const tag = `v${fixture.toVersion}`;
      const name = path.basename(fixture.installer);
      const assetUrl = `https://github.com/samueltoken/Allradione/releases/download/${tag}/${name}`;
      const latestUrl = 'https://api.github.com/repos/samueltoken/Allradione/releases/latest';
      const release = { tag_name: tag, draft: false, prerelease: false, assets: [{ name, state: 'uploaded', browser_download_url: assetUrl, digest: `sha256:${fixture.digest}` }] };
      // A same-build update needs only the updater's version comparison adjusted.
      // Native app identity, paths, lifecycle and renderer version remain genuine.
      const updaterApp = fixture.reportedCurrentVersion ? new Proxy(app, { get(target, key) {
        if (key === 'getVersion') return () => fixture.reportedCurrentVersion;
        const value = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      } }) : app;
      const diagnosticSpawn = (file, args, options) => {
        const savedScript = fixture.traceFile.replace(/-trace\.json$/, '-helper-script.ps1');
        // The current updater may launch a short cmd.exe/bootstrap command whose
        // arguments do not contain the full script. Preserve the owned stage file.
        for (const directory of trace.stageDirectories) {
          try { fs.copyFileSync(path.join(directory, 'apply-update.ps1'), savedScript); } catch {}
        }
        const stdout = fixture.legacyDiagnostic ? fs.openSync(fixture.helperStdout, 'a') : null;
        const stderr = fixture.legacyDiagnostic ? fs.openSync(fixture.helperStderr, 'a') : null;
        let child;
        try { child = require('node:child_process').spawn(file, args, fixture.legacyDiagnostic ? { ...options, stdio: ['ignore', stdout, stderr] } : options); }
        finally { if (stdout !== null) fs.closeSync(stdout); if (stderr !== null) fs.closeSync(stderr); }
        // Current-mode streams/options stay untouched. Observe each chunk before
        // the updater's READY listener; EventEmitter still delivers it to both.
        if (!fixture.legacyDiagnostic) {
          child.stdout?.on('data', chunk => fs.appendFileSync(fixture.helperStdout, chunk));
          child.stderr?.on('data', chunk => fs.appendFileSync(fixture.helperStderr, chunk));
        }
        if (!fs.existsSync(savedScript) && args.at(-2) === '-EncodedCommand') fs.writeFileSync(savedScript, Buffer.from(args.at(-1), 'base64').toString('utf16le'));
        trace.helper = { pid: child.pid, executable: file, argumentCharacters: args.reduce((total, argument) => total + argument.length + 1, 0), cwd: options.cwd || process.cwd(), detached: options.detached, stdio: options.stdio, hasPsModulePath: Object.keys(options.env || process.env).some(key => key.toUpperCase() === 'PSMODULEPATH'), exitCode: null, signal: null };
        persist();
        child.once('exit', (code, signal) => {
          trace.helper.exitCode = code; trace.helper.signal = signal;
          // Registered before the production listener: retain a helper catch log
          // synchronously before installUpdate removes its failed staging folder.
          for (const directory of trace.stageDirectories) {
            const errorFile = path.join(directory, 'update-error.txt');
            try {
              trace.helper.errorLog = fs.readFileSync(errorFile, 'utf8');
              fs.writeFileSync(fixture.traceFile.replace(/-trace\.json$/, '-helper-error.txt'), trace.helper.errorLog);
            } catch {}
          }
          persist();
        });
        return child;
      };
      const updater = require(sourcePath).createUpdater({
        app: updaterApp, shell, dataDir: app.getPath('userData'),
        spawnImpl: diagnosticSpawn,
        // Only the transport is controlled: stream the genuine newly built NSIS
        // installer through the released downloader and its real SHA256 validation.
        fetchImpl: async url => {
          trace.requests.push(url === latestUrl ? 'release metadata fixture' : url === assetUrl ? 'local built installer stream' : 'unexpected URL');
          trace.stageDirectories = fs.existsSync(updateRoot) ? fs.readdirSync(updateRoot).filter(name => !existingStages.has(name) && /^release-/.test(name)).map(name => path.join(updateRoot, name)) : [];
          persist();
          if (url === latestUrl) return new Response(JSON.stringify(release));
          if (url === assetUrl) return new Response(Readable.toWeb(fs.createReadStream(fixture.installer)), { headers: { 'content-length': String(fs.statSync(fixture.installer).size) } });
          throw new Error('Unexpected request outside the controlled release fixture');
        },
      });
      for (const channel of ['update:check', 'update:install']) ipcMain.removeHandler(channel);
      ipcMain.handle('update:check', () => updater.checkUpdate());
      ipcMain.handle('update:install', async () => {
        const result = await updater.installUpdate();
        trace.result = result; persist();
        return result;
      });
      persist();
      return { sourceHash, pid: process.pid, cwd: process.cwd(), executable: app.getPath('exe'), userData: app.getPath('userData') };
    }, { installer, toVersion, digest, traceFile, traceDirectory, traceHelperPath, reportedCurrentVersion, legacyDiagnostic, helperStdout, helperStderr });
    assert.equal(actual.sourceHash, expectedSourceHash, 'The updater must be the exact source from the tested installed build');
    assert.ok(await sameWindowsFile(actual.cwd, path.dirname(executable)), 'Real app updater must inherit the installed working directory');
    assert.ok(await sameWindowsFile(actual.executable, executable), 'Updater must run inside the installed baseline executable');
    assert.ok(await sameWindowsFile(actual.userData, userData), 'Updater must use the genuine installed profile');
    if (!releasedUpdater) {
      await startRadioFixture(application, page);
      beforeSettings = await page.evaluate(() => window.allradione.getPreferences());
    }
    await page.locator('[data-action="settings"]').click();
    await page.locator('[data-action="check-update"]').click();
    await page.locator('[data-action="install-update"]').waitFor({ timeout: 30000 });
    assert.match(await page.locator('[data-action="install-update"]').innerText(), /다운로드 및 설치/, 'Released Settings must offer the native installer action');
    await page.screenshot({ path: path.join(OUTPUT, `${prefix}-before.png`) });
    await page.locator('[data-action="install-update"]').click();
    let setupWindows;
    if (!releasedUpdater) {
      const waitForWizard = async previousPid => {
        await poll(async () => {
          await checkFailure();
          return trace.result?.status === 'opened' && trace.helper?.pid && trace.helper.pid !== previousPid;
        }, 'interactive setup opens from the real Settings button', 60000);
        assert.ok(await sameWindowsFile(trace.helper.executable, path.join(trace.stageDirectories[0], path.basename(installer))));
        assert.ok(processAlive(actual.pid), 'The player stays open until the user accepts the wizard');
        return trace.helper.pid;
      };
      const first = await waitForWizard();
      const cancelledStage = trace.stageDirectories[0];
      const playedBeforeCancel = await page.evaluate(() => window.__setupTestRadio.currentTime);
      const cancel = await operateSetupWindow(first, true);
      await poll(async () => !(await exists(cancelledStage)), 'cancel removes its owned download');
      assert.ok(processAlive(actual.pid), 'Cancelling Setup must leave the old app running');
      const playedAfterCancel = await page.evaluate(() => {
        const audio = window.__setupTestRadio;
        return { seconds: audio.currentTime, playing: !audio.paused && !audio.ended && !audio.error };
      });
      assert.ok(playedAfterCancel.playing && playedAfterCancel.seconds > playedBeforeCancel, 'The same real audio element keeps playing through cancellation');
      await page.locator('[data-action="check-update"]').click();
      await page.locator('[data-action="install-update"]').click();
      const second = await waitForWizard(first);
      const finish = await operateSetupWindow(second);
      assert.equal(finish.exitCode, 0);
      setupWindows = { cancel, finish, playedBeforeCancel, playedAfterCancel };
    }
    await poll(async () => { await checkFailure(); return parentExit.observed && !processAlive(actual.pid); }, 'actual installed application exits after its own updater handoff', legacyDiagnostic ? 30000 : 60000);
    assert.equal(parentExit.code, 0, 'Released updater must quit the original application normally');
    await checkFailure();
    assert.equal(trace.stageDirectories.length, 1, 'The released downloader must create one actual update stage');
    const stage = trace.stageDirectories[0];
    let restarted = [];
    let upgraded;
    await poll(async () => {
      await checkFailure();
      const snapshot = await windowsSnapshot();
      restarted = (await ownedProcesses(snapshot, executable)).filter(process => process.pid !== actual.pid && process.windowHandle !== 0);
      upgraded = null;
      for (const installation of snapshot.installations) {
        const directory = registeredInstallDirectory(installation);
        if (installation.version === toVersion && directory && await sameWindowsFile(directory, path.dirname(executable))) { upgraded = installation; break; }
      }
      return restarted.length > 0 && Boolean(upgraded) && !(await exists(stage));
    }, 'actual installed updater installs, restarts at its original location and cleans its stage', legacyDiagnostic ? 30000 : 180000);
    const installedPackage = JSON.parse(extractInstalledFile(path.dirname(executable), 'package.json').toString('utf8'));
    assert.equal(installedPackage.version, toVersion, 'Restarted executable must have the new packaged application');
    const afterSettings = JSON.parse(await fs.readFile(path.join(userData, 'settings.json'), 'utf8'));
    for (const key of Object.keys(beforeSettings)) assert.deepEqual(afterSettings[key], beforeSettings[key], `Actual app update must preserve ${key}`);
    await stopOwnedRestart(executable);
    return { check: 'actual installed app Settings update downloads, validates, exits, installs and restarts', passed: true, setupWindows, releaseGate: !legacyDiagnostic, fromVersion, toVersion, reportedUpdaterVersion: reportedCurrentVersion || fromVersion, updaterSource: releasedUpdater?.source || 'current installed app.asar', updaterSha256: actual.sourceHash, originalPid: actual.pid, launcherPid: parent.pid, launcherExit: parentExit, actualParentExited: true, workingDirectory: actual.cwd, restartPids: restarted.map(process => process.pid), originalInstallLocationPreserved: true, settingsPreserved: true, stageRemoved: true, transport: 'controlled metadata and local real NSIS bytes; production downloader/app lifecycle; diagnostic helper output observation' };
  } catch (error) {
    const failureTrace = await readTrace().catch(() => null);
    const helper = failureTrace?.helper;
    const helperOutput = { stdout: await fs.readFile(helperStdout, 'utf8').catch(() => null), stderr: await fs.readFile(helperStderr, 'utf8').catch(() => null) };
    const stages = [];
    for (const directory of failureTrace?.stageDirectories || []) {
      stages.push({ directory, files: await fs.readdir(directory).catch(() => []) });
      for (const file of ['apply-update.ps1', 'update-error.txt']) {
        await fs.copyFile(path.join(directory, file), path.join(OUTPUT, `${prefix}-${file}`)).catch(() => {});
      }
    }
    error.updateDiagnostic = { error: error.message, launcherPid: parent.pid, launcherExit: parentExit, trace: failureTrace, helperAlive: processAlive(helper?.pid), helperOutput, stages, snapshot: await windowsSnapshot().catch(() => null) };
    await fs.writeFile(path.join(OUTPUT, `${prefix}-failure.json`), JSON.stringify(error.updateDiagnostic, null, 2));
    throw error;
  } finally {
    await application.close().catch(() => {});
    await stopOwnedRestart(executable).catch(() => {});
    // Publish the convenient single-file artifact only after its writer exits.
    // Keep the immutable snapshots even if final artifact writing fails.
    await readTrace().then(value => fs.writeFile(traceFile, JSON.stringify(value, null, 2))).catch(() => {});
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
  const baselineInstaller = path.join(temporary, 'baseline', `Allradione-Setup-${BASELINE_VERSION}-x64.exe`);
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
  const legacyPreferences = JSON.stringify({ volume: 0.61, favorites: [legacyStation], widgetEnabled: false, backgroundPlayback: false, widgetSize: 'small', lastCountry: 'JP', reducedMotion: false });

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
    await fs.mkdir(path.dirname(baselineInstaller));
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
      assert.equal(migrated.backgroundPlayback, false, 'The test listener chose to quit on window close');
      assert.equal(migrated.volume, 0.61, 'Fresh installation must migrate the adjacent portable preferences');
      assert.deepEqual(migrated.favorites.map(station => station.stationuuid), [legacyStation.stationuuid], 'Fresh installation must migrate portable favorites');
    });
    results.push({ check: 'fresh installer migrates adjacent portable settings without changing the source', passed: true });
    const reportedCurrentVersion = '0.0.0';
    assert.ok(require('../electron/updater.cjs').isNewer(packageJson.version, reportedCurrentVersion), 'Same-build updater fixture must report an older semantic version');
    results.push(await exerciseInstalledAppUpdate({ installer: setupCopy, executable, userData, fromVersion: packageJson.version, toVersion: packageJson.version, reportedCurrentVersion }));

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

    // Install the retained, SHA256-pinned release as the upgrade baseline.
    await runProcess(baselineInstaller, nsisArguments(installDirectory), { verbatim: true });
    installed = true;
    await assertNativeDesktopLaunch({ desktopExe, desktopShortcut, executable, phase: 'baseline' });
    const baselinePid = await withInstalledApp(executable, async (application, page) => {
      assert.equal(await page.evaluate(() => window.allradione.version()), BASELINE_VERSION, `Upgrade baseline must be actual released v${BASELINE_VERSION}`);
      await page.evaluate(station => window.allradione.savePreferences({ volume: 0.31, favorites: [station], widgetEnabled: false, widgetSize: 'medium', reducedMotion: true }), sentinel);
      return application.process().pid;
    });
    // 0.2.4 predates the background preference. Seed the listener's choice
    // in the disposable profile while that app is fully closed. The old
    // downloader does not save settings, so the new installation inherits it.
    const savedSettings = JSON.parse(await fs.readFile(path.join(userData, 'settings.json'), 'utf8'));
    savedSettings.backgroundPlayback = false;
    await fs.writeFile(path.join(userData, 'settings.json'), JSON.stringify(savedSettings));
    const beforeUpgrade = await windowsSnapshot();
    await assertShortcutTarget(beforeUpgrade, menuShortcut, executable, 'Baseline Start menu shortcut must target the actual installed app');
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
    // The baseline can equal this build during documentation-only changes.
    // Adjust only the version comparison in that case; keep the installed
    // executable, updater, helper handshake and automatic-update gate genuine.
    const baselineReportedVersion = packageJson.version === BASELINE_VERSION ? reportedCurrentVersion : null;
    results.push(await exerciseInstalledAppUpdate({ installer: setupCopy, executable, userData, fromVersion: BASELINE_VERSION, toVersion: packageJson.version, releasedUpdater, reportedCurrentVersion: baselineReportedVersion }));
    assert.equal(await exists(obsolete), false, 'Upgrade must remove obsolete files from the installer-owned application directory');
    assert.equal(await fs.readFile(path.join(unrelatedDirectory, 'keep.txt'), 'utf8'), 'Never follow this junction during uninstall.', 'Upgrade must preserve unrelated outside files');
    await assertNativeDesktopLaunch({ desktopExe, desktopShortcut, executable, phase: 'after-baseline-upgrade' });
    await withInstalledApp(executable, async (_application, page) => {
      assert.equal(await page.evaluate(() => window.allradione.version()), packageJson.version, 'Upgraded app must report the new version');
      const preferences = await page.evaluate(() => window.allradione.getPreferences());
      assert.equal(preferences.volume, 0.31, 'Upgrade must preserve volume');
      assert.equal(preferences.backgroundPlayback, false, 'Upgrade retains the choice to quit on window close');
      assert.equal(preferences.reducedMotion, true, 'Upgrade must preserve settings');
      assert.deepEqual(preferences.favorites.map(station => station.stationuuid), [sentinel.stationuuid], 'Upgrade must preserve favorites');
      assert.equal(await fs.readFile(path.join(userData, MARKER), 'utf8'), APP_ID, 'Upgrade must preserve the owned profile');
      assert.equal(JSON.parse(await fs.readFile(path.join(userData, 'code-cache-version.json'), 'utf8')).version, packageJson.version, 'New version must complete its code-cache transition');
      assert.equal(await exists(oldStage), false, 'Startup must clean expired, positively owned update staging');
      assert.equal(await fs.readFile(path.join(unownedStage, 'keep.txt'), 'utf8'), 'Unmarked data must be preserved.', 'Startup must preserve unmarked legacy update data');
      await page.evaluate(() => window.allradione.savePreferences({ reducedMotion: false }));
    });
    results.push({ check: 'retained release automatic upgrade preserves settings and launcher and removes obsolete owned files', mode: 'automatic-update', fromVersion: BASELINE_VERSION, toVersion: packageJson.version, crossVersionUpdateTested: BASELINE_VERSION !== packageJson.version, passed: true });

    await withInstalledApp(executable, async (_application, page) => {
      await page.evaluate(() => window.allradione.savePreferences({ backgroundPlayback: true }));
    });
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
    await fs.writeFile(path.join(OUTPUT, 'smoke-installer.json'), JSON.stringify({ passed: completed, version: packageJson.version, baselineVersion: BASELINE_VERSION, baselineAutomaticUpdatePassed: completed, crossVersionUpdateTested: BASELINE_VERSION !== packageJson.version, error: failure?.message, results }, null, 2));
    if (!(await exists(installDirectory))) await fs.rm(temporary, { recursive: true, force: true });
  }
  if (failure) throw failure;
  console.log(`Installer release gates passed: fresh install, current-app automatic update, retained v${BASELINE_VERSION} automatic update, settings preservation, native UI and uninstall.`);
}

module.exports = { nsisArguments, sameWindowsPath, assertFreshSnapshot, runProcess, extractInstalledFile };
if (require.main === module) main().catch(error => { console.error('Installer lifecycle smoke failed:', error.message); process.exitCode = 1; });

