'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { _electron } = require('playwright');
const { expect } = require('@playwright/test');
const { unstable_dev } = require('wrangler');
const { makeVerifier } = require('./set-admin.cjs');

test('Windows chat remembers a login across a fold and a full app restart, and forgets an explicit logout', {
  skip:process.platform !== 'win32', timeout:120000
}, async t => {
  const id = randomUUID(), password = randomUUID();
  const root = path.resolve(__dirname,'..');
  const profile = await fs.mkdtemp(path.join(os.tmpdir(),'allradione-reopen-'));
  let app, server, worker;
  t.after(async () => {
    try { await app?.close(); } finally {
      try { await server?.close(); } finally {
        try { await worker?.stop(); } finally {
          await fs.rm(profile,{recursive:true,force:true,maxRetries:4,retryDelay:200});
        }
      }
    }
  });
  worker = await unstable_dev(path.join(__dirname,'worker.js'),{
    config:path.join(__dirname,'wrangler.jsonc'), ip:'127.0.0.1', port:0, inspectorPort:0,
    local:true, persist:false, logLevel:'error', vars:{ADMIN_VERIFIER:makeVerifier(id,password)},
    experimental:{disableExperimentalWarning:true, disableDevRegistry:true, watch:false, enableContainers:false}
  });
  const { createServer } = await import('vite');
  server = await createServer({
    root:path.join(root,'src'), define:{'import.meta.env.VITE_CHAT_URL':JSON.stringify('/room')},
    plugins:[{name:'local-room-csp',transformIndexHtml(html) {
      return html.replace('wss://allradione-chat.allradione.workers.dev/room','ws://127.0.0.1:*');
    }}],
    server:{host:'127.0.0.1',port:0,hmr:false,watch:null,
      proxy:{'/room':{target:'ws://127.0.0.1:'+worker.port,ws:true}}}
  });
  await server.listen();
  const env = {...process.env,ALLRADIONE_DEV_URL:server.resolvedUrls.local[0]};
  delete env.ELECTRON_RUN_AS_NODE;
  async function openApp() {
    app = await _electron.launch({cwd:root,args:[root,'--user-data-dir='+profile,'--mute-audio'],env});
    const page=await app.firstWindow();
    await page.locator('.desktop-shell').waitFor();
    await page.getByRole('button',{name:'채팅하기'}).click();
    await expect(page.locator('.chat-identity')).toBeEnabled();
    return page;
  }
  async function quit(page) {
    const closed=app.waitForEvent('close');
    await page.locator('[data-action="close"]').click();
    await closed;
    app=null;
  }
  let page=await openApp();
  await page.evaluate(()=>window.allradione.savePreferences({backgroundPlayback:false}));
  await page.locator('.chat-identity').click();
  await page.locator('.chat-name input').fill('관리자');
  await page.locator('.chat-name input').press('Enter');
  const login=page.locator('dialog.chat-dialog');
  await login.getByLabel('아이디').fill(id);
  await login.getByLabel('비밀번호').fill(password);
  await login.getByRole('button',{name:'로그인',exact:true}).click();
  await expect(page.locator('.chat-admin')).toBeVisible();
  await page.getByRole('button',{name:'채팅 접기'}).click();
  await page.getByRole('button',{name:'채팅하기'}).click();
  await expect(page.locator('.chat-admin')).toBeVisible();
  const originalPid=app.process().pid;
  await quit(page);
  page=await openApp();
  assert.notEqual(app.process().pid,originalPid);
  await expect(page.locator('.chat-admin')).toBeVisible();
  await page.locator('[data-chat="reports"]').click();
  await expect(page.locator('dialog.chat-dialog .chat-empty')).toHaveText('접수된 신고가 없습니다.');
  await page.locator('dialog.chat-dialog').getByRole('button',{name:'닫기'}).click();
  await page.locator('[data-chat="logout"]').click();
  await expect(page.locator('.chat-admin')).toBeHidden();
  await quit(page);
  page=await openApp();
  await expect(page.locator('.chat-identity')).toHaveText(/^Ano\d+$/);
  await expect(page.locator('.chat-admin')).toBeHidden();
  assert.equal(await page.evaluate(()=>window.allradione.getChatAdminSession()),null);
});
