'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { nsisArguments, sameWindowsPath, assertFreshSnapshot } = require('../scripts/smoke-installer.cjs');

test('NSIS custom directories with spaces remain the final unquoted argument', () => {
  const directory = 'C:\\Users\\CI Runner\\Temp\\Allradione Custom Folder';
  assert.deepEqual(nsisArguments(directory, { noDesktopShortcut: true }), ['/S', '/currentuser', '--no-desktop-shortcut', `/D=${directory}`]);
  assert.deepEqual(nsisArguments(directory, { uninstall: true }), ['/S', '/currentuser', `_?=${directory}`]);
});

test('installer harness rejects drive roots, relative paths and injected arguments', () => {
  for (const directory of ['C:\\', 'relative', 'C:\\Temp\\app\" /allusers', 'C:\\Temp\\app\n/S']) {
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
