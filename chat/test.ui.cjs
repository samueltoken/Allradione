'use strict';

const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { expect } = require('@playwright/test');

// Run against the local Worker on 18985 with node chat/test.ui.cjs.
// PLAYWRIGHT_CHANNEL=chrome selects an installed Google Chrome.
const room = 'ws://127.0.0.1:18985/room';

async function client(browser, url, width, height) {
  const context = await browser.newContext({viewport:{width,height}, bypassCSP:true});
  const page = await context.newPage();
  await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1'
    ? route.continue() : route.abort());
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
      version:async () => '0.0.0', onCommand() {}, publishPlayer() {},
      countries:async () => [{code:'JP',name:'일본',stationcount:1}],
      stations:async () => [{name:'화면 점검용 방송',stationuuid:'00000000-0000-4000-8000-000000000001',
        operatorKind:'broadcaster',countrycode:'JP',language:'일본어',tags:'news',codec:'MP3'}]
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
  const health = await fetch('http://127.0.0.1:18985/health').then(res => res.json());
  assert.equal(health.service,'allradione-chat');
  process.env.VITE_CHAT_URL = room;
  const {createServer} = await import('vite');
  const server = await createServer({server:{host:'127.0.0.1',port:0,watch:null,hmr:false}});
  const browser = await chromium.launch({channel:process.env.PLAYWRIGHT_CHANNEL, args:['--disable-gpu']});
  try {
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
    await first.locator('.chat-name input').fill('점검 청취자');
    await first.locator('.chat-name button').click();
    await expect(first.locator('.chat-identity')).toHaveText('점검 청취자');
    const marker = Date.now();
    const message = '두 사람의 로컬 채팅 ' + marker, response = '답장 ' + marker;
    await post(first, message);
    await expect(row(second,message).locator('strong')).toHaveText('점검 청취자');
    await post(second, response);
    await expect(row(first,response).locator('strong')).toHaveText(anon);

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
    await second.waitForTimeout(1500); // Production post rate limit is 1.4 seconds.
    await post(second,unread);
    await first.getByRole('button',{name:'채팅하기'}).click();
    await expect(row(first,unread)).toBeVisible();
    await expect(first.locator('.chat-identity')).toHaveText('점검 청취자');

    const reply = row(first,response);
    await reply.locator('summary').click();
    await reply.getByRole('button',{name:'신고'}).click();
    await expect(first.locator('.chat-status')).toHaveText('신고를 접수했습니다.');
    await reply.locator('summary').click();
    await reply.getByRole('button',{name:'사용자 숨기기'}).click();
    await expect(reply).toHaveCount(0);
    await first.reload();
    await first.getByRole('button',{name:'채팅하기'}).click();
    await expect(first.locator('.chat-identity')).toHaveText('점검 청취자');
    await expect(reply).toHaveCount(0);
    console.log('Passed two independent users, nicknames, bidirectional delivery, expand/collapse, navigation, history, reconnect, report and mute.');
  } finally {
    await browser.close();
    await server.close();
  }
}

run().catch(error => { console.error(error); process.exitCode = 1; });
