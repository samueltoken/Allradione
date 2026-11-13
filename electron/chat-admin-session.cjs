'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

function sessionFields(value) {
  if (!value || typeof value.resumeToken !== 'string' || !/^[0-9a-f]{64}$/.test(value.resumeToken) ||
      !Number.isSafeInteger(value.expiresAt) || value.expiresAt <= Date.now()) return null;
  return { resumeToken: value.resumeToken, expiresAt: value.expiresAt };
}

function createChatAdminSessionStore({ dataDir, safeStorage, platform = process.platform }) {
  const file = path.join(dataDir, 'chat-admin-session.bin');
  let pending = Promise.resolve();
  let busy = 0;
  function enqueue(operation) {
    busy++;
    const result = pending.then(operation);
    pending = result.catch(() => {}).finally(() => { busy--; });
    return result;
  }
  async function writeEncrypted(session) {
    const encrypted = await safeStorage.encryptStringAsync(JSON.stringify(session));
    const temporary = file + '.' + randomUUID() + '.tmp';
    try {
      await fs.writeFile(temporary, encrypted, { flag: 'wx', mode: 0o600 });
      await fs.rename(temporary, file);
    } finally {
      await fs.rm(temporary, { force: true }).catch(() => {});
    }
  }
  async function read() {
    try {
      const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.size > 8192 || platform !== 'win32' || !await safeStorage.isAsyncEncryptionAvailable()) return null;
      const { result, shouldReEncrypt } = await safeStorage.decryptStringAsync(await fs.readFile(file));
      const session = sessionFields(JSON.parse(result));
      if (!session) await fs.rm(file, { force: true });
      else if (shouldReEncrypt) await writeEncrypted(session).catch(() => {});
      return session;
    } catch {
      return null;
    }
  }
  async function write(value) {
    if (value === null) {
      await fs.rm(file, { force: true });
      return true;
    }
    const session = sessionFields(value);
    if (!session || platform !== 'win32' || !await safeStorage.isAsyncEncryptionAvailable()) return false;
    await writeEncrypted(session);
    return true;
  }
  return {
    get: () => enqueue(read),
    set: value => enqueue(() => write(value)).catch(() => false),
    get pending() { return busy ? pending : null; }
  };
}

module.exports = { createChatAdminSessionStore };
