'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { nsisArguments, sameWindowsPath, assertFreshSnapshot, runProcess, extractInstalledFile } = require('../scripts/smoke-installer.cjs');

test('NSIS custom directories with spaces remain the final unquoted argument', () => {
  const directory = 'C:\\Users\\CI Runner\\Temp\\Allradione Custom Folder';
  assert.deepEqual(nsisArguments(directory, { noDesktopShortcut: true }), ['/S', '/currentuser', '--no-desktop-shortcut', `/D=${directory}`]);
  assert.deepEqual(nsisArguments(directory, { uninstall: true }), ['/S', '/currentuser', `_?=${directory}`]);
});

test('installer harness rejects drive roots, relative paths and injected arguments', () => {
  for (const directory of ['C:\\', 'C:\\Temp\\..', '\\\\server\\share', 'relative', 'C:\\Temp\\app\" /allusers', 'C:\\Temp\\app\n/S']) {
    assert.throws(() => nsisArguments(directory));
  }
});

test('installer harness refuses any pre-existing installation, data, shortcuts or process', () => {
  const clean = { installations: [], existingShortcuts: [], existingData: [], runningProcesses: [], existingLaunchers: [] };
  assert.doesNotThrow(() => assertFreshSnapshot(clean));
  for (const key of Object.keys(clean)) assert.throws(() => assertFreshSnapshot({ ...clean, [key]: ['pre-existing user item'] }));
});

test('Windows path comparisons handle case and separators without accepting siblings', () => {
  assert.equal(sameWindowsPath('C:\\Temp\\Allradione\\', 'c:/temp/allradione'), true);
  assert.equal(sameWindowsPath('C:\\Temp\\Allradione', 'C:\\Temp\\Allradione-old'), false);
});

test('handoff diagnostics retain stderr even when a process exits successfully', async () => {
  const result = await runProcess(process.execPath, ['-e', "process.stdout.write('normal output');process.stderr.write('caught error detail')"], { captureOutput: true });
  assert.deepEqual(result, { exitCode: 0, stdout: 'normal output', stderr: 'caught error detail' });
});

test('handoff failures expose the actual exit code and both output streams', async () => {
  await assert.rejects(runProcess(process.execPath, ['-e', "process.stdout.write('before failure');process.stderr.write('parse failure');process.exitCode=7"], { captureOutput: true }), error => error.exitCode === 7 && error.stdout === 'before failure' && error.stderr === 'parse failure');
});

test('installed ASAR reads refresh cached offsets after another version replaces the same path', async t => {
  const asar = require('@electron/asar');
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'allradione-asar-replacement-'));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const installed = path.join(temporary, 'installed');
  const archive = path.join(installed, 'resources', 'app.asar');
  await fs.mkdir(path.dirname(archive), { recursive: true });
  const sources = [path.join(temporary, 'version-one'), path.join(temporary, 'version-two')];
  const code = ["module.exports = { version: 'one' };", "module.exports = { version: 'two', added: 'different archive offsets and file size' };"];
  for (const [index, source] of sources.entries()) {
    await fs.mkdir(path.join(source, 'electron'), { recursive: true });
    await fs.writeFile(path.join(source, 'electron', 'updater.cjs'), code[index]);
    await fs.writeFile(path.join(source, 'package.json'), JSON.stringify({ version: index + 1 }));
  }
  await fs.writeFile(path.join(sources[1], 'a-padding.txt'), 'new payload before the updater\n'.repeat(128));
  await asar.createPackage(sources[0], archive);
  assert.equal(extractInstalledFile(installed, 'electron/updater.cjs').toString(), code[0]);
  const replacement = path.join(temporary, 'replacement.asar');
  await asar.createPackage(sources[1], replacement);
  await fs.copyFile(replacement, archive);
  assert.equal(extractInstalledFile(installed, 'electron/updater.cjs').toString(), code[1]);
  assert.equal(JSON.parse(extractInstalledFile(installed, 'package.json').toString()).version, 2);
});
