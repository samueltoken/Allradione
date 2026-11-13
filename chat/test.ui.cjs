'use strict';

const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { expect } = require('@playwright/test');
const {randomUUID, randomBytes, pbkdf2Sync} = require('node:crypto');
const path = require('node:path');
const {unstable_dev} = require('wrangler');

// A real playable PCM stream, generated for the two local browser profiles.
const sample = Buffer.alloc(44+8000*2*45);
sample.write('RIFF',0); sample.writeUInt32LE(sample.length-8,4); sample.write('WAVEfmt ',8);
sample.writeUInt32LE(16,16); sample.writeUInt16LE(1,20); sample.writeUInt16LE(1,22);
sample.writeUInt32LE(8000,24); sample.writeUInt32LE(16000,28); sample.writeUInt16LE(2,32);
sample.writeUInt16LE(16,34); sample.write('data',36); sample.writeUInt32LE(sample.length-44,40);

async function client(browser, url, width, height) {
  const context = await browser.newContext({viewport:{width,height}, bypassCSP:true});
  const page = await context.newPage();
  await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1'
    ? route.continue() : route.abort());
  await page.route('**/test-station.wav', route => route.fulfill({contentType:'audio/wav',body:sample}));
  await page.addInitScript(() => {
    const OriginalSocket = window.WebSocket;
    window.WebSocket = class extends OriginalSocket {
      constructor(url, ...options) {
        if (new URL(url).hostname !== '127.0.0.1') throw new Error('Only local test connections are allowed');
        super(url, ...options);
      }
    };
    const prefs = {volume:.5,reducedMotion:false,widgetEnabled:false,recent:[],favorites:[]};
    window.allradione = {
      getPreferences:async () => prefs, savePreferences:async patch => Object.assign(prefs,patch),
      version:async () => '0.0.0', onCommand() {}, publishPlayer() {}, streamUrl:async url=>url, stationClick:async()=>{},
      countries:async () => [{code:'JP',name:'일본',stationcount:1}],
      stations:async () => [{name:'화면 점검용 방송',stationuuid:'00000000-0000-4000-8000-000000000001',
        url:location.origin+'/test-station.wav',operatorKind:'broadcaster',countrycode:'JP',language:'일본어',tags:'news',codec:'WAV'}]
    };
  });
  await page.goto(url);
  return page;
}

function row(page, text) {
  return page.locator('.chat-line').filter({hasText:text});
}
async function post(page, text) {
  await page.getByRole('textbox',{name:'채팅 메시지'}).fill(text);
  await page.getByRole('button',{name:'보내기'}).click();
}
async function sampleTransition(page) {
  return page.locator('.chat-toggle').evaluate(async button => {
    const panel = document.querySelector('.chat-panel');
    const before = button.getBoundingClientRect().top;
    getComputedStyle(panel).opacity;
    button.click();
    // Sample the transitions at a known point even on a loaded or headless desktop.
    const moving = [...button.getAnimations(), ...panel.getAnimations()];
    for (const animation of moving) { animation.pause(); animation.currentTime = 90; }
    const sample = {before, during:button.getBoundingClientRect().top, opacity:Number(getComputedStyle(panel).opacity)};
    for (const animation of moving) animation.play();
    return sample;
  });
}
async function run() {
  const id = randomUUID(), password = randomUUID(), salt = randomBytes(32);
  const proof = pbkdf2Sync(password,'Allradione admin login v1:'+id,600000,32,'sha256').toString('base64');
  const hash = pbkdf2Sync(JSON.stringify([id,proof]),salt,100000,32,'sha256');
  const verifier = JSON.stringify({v:1,salt:salt.toString('base64'),hash:hash.toString('base64'),iterations:100000});
  const worker = await unstable_dev(path.join(__dirname,'worker.js'), {
    config:path.join(__dirname,'wrangler.jsonc'), ip:'127.0.0.1', port:0, inspectorPort:0,
    local:true,persist:false,logLevel:'error',vars:{ADMIN_VERIFIER:verifier},
    experimental:{disableExperimentalWarning:true,disableDevRegistry:true,watch:false,enableContainers:false}
  });
  process.env.VITE_CHAT_URL = 'ws://127.0.0.1:'+worker.port+'/room';
  const {createServer} = await import('vite');
  const server = await createServer({root:path.resolve(__dirname,'../src'),server:{host:'127.0.0.1',port:0,watch:null,hmr:false}});
  let browser;
  try {
    browser = await chromium.launch({channel:process.env.PLAYWRIGHT_CHANNEL, args:['--disable-gpu','--mute-audio']});
    await server.listen();
    const url = server.resolvedUrls.local[0];
    const [first,second] = await Promise.all([client(browser,url,1920,1080),client(browser,url,960,640)]);
    const initial = await first.locator('.chat-toggle').boundingBox();
    const opening = await sampleTransition(first);
    await second.getByRole('button',{name:'채팅하기'}).click();
    await expect(first.locator('.chat-identity')).toBeEnabled();
    await expect(second.locator('.chat-identity')).toBeEnabled();
    const anon = await second.locator('.chat-identity').innerText();
    const firstName = await first.locator('.chat-identity').innerText();
    assert.match(anon,/^Ano\d+$/);
    assert.match(firstName,/^Ano\d+$/);
    assert.notEqual(anon,firstName);
    assert.ok(opening.during < initial.y && opening.opacity > 0 && opening.opacity < 1);
    await first.locator('.chat-identity').click();
    const label = first.locator('.chat-name label span');
    const labelHeight = await label.evaluate(el=>el.getBoundingClientRect().height);
    assert.ok(labelHeight < 25);
    await first.locator('.chat-name input').fill('점검 청취자');
    await first.locator('.chat-name button').click();
    await expect(first.locator('.chat-identity')).toHaveText('점검 청취자');
    const marker = Date.now();
    const message = '두 사람의 로컬 채팅 ' + marker, response = '답장 ' + marker;
    await post(first, message);
    await expect(row(second,message).locator('strong')).toHaveText('점검 청취자');
    await post(second, response);
    await expect(row(first,response).locator('strong')).toHaveText(anon);

    await first.locator('.destination[data-country="JP"]').click();
    await first.locator('.station-select').first().click();
    await expect(row(second,message).locator('.chat-station')).toHaveText('화면 점검용 방송');
    await expect(row(second,message).locator('.chat-station img')).toHaveAttribute('alt','JP');
    await first.locator('.play-button').click();
    await expect(row(second,message).locator('.chat-station')).toBeEmpty();

    await second.locator('.destination[data-country="JP"]').click();
    for (const kind of ['broadcaster','independent','unknown','']) {
      await second.locator('[data-operator="'+kind+'"]').click();
      await expect(second.locator('.chat-toggle')).toHaveAttribute('aria-expanded','true');
    }
    for (const view of ['favorites','recent','explore']) {
      await second.locator('[data-action="'+view+'"]').first().click();
      await expect(row(second,message)).toBeVisible();
    }
    const closing = await sampleTransition(first);
    assert.ok(closing.before < closing.during && closing.during < initial.y);
    await expect(first.locator('.chat-panel')).toBeHidden();
    assert.deepEqual(await first.locator('.chat-toggle').boundingBox(),initial);
    const unread = '접힌 동안 전송 ' + marker;
    await second.waitForTimeout(2100);
    await post(second,unread);
    await first.getByRole('button',{name:'채팅하기'}).click();
    await expect(row(first,unread)).toBeVisible();
    await expect(first.locator('.chat-identity')).toHaveText('점검 청취자');

    const reply = row(first,response);
    await reply.locator('p').click();
    await reply.getByRole('button',{name:'신고'}).click();
    await expect(first.locator('.chat-status')).toHaveText('신고를 접수했습니다.');
    const grip = first.locator('[data-resize="corner"]');
    const corner = await grip.boundingBox(), before = await first.locator('.chat-panel').boundingBox();
    assert.ok(before.width > 338);
    await first.mouse.move(corner.x+10,corner.y+10); await first.mouse.down();
    await first.mouse.move(corner.x-65,corner.y-30); await first.mouse.up();
    const after = await first.locator('.chat-panel').boundingBox();
    assert.ok(after.width >= before.width+70 && after.height >= before.height+35);
    assert.ok(Math.abs((before.x+before.width)-(after.x+after.width)) < 1);
    await first.locator('.chat-identity').click(); await first.locator('.chat-name input').fill('관리자');
    await first.locator('.chat-name input').press('Enter');
    const dialog = first.locator('dialog.chat-dialog');
    const bounds = await dialog.boundingBox();
    assert.ok(Math.abs((bounds.x+bounds.width/2)-960) < 2);
    await dialog.getByLabel('아이디').fill(id); await dialog.getByLabel('비밀번호').fill(password);
    await dialog.getByRole('button',{name:'로그인',exact:true}).click();
    await expect(first.locator('.chat-admin')).toBeVisible();
    await first.locator('.chat-admin [data-chat="reports"]').click();
    const card = dialog.locator('.chat-report').filter({hasText:response});
    await expect(card.locator('strong')).toHaveText(anon);
    await card.getByRole('button',{name:'사용자 차단'}).click();
    await dialog.locator('input[name="minutes"]').fill('3');
    await dialog.getByRole('button',{name:'차단',exact:true}).click();
    await expect(second.locator('.chat-compose input')).toBeDisabled();
    await expect(card.locator('footer')).toContainText('차단 중');
    await dialog.getByRole('button',{name:'닫기'}).click();
    await reply.locator('.chat-author').click();
    await dialog.locator('[name="duration"]').selectOption('0');
    await dialog.getByRole('button',{name:'차단 해제'}).click();
    await expect(second.locator('.chat-compose input')).toBeEnabled();
    await first.locator('[data-chat="settings"]').click();
    await dialog.locator('[name="slow"]').fill('3');
    await dialog.locator('[name="lock"]').selectOption('timed');
    await dialog.locator('[name="minutes"]').fill('2'); await dialog.getByRole('button',{name:'적용'}).click();
    await expect(second.locator('.chat-restriction')).toContainText('전체 채팅 입력 중지');
    await first.locator('[data-chat="settings"]').click(); await expect(dialog.locator('[name="slow"]')).toHaveValue('3');
    await dialog.locator('[name="lock"]').selectOption('0'); await dialog.getByRole('button',{name:'적용'}).click();
    await expect(second.locator('.chat-compose input')).toBeEnabled();
    await reply.locator('.chat-author').click(); await dialog.locator('[name="duration"]').selectOption('-1');
    await dialog.getByRole('button',{name:'차단',exact:true}).click();
    await expect(second.locator('.chat-restriction')).toContainText('기한 없음');
    await reply.locator('.chat-author').click(); await dialog.locator('[name="duration"]').selectOption('0');
    await dialog.getByRole('button',{name:'차단 해제'}).click();
    await expect(second.locator('.chat-compose input')).toBeEnabled();

    // Change the language of an open panel. User-provided text stays untouched.
    await first.evaluate(async()=>{const i18n = await import('/i18n.ts'); i18n.setLanguage('en');});
    await expect(first.locator('.chat-head h2')).toHaveText('Public chat');
    await expect(first.locator('.chat-identity')).toHaveText('Administrator');
    await expect(reply.locator('p')).toHaveText(response);
    await first.evaluate(async()=>{const i18n = await import('/i18n.ts'); i18n.setLanguage('ko');});
    await first.locator('[data-chat="logout"]').click(); await expect(first.locator('.chat-admin')).toBeHidden();
    await reply.locator('summary').click();
    await reply.getByRole('button',{name:'사용자 숨기기'}).click();
    await expect(reply).toHaveCount(0);
    await first.reload();
    await first.getByRole('button',{name:'채팅하기'}).click();
    await expect(first.locator('.chat-identity')).toHaveText('점검 청취자');
    await expect(reply).toHaveCount(0);
    await expect(first.locator('.chat-panel')).toHaveCSS('width',after.width+'px');
    console.log('Passed two isolated users, resize persistence, station presence and flag, reconnect, moderation, original reports, temporary bans, chat lock, language switching and logout.');
  } finally {
    await browser?.close();
    await server.close();
    await worker.stop();
  }
}

run().catch(error => { console.error(error); process.exitCode = 1; });
