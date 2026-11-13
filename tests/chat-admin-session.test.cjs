'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createChatAdminSessionStore } = require('../electron/chat-admin-session.cjs');

async function fixture(t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'allradione-admin-session-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const encrypted = Buffer.from('opaque test bytes');
  let payload;
  const safeStorage = {
    isAsyncEncryptionAvailable: async () => true,
    encryptStringAsync: async text => { payload = text; return encrypted; },
    decryptStringAsync: async buffer => { assert.deepEqual(buffer, encrypted); return { result: payload }; }
  };
  const open = () => createChatAdminSessionStore({ dataDir, safeStorage, platform: 'win32' });
  const session = { resumeToken: 'a'.repeat(64), expiresAt: Date.now() + 60000 };
  return { dataDir, open, safeStorage, encrypted, session };
}

test('only the resume token and expiry are passed to encryption and only its result reaches disk', async t => {
  const { dataDir, open, session, encrypted } = await fixture(t);
  assert.equal(await open().set({ ...session, password: 'excluded', proof: 'excluded' }), true);
  assert.deepEqual(await fs.readFile(path.join(dataDir, 'chat-admin-session.bin')), encrypted);
  assert.deepEqual(await open().get(), session);
  assert.equal(await open().set({ ...session, resumeToken: 'invalid' }), false);
  assert.deepEqual(await open().get(), session);
});

test('an immediate logout or shutdown waits for the outstanding save in order', async t => {
  const { dataDir, open, safeStorage, session } = await fixture(t);
  const store = open();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const encrypt = safeStorage.encryptStringAsync;
  safeStorage.encryptStringAsync = async text => { await gate; return encrypt(text); };
  const saved = store.set(session);
  const cleared = store.set(null);
  const shutdown = store.pending;
  assert.ok(shutdown);
  release();
  assert.deepEqual(await Promise.all([saved, cleared]), [true, true]);
  await shutdown;
  assert.equal(store.pending, null);
  assert.deepEqual(await fs.readdir(dataDir), []);
  assert.equal(await open().get(), null);
});

test('expired data is dropped and unavailable encryption never writes credentials', async t => {
  const { dataDir, open, safeStorage, session } = await fixture(t);
  const store = open();
  await store.set(session);
  safeStorage.decryptStringAsync = async () => ({result: JSON.stringify({ ...session, expiresAt: Date.now()-1 })});
  assert.equal(await store.get(), null);
  assert.deepEqual(await fs.readdir(dataDir), []);
  safeStorage.isAsyncEncryptionAvailable = async () => false;
  assert.equal(await store.set(session), false);
  safeStorage.isAsyncEncryptionAvailable = async () => true;
  safeStorage.encryptStringAsync = async () => { throw new Error('Unavailable'); };
  assert.equal(await store.set(session), false);
  assert.deepEqual(await fs.readdir(dataDir), []);
});
