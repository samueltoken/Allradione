'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { nsisArguments, sameWindowsPath, assertFreshSnapshot, runProcess } = require('../scripts/smoke-installer.cjs');

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
  const clean = { installations: [], existingShortcuts: [], existingData: [], runningProcesses: [] };
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
