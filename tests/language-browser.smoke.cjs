'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs/promises');
const {chromium, expect} = require('@playwright/test');
const languages = require('../electron/languages.json');
const {createPreferences} = require('../electron/preferences.cjs');

// Run independently with node --test tests/language-browser.smoke.cjs.
// The API and chat fixtures stay inside the browser. No listener or live room is contacted.
const station = {name:'방송 원문 / Nächtlicher Jazz',tags:'재즈原音,jazz',countrycode:'JP',
  stationuuid:'b95b3de7-86a4-4aba-9ab8-3bb76f454f41',url:'https://radio.example/test',lastcheckok:1};
const message = {n:1,author:2,name:'청취자 원문',body:'방송 이름을 그대로 / 音楽',time:1750000000000};
const settingsHeadings = ['설정','Settings','設定','设置','設定','設定','設定','Optiones'];
const openAppLabels = ['앱 열기','Open app','アプリを開く','打开应用','開啟程式','開啟應用程式','拍開程式','Aperire applicationem'];

async function koreanLeft(page, selector) {
  return page.locator(selector).evaluateAll(elements => {
    const values = [];
    for (const root of elements) {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) {
        // Language choices intentionally display their own language names.
        if (!node.parentElement?.closest('option[lang]')) values.push(node.textContent.trim());
      }
      for (const el of root.querySelectorAll('[aria-label],[title],[placeholder]')) {
        for (const attr of ['aria-label','title','placeholder']) values.push(el.getAttribute(attr) || '');
      }
    }
    return values.filter(value => /[가-힣]/u.test(value));
  });
}

test('all eight settings languages persist, update both widgets and leave station and chat text intact', {timeout:120000}, async t => {
  const codes = Object.keys(languages);
  const {createServer} = await import('vite');
  process.env.VITE_CHAT_URL = 'ws://127.0.0.1:8977/room';
  const server = await createServer({server:{host:'127.0.0.1',port:0,hmr:false,watch:null}});
  await server.listen();
  t.after(() => server.close());
  const browser = await chromium.launch({channel:process.env.PLAYWRIGHT_CHANNEL || (process.platform==='win32'?'chrome':undefined),
    args:['--disable-gpu','--mute-audio']});
  t.after(() => browser.close());
  const context = await browser.newContext({bypassCSP:true,viewport:{width:1280,height:920}});
  const url = server.resolvedUrls.local[0];
  let directoryUnavailable = false;
  await context.route('**/*', route => {
    const dest = new URL(route.request().url());
    if (dest.hostname==='127.0.0.1') return route.continue();
    if (dest.hostname.endsWith('.radio-browser.info')) {
      if (directoryUnavailable) return route.fulfill({status:503,body:''});
      return route.fulfill({json:dest.pathname.endsWith('/countrycodes')?[{name:'JP',stationcount:1}]:[]});
    }
    return route.abort();
  });
  await context.routeWebSocket('ws://127.0.0.1:8977/room', socket => {
    socket.onMessage(raw => {
      if (JSON.parse(raw.toString()).type==='join') socket.send(JSON.stringify({type:'welcome',author:1,token:'local-test',
        nickname:'',history:[message],policy:{slowSeconds:2,lockUntil:0},presence:[],bannedUntil:0}));
    });
  });
  await context.addInitScript(example=>{
    if (!localStorage.getItem('allradione-preferences')) {
      localStorage.setItem('allradione-preferences',JSON.stringify({language:'ko',favorites:[example]}));
    }
  },station);
  const page = await context.newPage();
  await page.goto(url);
  await page.locator('[data-action="favorites"]').click();
  await page.locator('.chat-toggle').click();
  await expect(page.locator('.chat-line p')).toHaveText(message.body);
  const small = await context.newPage(), medium = await context.newPage();
  await Promise.all([small.goto(url+'?widget=small'),medium.goto(url+'?widget=medium')]);
  await page.locator('[data-action="settings"]').click();
  const options = page.locator('#app-language option');
  assert.deepEqual(await options.evaluateAll(list=>list.map(o=>o.value)), codes);

  const dir = await fs.mkdtemp(path.join(os.tmpdir(),'allradione-language-test-'));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const store = await createPreferences(dir);
  for (const [i,language] of codes.entries()) {
    await page.locator('#app-language').selectOption(language);
    await expect(page.locator('html')).toHaveAttribute('lang',language);
    await expect(page.locator('.modal h2').first()).toHaveText(settingsHeadings[i]);
    await expect(page.locator('.station-row-name')).toHaveText(station.name);
    await expect(page.locator('.station-row-sub')).toContainText('재즈原音');
    await expect(page.locator('.chat-line p')).toHaveText(message.body);
    await expect(page.locator('.chat-by strong')).toHaveText(message.name);
    assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('allradione-preferences')).language),language);
    for (const widget of [small,medium]) {
      await expect(widget.locator('html')).toHaveAttribute('lang',language);
      await expect(widget.locator('[data-widget-action="show"]')).toHaveAttribute('aria-label',openAppLabels[i]);
      const prefs = await widget.evaluate(async () => (await (await import('/src/bridge.ts')).bridge.getPreferences()).language);
      assert.equal(prefs,language,'Preview widget preferences track the main window');
      if (i) assert.deepEqual(await koreanLeft(widget,'#app'),[]);
    }
    if (i) assert.deepEqual(await koreanLeft(page,'.modal'),[]);
    await store.save({language});
    assert.equal((await createPreferences(dir)).get().language,language);
  }
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('lang','la');
  await page.locator('[data-action="settings"]').click();
  await expect(page.locator('#app-language')).toHaveValue('la');
  await medium.reload();
  await expect(medium.locator('[data-widget-action="show"]')).toHaveAttribute('aria-label',openAppLabels.at(-1));
  assert.deepEqual(await koreanLeft(medium,'#app'),[]);

  // A failed request should also change language when its existing view is redrawn.
  directoryUnavailable = true;
  await page.reload();
  await expect(page.locator('.strip-error span')).toHaveText('Index terrarum legi non potuit.');
  await page.locator('[data-action="settings"]').click();
  await page.locator('#app-language').selectOption('en');
  await expect(page.locator('.strip-error span')).toHaveText('Couldn’t load the country list.');
});
