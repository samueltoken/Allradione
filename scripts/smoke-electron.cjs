#!/usr/bin/env node
'use strict';
/**
 * Native window/IPC smoke check. Run after `npm run build` with Node 24.
 * Windows: node scripts/smoke-electron.cjs
 * Linux:   DISPLAY=:99 node scripts/smoke-electron.cjs
 * This verifies native window lifecycle and widget state, not live station audio.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { _electron } = require('playwright');
const { expect } = require('@playwright/test');

const ROOT = path.resolve(__dirname, '..');
const OUTPUT = path.join(ROOT, 'artifacts');
const TIMEOUT = 30000;
const rendererErrors = [];
const startupDiagnostics = [];
const observed = new WeakSet();
const results = [];
let application;
let temporary;

function observe(page) {
  if (observed.has(page)) return;
  observed.add(page);
  page.on('pageerror', error => rendererErrors.push(error.message));
  page.on('console', message => {
    if (message.type() === 'error' && /Unable to load preload|Uncaught|SyntaxError|ReferenceError|TypeError/i.test(message.text())) {
      rendererErrors.push(message.text());
    }
  });
  page.on('crash', () => rendererErrors.push('A renderer process crashed.'));
}

function safeDiagnostic(text) {
  return String(text)
    .replace(/([?&](?:token|key|access_token|auth)=)[^&\s]+/gi, '$1[redacted]')
    .replace(/https?:\/\/[^\s"<>]+/g, '[network address]')
    .slice(0, 800);
}

async function nativeWindow(kind) {
  return application.evaluate(({ BrowserWindow, screen }, requestedKind) => {
    const window = BrowserWindow.getAllWindows().find(candidate => {
      const url = candidate.webContents.getURL();
      return requestedKind === 'main' ? !url.includes('widget=') : url.includes(`widget=${requestedKind}`);
    });
    if (!window) return null;
    const bounds = window.getBounds();
    const mainWindow = BrowserWindow.getAllWindows().find(candidate => !candidate.webContents.getURL().includes('widget='));
    const workArea = screen.getDisplayMatching(mainWindow?.getBounds() || bounds).workArea;
    return {
      bounds, workArea, visible: window.isVisible(), alwaysOnTop: window.isAlwaysOnTop(),
      resizable: window.isResizable(), destroyed: window.isDestroyed(),
      contextIsolation: window.webContents.getLastWebPreferences().contextIsolation,
      nodeIntegration: window.webContents.getLastWebPreferences().nodeIntegration,
      sandbox: window.webContents.getLastWebPreferences().sandbox,
    };
  }, kind);
}

async function assertWidget(kind, width, height) {
  await expect.poll(async () => (await nativeWindow(kind))?.visible, { timeout: TIMEOUT }).toBe(true);
  const state = await nativeWindow(kind);
  const virtualDisplay = process.platform === 'linux' && state.workArea.width <= 1 && process.env.ALLRADIONE_SMOKE_SKIP_SINGLE_INSTANCE === '1';
  if (!virtualDisplay) assert.equal(state.bounds.width, width, `${kind} widget width`);
  if (!virtualDisplay) assert.equal(state.bounds.height, height, `${kind} widget height`);
  if (!virtualDisplay) assert.equal(state.alwaysOnTop, true, `${kind} widget must be always on top`);
  assert.equal(state.resizable, false, `${kind} widget should retain its designed size`);
  assert.equal(state.contextIsolation, true, 'Renderer context isolation');
  assert.equal(state.nodeIntegration, false, 'Node must not be exposed in the renderer');
  assert.equal(state.sandbox, true, 'Widget renderer sandbox');
  const rightMargin = state.workArea.x + state.workArea.width - state.bounds.x - state.bounds.width;
  const bottomMargin = state.workArea.y + state.workArea.height - state.bounds.y - state.bounds.height;
  if (!virtualDisplay) assert.ok(Math.abs(rightMargin - 20) <= 2, `Expected a 20 DIP right margin, received ${rightMargin}`);
  if (!virtualDisplay) assert.ok(Math.abs(bottomMargin - 20) <= 2, `Expected a 20 DIP bottom margin, received ${bottomMargin}`);
  results.push({ check: `${kind} native window`, ...state, nativeGeometryVerified: !virtualDisplay, ...(virtualDisplay ? { note: 'Headless Ozone exposes a 1×1 display; bounds, compositor stacking and anchoring require Windows CI.' } : {}) });
}

async function findWidget(kind) {
  await expect.poll(() => application.windows().filter(page => page.url().includes(`widget=${kind}`)).length, { timeout: TIMEOUT }).toBe(1);
  const page = application.windows().find(candidate => candidate.url().includes(`widget=${kind}`));
  observe(page);
  const native = await nativeWindow(kind);
  if (process.platform === 'linux' && native?.workArea.width <= 1 && process.env.ALLRADIONE_SMOKE_SKIP_SINGLE_INSTANCE === '1') await page.setViewportSize(kind === 'small' ? { width: 176, height: 190 } : { width: 460, height: 230 });
  await page.locator(`body.widget-${kind}`).waitFor({ timeout: TIMEOUT });
  await page.locator('[data-widget-name]').waitFor({ timeout: TIMEOUT });
  return page;
}

async function assertFonts(page) {
  const fonts = await page.evaluate(async () => {
    const required = ['Pretendard Variable', 'Sora Variable', 'IBM Plex Mono'];
    await document.fonts.ready;
    return Promise.all(required.map(async family => {
      const faces = await document.fonts.load(`16px "${family}"`, family.startsWith('Pretendard') ? '한글 라디오' : 'Allradione 123');
      return { family, count: faces.length, loaded: faces.length > 0 && faces.every(face => face.status === 'loaded') };
    }));
  });
  for (const font of fonts) assert.equal(font.loaded, true, `Bundled font must load: ${font.family}`);
  results.push({ check: 'bundled Korean, display and mono fonts', fonts });
}

async function captureTransparentWidget(page, fileName) {
  const png = await page.screenshot({ path: path.join(OUTPUT, fileName), omitBackground: true });
  const pixels = await application.evaluate(({ nativeImage }, base64) => {
    const screenshot = nativeImage.createFromBuffer(Buffer.from(base64, 'base64'));
    const { width, height } = screenshot.getSize();
    const bitmap = screenshot.toBitmap();
    const alpha = (x, y) => bitmap[(y * width + x) * 4 + 3];
    return { width, height, corners: [alpha(0, 0), alpha(width - 1, 0), alpha(0, height - 1), alpha(width - 1, height - 1)], center: alpha(Math.floor(width / 2), Math.floor(height / 2)) };
  }, png.toString('base64'));
  assert.deepEqual(pixels.corners, [0, 0, 0, 0], `${fileName}: actual PNG corners must be fully transparent`);
  assert.ok(pixels.center > 0, `${fileName}: screenshot must contain a visible widget`);
  results.push({ check: `${fileName} actual PNG alpha`, ...pixels });
}

async function readPlayerState(page) {
  return page.evaluate(() => new Promise((resolve, reject) => {
    let off = () => {};
    const timeout = setTimeout(() => { off(); reject(new Error('Player state did not arrive within 5 seconds.')); }, 5000);
    off = window.allradione.onPlayer(state => { clearTimeout(timeout); off(); resolve(state); });
  }));
}

async function assertDialAndFlags(main) {
  // This final, explicitly labeled UI fixture checks interaction without requiring a broadcaster.
  // It runs after the independent live probe and never reports fixture metadata as live audio.
  const stations = Array.from({ length: 7 }, (_, index) => ({
    ...fixtureState.station,
    stationuuid: `00000000-0000-4000-8000-${String(index + 10).padStart(12, '0')}`,
    name: `UI fixture · Dial station ${index + 1}`, countrycode: 'JP', tags: 'ui-fixture',
  }));
  await application.evaluate(({ ipcMain }, rows) => {
    for (const channel of ['radio:countries', 'radio:stations', 'radio:stream', 'radio:click']) ipcMain.removeHandler(channel);
    ipcMain.handle('radio:countries', () => [{ code: 'JP', name: '일본', stationcount: rows.length }]);
    ipcMain.handle('radio:stations', () => rows);
    ipcMain.handle('radio:stream', () => { throw new Error('UI fixture has no audio stream.'); });
    ipcMain.handle('radio:click', () => {});
  }, stations);
  await main.reload();
  const destination = main.locator('.destination[data-country="JP"]');
  await destination.waitFor({ timeout: TIMEOUT });
  await expect.poll(() => destination.locator('.country-flag').evaluate(element => {
    const image = element instanceof HTMLImageElement ? element : element.querySelector('img');
    return Boolean(image?.complete && image.naturalWidth > 0);
  }), { timeout: TIMEOUT }).toBe(true);
  const flag = await destination.locator('.country-flag').evaluate(element => {
    const image = element instanceof HTMLImageElement ? element : element.querySelector('img');
    return { loaded: Boolean(image?.complete && image.naturalWidth > 0), source: image?.currentSrc || image?.src || '' };
  });
  assert.equal(flag.loaded, true, 'Country flag image must load');
  assert.match(flag.source, /^(file:|data:)/, 'Flags must use bundled local assets');
  await destination.click();
  await expect(main.locator('[data-station]')).toHaveCount(stations.length, { timeout: TIMEOUT });
  await main.locator('[data-station]').first().click();
  await expect(main.locator('[data-station-name]')).toHaveText(stations[0].name);
  const dial = main.locator('#dial');
  await dial.scrollIntoViewIfNeeded();
  const box = await dial.boundingBox();
  assert.ok(box && box.width > 0 && box.height > 0, 'Dial must be visible');
  const cursorBefore = await dial.evaluate(element => getComputedStyle(element).cursor);
  assert.notEqual(cursorBefore, 'crosshair', 'Dial idle cursor must not be a crosshair');
  const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const radius = Math.min(box.width, box.height) * 0.38;
  const initialTransform = await main.locator('#dial-needle').evaluate(element => getComputedStyle(element).transform);
  await main.mouse.move(center.x, center.y - radius);
  await main.mouse.down();
  await expect(dial).toHaveClass(/dragging/);
  for (let step = 1; step <= 10; step++) {
    const angle = -Math.PI / 2 + step * Math.PI / 20;
    await main.mouse.move(center.x + Math.cos(angle) * radius, center.y + Math.sin(angle) * radius);
  }
  const draggedTransform = await main.locator('#dial-needle').evaluate(element => getComputedStyle(element).transform);
  assert.notEqual(draggedTransform, initialTransform, 'Dial needle must follow the pointer during drag');
  assert.notEqual(await dial.evaluate(element => getComputedStyle(element).cursor), 'crosshair', 'Dragging cursor must not be a crosshair');
  await expect(main.locator('[data-station-name]')).toHaveText(stations[0].name);
  await main.mouse.up();
  await expect(dial).not.toHaveClass(/dragging/);
  await expect(main.locator('[data-station-name]')).not.toHaveText(stations[0].name);
  const selectedName = await main.locator('[data-station-name]').innerText();
  assert.ok(stations.some(station => station.name === selectedName), 'Dial release must select an actual fixture station');
  await main.screenshot({ path: path.join(OUTPUT, 'dial-ui-fixture.png') });
  results.push({ check: 'explicit UI fixture: dial drag and bundled flag', selectedName, flagLoaded: flag.loaded, audio: 'not attempted; fixture stream deliberately unavailable' });
}

async function assertCacheControls(main) {
  const userData = await application.evaluate(({ app }) => app.getPath('userData'));
  const cacheFile = path.join(userData, 'cache-stations-ZZ.json');
  const untouchedFile = path.join(userData, 'smoke-cache-preserve.txt');
  await fs.mkdir(userData, { recursive: true });
  await fs.writeFile(cacheFile, JSON.stringify({ time: Date.now(), data: [], smokePadding: 'x'.repeat(8192) }));
  await fs.writeFile(untouchedFile, 'Unrelated files must survive cache clearing.');
  const original = await main.evaluate(() => window.allradione.getPreferences());
  await main.evaluate(station => window.allradione.savePreferences({ favorites: [station], volume: 0.23 }), fixtureState.station);
  const before = await main.evaluate(() => window.allradione.cacheInfo());
  assert.ok(before.metadataBytes >= 8192, 'Cache information must count the seeded metadata file');
  await main.locator('[data-action="settings"]').click();
  await expect(main.locator('#cache-size')).toBeVisible();
  await main.locator('[data-action="cache-clear"]').click();
  await expect.poll(async () => { try { await fs.access(cacheFile); return false; } catch { return true; } }, { timeout: TIMEOUT }).toBe(true);
  await expect(main.locator('[data-action="cache-clear"]')).toBeEnabled();
  await expect(main.locator('#cache-message')).not.toHaveText('');
  const after = await main.evaluate(() => window.allradione.cacheInfo());
  const kept = await main.evaluate(() => window.allradione.getPreferences());
  assert.equal(kept.volume, 0.23, 'Cache clearing must preserve the saved volume');
  assert.deepEqual(kept.favorites.map(station => station.stationuuid), [fixtureState.station.stationuuid], 'Cache clearing must preserve favorites');
  assert.equal(await fs.readFile(untouchedFile, 'utf8'), 'Unrelated files must survive cache clearing.');
  assert.ok(Number.isFinite(after.metadataBytes) && after.metadataBytes >= 0, 'Refreshed cache size must be valid');
  await main.screenshot({ path: path.join(OUTPUT, 'settings-cache.png') });
  await main.keyboard.press('Escape');
  await main.evaluate(preferences => window.allradione.savePreferences(preferences), original);
  await fs.rm(untouchedFile);
  results.push({ check: 'cache clear action preserves settings, favorites and unrelated files', beforeBytes: before.totalBytes, afterBytes: after.totalBytes, metadataBefore: before.metadataBytes, metadataAfter: after.metadataBytes });
}

async function captureCountryAndPlayback(main) {
  const probe = { check: 'optional live directory and playback', attempted: false, country: null, playback: 'not attempted', attempts: [] };
  try {
    // Keep the native test useful offline. Only the actual available API response populates this list.
    await main.locator('.destination[data-country]').first().waitFor({ timeout: 45000 });
    await main.screenshot({ path: path.join(OUTPUT, 'main.png') });
    const chosen = await main.locator('.destination[data-country]').evaluateAll(elements => {
      const preferred = elements.find(element => element.dataset.country === 'JP') || elements[0];
      return preferred?.dataset.country || null;
    });
    if (!chosen) throw new Error('No country is available in the live directory.');
    probe.country = chosen;
    await main.locator(`.destination[data-country="${chosen}"]`).click();
    await main.locator('.radio-page').waitFor({ timeout: TIMEOUT });
    await expect.poll(async () => await main.locator('.station-skeleton').count(), { timeout: 45000 }).toBe(0);
    await main.screenshot({ path: path.join(OUTPUT, 'country.png') });
    const stationCount = await main.locator('[data-station]').count();
    if (stationCount) {
      await main.locator('#volume').evaluate(input => {
        input.value = '3'; input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      });
      probe.attempted = true;
      for (let index = 0; index < Math.min(stationCount, 3); index++) {
        const station = main.locator('[data-station]').nth(index);
        const stationId = await station.getAttribute('data-station');
        const attempt = { station: await station.locator('.station-row-name').innerText(), status: 'connecting', playingEventObserved: false, spectrumMax: 0 };
        const started = Date.now();
        const deadline = started + 25000;
        let state;
        await station.click({ timeout: 5000 });
        const sample = async () => {
          const snapshot = await readPlayerState(main);
          if (snapshot.station?.stationuuid !== stationId) return 'waiting';
          state = snapshot;
          attempt.status = snapshot.status;
          attempt.playingEventObserved ||= snapshot.status === 'playing';
          attempt.spectrumMax = Math.max(attempt.spectrumMax, ...((snapshot.spectrum || []).filter(Number.isFinite)), 0);
          return snapshot.status;
        };
        try {
          await expect.poll(sample, { timeout: Math.max(1, deadline - Date.now()), intervals: [250, 500, 1000] }).toMatch(/^(playing|error)$/);
          if (attempt.playingEventObserved && Date.now() < deadline) {
            // Real analyser samples distinguish decoded audio from a metadata-only test state.
            await expect.poll(async () => { await sample(); return attempt.spectrumMax; }, { timeout: Math.min(5000, deadline - Date.now()), intervals: [100, 250, 500] }).toBeGreaterThan(0);
          }
        } catch { /* A silent or unreachable broadcaster remains an observed optional result. */ }
        attempt.spectrumMax = Number(attempt.spectrumMax.toFixed(5));
        attempt.elapsedMs = Date.now() - started;
        if (state?.error) attempt.message = safeDiagnostic(state.error);
        probe.attempts.push(attempt);
        probe.playback = attempt.status;
        probe.station = attempt.station;
        probe.playingEventObserved = attempt.playingEventObserved;
        probe.spectrumMax = attempt.spectrumMax;
        await main.screenshot({ path: path.join(OUTPUT, 'country.png') });
        if (state?.status === 'playing' || state?.status === 'connecting') {
          await main.locator('[data-action="toggle"]').click({ timeout: 5000 });
          await expect.poll(async () => (await readPlayerState(main)).status, { timeout: 5000 }).toBe('paused');
        }
        if (attempt.playingEventObserved) break;
      }
    } else probe.playback = 'no playable station in the directory response';
  } catch (error) {
    probe.message = safeDiagnostic(error?.message || error);
    await main.screenshot({ path: path.join(OUTPUT, 'directory-status.png') }).catch(() => {});
  }
  results.push(probe);
  console.log(`Live directory probe: country=${probe.country || 'unavailable'}, playback=${probe.playback}. This is not an audible-output test.`);
}

const fixtureState = {
  station: {
    stationuuid: '00000000-0000-4000-8000-000000000001',
    name: 'Allradione · Native smoke',
    url: 'https://example.com/test-stream.mp3', url_resolved: 'https://example.com/test-stream.mp3',
    homepage: '', favicon: '', countrycode: 'KR', language: 'Korean', tags: 'test',
    codec: 'MP3', bitrate: 128, hls: 0, lastcheckok: 1, votes: 0,
  },
  status: 'playing', playing: true, volume: 0.42,
  spectrum: Array.from({ length: 32 }, (_, index) => Number((0.2 + 0.7 * Math.abs(Math.sin(index))).toFixed(3))),
};

async function assertWidgetState(widget) {
  await expect(widget.locator('[data-widget-name]')).toHaveText(fixtureState.station.name, { timeout: TIMEOUT });
  await expect(widget.locator('[data-widget-status]').first()).toHaveText('ON AIR');
  await expect(widget.locator('#widget-play')).toHaveAttribute('aria-label', '일시 정지');
  await expect(widget.locator('body')).toHaveClass(/is-playing/);
}

async function run() {
  const installedMode = process.env.ALLRADIONE_SMOKE_INSTALLED === '1';
  const executablePath = process.env.ALLRADIONE_SMOKE_EXECUTABLE
    ? path.resolve(ROOT, process.env.ALLRADIONE_SMOKE_EXECUTABLE)
    : undefined;
  if (executablePath) {
    assert.equal((await fs.stat(executablePath)).isFile(), true, 'Packaged smoke executable must be a file');
    assert.notEqual(process.env.ALLRADIONE_SMOKE_SKIP_SINGLE_INSTANCE, '1', 'Packaged smoke must exercise unmodified startup');
  } else await fs.access(path.join(ROOT, 'dist', 'index.html'));
  if (installedMode) {
    assert.ok(executablePath && process.platform === 'win32' && process.env.CI === 'true', 'Installed profile smoke requires a packaged executable in disposable Windows CI');
  }
  await fs.mkdir(OUTPUT, { recursive: true });
  temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'allradione-smoke-'));
  let entry = ROOT;
  if (process.env.ALLRADIONE_SMOKE_SKIP_SINGLE_INSTANCE === '1') {
    // Optional local-only workaround for a sandbox that forbids Unix sockets.
    // Windows CI never sets this: it exercises the unmodified single-instance startup.
    entry = path.join(temporary, 'single-instance-bootstrap.cjs');
    await fs.writeFile(entry, `const {app,nativeImage}=require('electron'); app.requestSingleInstanceLock=()=>true; if(process.platform==='linux'&&!process.env.DISPLAY&&!process.env.WAYLAND_DISPLAY)nativeImage.createFromPath=()=>nativeImage.createEmpty(); require(${JSON.stringify(path.join(ROOT, 'electron', 'main.cjs'))});`);
    results.push({ check: 'environment limitation', note: 'Single-instance lock and headless Linux tray skipped in isolated local harness; production and Windows CI remain unmodified.' });
  }
  const args = [...(executablePath ? [] : [entry]), ...(installedMode ? [] : [`--user-data-dir=${path.join(temporary, 'chromium')}`])];
  if (process.platform === 'linux') {
    args.unshift('--no-sandbox', '--disable-dev-shm-usage');
    if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) args.unshift('--headless', '--ozone-platform=headless', '--disable-gpu', '--mute-audio');
  }
  const environment = { ...process.env, PORTABLE_EXECUTABLE_FILE: path.join(temporary, 'Allradione-smoke.exe') };
  if (installedMode) delete environment.PORTABLE_EXECUTABLE_FILE;
  // Exercise the built release renderer and isolate preferences from a real user's copy.
  delete environment.ALLRADIONE_DEV_URL;
  delete environment.ELECTRON_RUN_AS_NODE;
  application = await _electron.launch({ ...(executablePath ? { executablePath } : {}), args, cwd: ROOT, env: environment, timeout: TIMEOUT });
  results.push({ check: 'launch target', packagedExecutable: Boolean(executablePath), installedProfile: installedMode });
  application.on('window', observe);
  application.process().stderr?.on('data', chunk => {
    for (const line of chunk.toString().split('\n').filter(Boolean)) {
      startupDiagnostics.push(safeDiagnostic(line));
      if (startupDiagnostics.length > 30) startupDiagnostics.shift();
    }
  });
  for (const page of application.windows()) observe(page);
  const main = await application.firstWindow();
  observe(main);
  await main.locator('.desktop-shell').waitFor({ timeout: TIMEOUT });
  await main.waitForFunction(() => typeof window.allradione?.setWidget === 'function', undefined, { timeout: TIMEOUT });
  await expect(main.locator('.wordmark')).toContainText('Allradione');
  await assertFonts(main);
  const mainState = await nativeWindow('main');
  assert.equal(mainState.contextIsolation, true);
  assert.equal(mainState.nodeIntegration, false);
  assert.equal(mainState.sandbox, true);
  results.push({ check: 'main renderer mounted', native: mainState });
  if (process.platform === 'linux' && mainState.workArea.width <= 1 && process.env.ALLRADIONE_SMOKE_SKIP_SINGLE_INSTANCE === '1') await main.setViewportSize({ width: 1440, height: 960 });
  await main.waitForFunction(() => !!document.querySelector('#globe canvas[data-rendered="true"], #globe .globe-fallback'), undefined, { timeout: TIMEOUT });
  await main.screenshot({ path: path.join(OUTPUT, 'main.png') });

  // Confirm Settings actually exposes the controls promised by the desktop app.
  await main.locator('[data-action="settings"]').click();
  await expect(main.locator('#widget-toggle')).toBeVisible();
  await expect(main.locator('[data-action="check-update"]')).toBeVisible();
  await main.screenshot({ path: path.join(OUTPUT, 'settings.png') });
  await main.keyboard.press('Escape');
  await assertCacheControls(main);

  await main.evaluate(() => window.allradione.setWidget(true, 'small'));
  const small = await findWidget('small');
  await assertWidget('small', 176, 190);
  await main.evaluate(state => window.allradione.publishPlayer(state), fixtureState);
  await assertWidgetState(small);
  await captureTransparentWidget(small, 'widget-small.png');

  // The widget must send real IPC commands back to the one playback owner.
  await main.evaluate(() => {
    window.__allradioneSmokeCommands = [];
    window.__allradioneSmokeUnsubscribe = window.allradione.onCommand((command, value) => {
      window.__allradioneSmokeCommands.push({ command, value });
    });
  });
  await small.locator('#widget-play').click();
  await expect.poll(() => main.evaluate(() => window.__allradioneSmokeCommands.some(item => item.command === 'toggle-play')), { timeout: TIMEOUT }).toBe(true);
  results.push({ check: 'small widget playback command reached main renderer', passed: true });

  await main.evaluate(() => window.allradione.setWidget(true, 'medium'));
  const medium = await findWidget('medium');
  await expect.poll(() => small.isClosed(), { timeout: TIMEOUT }).toBe(true);
  await assertWidget('medium', 460, 230);
  // The native owner retains the last state when replacing the widget window.
  await assertWidgetState(medium);
  await expect(medium.locator('#widget-volume')).toHaveValue('42');
  await captureTransparentWidget(medium, 'widget.png');

  await main.evaluate(() => window.allradione.windowAction('close'));
  await expect.poll(async () => (await nativeWindow('main'))?.visible, { timeout: TIMEOUT }).toBe(false);
  assert.equal(main.isClosed(), false, 'Closing the main view must preserve the playback owner while a widget exists');
  await assertWidget('medium', 460, 230);
  await assertWidgetState(medium);
  results.push({ check: 'main close retains hidden playback window and visible widget', passed: true });

  await medium.evaluate(() => window.allradione.windowAction('show'));
  await expect.poll(async () => (await nativeWindow('main'))?.visible, { timeout: TIMEOUT }).toBe(true);
  await main.evaluate(() => window.allradione.setWidget(false, 'medium'));
  await expect.poll(() => medium.isClosed(), { timeout: TIMEOUT }).toBe(true);
  await expect.poll(async () => (await nativeWindow('main'))?.visible, { timeout: TIMEOUT }).toBe(true);
  const preferences = await main.evaluate(() => window.allradione.getPreferences());
  assert.equal(preferences.widgetEnabled, false, 'Disabling the widget must persist');
  assert.equal(preferences.widgetSize, 'medium', 'Last widget size must persist');
  await main.evaluate(() => window.__allradioneSmokeUnsubscribe?.());
  await captureCountryAndPlayback(main);
  await assertDialAndFlags(main);
  assert.deepEqual(rendererErrors, [], 'Unexpected renderer errors');
  results.push({ check: 'restore main and disable widget', passed: true });
  await fs.writeFile(path.join(OUTPUT, 'smoke-electron.json'), JSON.stringify({ passed: true, platform: process.platform, results }, null, 2));
  console.log(`Native Electron smoke passed (${results.length} checks). Screenshots: artifacts/main.png, artifacts/country.png (when directory is reachable), artifacts/settings.png, artifacts/widget-small.png, artifacts/widget.png`);
}

(async () => {
  try {
    await run();
  } catch (error) {
    process.exitCode = 1;
    console.error('Native Electron smoke failed:', safeDiagnostic(error?.stack || error));
    if (rendererErrors.length) console.error('Renderer errors:', rendererErrors.map(safeDiagnostic));
    if (startupDiagnostics.length) console.error('Recent startup diagnostics:\n' + startupDiagnostics.slice(-12).join('\n'));
    await fs.mkdir(OUTPUT, { recursive: true }).catch(() => {});
    await fs.writeFile(path.join(OUTPUT, 'smoke-electron.json'), JSON.stringify({ passed: false, platform: process.platform, error: safeDiagnostic(error?.message || error), rendererErrors: rendererErrors.map(safeDiagnostic), results }, null, 2)).catch(() => {});
    if (application) {
      for (const [index, page] of application.windows().entries()) {
        if (!page.isClosed()) await page.screenshot({ path: path.join(OUTPUT, `smoke-failure-${index}.png`) }).catch(() => {});
      }
    }
  } finally {
    await application?.close().catch(() => {});
    if (temporary) await fs.rm(temporary, { recursive: true, force: true }).catch(() => {});
  }
})();
