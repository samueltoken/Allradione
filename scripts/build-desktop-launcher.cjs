#!/usr/bin/env node
'use strict';
// Windows x64 build using the MSVC tools provided by Visual Studio / Build Tools.
// The launcher embeds the static CRT and does not need an additional installation.
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execute = promisify(execFile);
const ROOT = path.resolve(__dirname, '..');
const OWNER = 'io.github.samueltoken.allradione.desktop-launcher:v1';

function quoted(value) {
  // Values go into a generated .cmd file, where percent expansion must be escaped.
  if (/["\r\n]/.test(value)) throw new Error('Unsupported quote or newline in build path');
  return '"' + value.replaceAll('%', '%%') + '"';
}
function rcPath(value) { return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"'); }

async function main() {
  if (process.platform !== 'win32') throw new Error('Build the desktop launcher on Windows with Visual Studio C++ Build Tools.');
  const packageJson = JSON.parse(await fs.readFile(path.join(ROOT, 'package.json'), 'utf8'));
  if (!/^\d+\.\d+\.\d+$/.test(packageJson.version) || packageJson.version.split('.').some(part => Number(part) > 65535)) throw new Error('The launcher needs a numeric Windows-compatible package version.');
  const vswhere = path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft Visual Studio', 'Installer', 'vswhere.exe');
  const found = await execute(vswhere, ['-latest', '-products', '*', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-property', 'installationPath'], { windowsHide: true, timeout: 30000 });
  const installation = found.stdout.trim();
  if (!installation || /[\r\n]/.test(installation)) throw new Error('Visual Studio C++ Build Tools were not found.');
  const developerCommand = path.join(installation, 'Common7', 'Tools', 'VsDevCmd.bat');
  await fs.access(developerCommand);
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'allradione-native-build-'));
  try {
    const ownerPath = path.join(temporary, 'owner.bin');
    const resourcePath = path.join(temporary, 'launcher.rc');
    const resourceObject = path.join(temporary, 'launcher.res');
    const objectPath = path.join(temporary, 'launcher.obj');
    const binaryPath = path.join(temporary, 'desktop-launcher.exe');
    await fs.writeFile(ownerPath, OWNER, 'ascii');
    const replacements = {
      '@ICON@': rcPath(path.join(ROOT, 'assets', 'icon.ico')),
      '@MANIFEST@': rcPath(path.join(ROOT, 'native', 'desktop-launcher', 'launcher.manifest')),
      '@OWNER@': rcPath(ownerPath),
      '@VERSION_COMMA@': packageJson.version.split('.').concat('0').join(','),
      '@VERSION@': packageJson.version
    };
    let resource = await fs.readFile(path.join(ROOT, 'native', 'desktop-launcher', 'launcher.rc.in'), 'utf8');
    for (const [token, value] of Object.entries(replacements)) resource = resource.replaceAll(token, value);
    await fs.writeFile(resourcePath, resource, 'utf8');
    const commands = [
      '@echo off',
      'chcp 65001 >nul',
      'setlocal DisableDelayedExpansion',
      `call ${quoted(developerCommand)} -no_logo -arch=x64 -host_arch=x64`,
      'if errorlevel 1 exit /b %errorlevel%',
      `rc.exe /nologo /fo ${quoted(resourceObject)} ${quoted(resourcePath)}`,
      'if errorlevel 1 exit /b %errorlevel%',
      `cl.exe /nologo /std:c++17 /utf-8 /W4 /WX /O2 /MT /EHsc /DWINVER=0x0A00 /D_WIN32_WINNT=0x0A00 /Fo${quoted(objectPath)} /Fe${quoted(binaryPath)} ${quoted(path.join(ROOT, 'native', 'desktop-launcher', 'launcher.cpp'))} ${quoted(resourceObject)} /link /SUBSYSTEM:WINDOWS /MACHINE:X64 /DYNAMICBASE /NXCOMPAT /HIGHENTROPYVA /MANIFEST:NO user32.lib advapi32.lib shell32.lib ole32.lib uuid.lib version.lib`,
      'exit /b %errorlevel%'
    ].join('\r\n');
    const commandPath = path.join(temporary, 'compile.cmd');
    await fs.writeFile(commandPath, commands, 'utf8');
    const result = await execute(process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe', ['/d', '/s', '/c', '"' + commandPath + '"'], { cwd: temporary, windowsHide: true, timeout: 180000, maxBuffer: 4 * 1024 * 1024 });
    if (result.stdout.trim()) process.stdout.write(result.stdout);
    if (result.stderr.trim()) process.stderr.write(result.stderr);
    const binary = await fs.readFile(binaryPath);
    if (binary.length < 1024 || binary.length > 8 * 1024 * 1024 || binary.subarray(0, 2).toString('ascii') !== 'MZ' || !binary.includes(Buffer.from(OWNER))) throw new Error('The native launcher build did not produce the expected owned PE executable.');
    const destination = path.join(ROOT, 'assets', 'desktop-launcher.exe');
    await fs.copyFile(binaryPath, destination);
    process.stdout.write(`Built assets/desktop-launcher.exe (${binary.length} bytes, ${packageJson.version}, Windows x64, static CRT)\n`);
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
}

main().catch(error => {
  if (error.stdout) process.stderr.write(error.stdout);
  if (error.stderr) process.stderr.write(error.stderr);
  process.stderr.write(error.message + '\n');
  process.exitCode = 1;
});
