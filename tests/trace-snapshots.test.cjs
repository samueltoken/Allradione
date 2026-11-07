'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createTraceWriter, readLatestTrace } = require('../scripts/trace-snapshots.cjs');

async function directory(t) {
  const result = await fs.mkdtemp(path.join(os.tmpdir(), 'allradione-trace-'));
  t.after(() => fs.rm(result, { recursive: true, force: true }));
  return result;
}

test('trace reader ignores unfinished snapshots and selects the newest completed event', async t => {
  const root = await directory(t);
  await assert.rejects(readLatestTrace(root), { code: 'ENOENT' });
  const write = createTraceWriter(root);
  write({ event: 'ready' });
  write({ event: 'downloaded' });
  await fs.writeFile(path.join(root, '00000003.json'), '{"event":');
  await fs.writeFile(path.join(root, 'notes.complete'), 'unrelated');
  assert.deepEqual(await readLatestTrace(root), { event: 'downloaded' });
});

test('new trace events publish while a reader holds an older snapshot open', async t => {
  const root = await directory(t);
  const write = createTraceWriter(root);
  write({ event: 1 });
  const held = await fs.open(path.join(root, '00000001.json'), 'r');
  try {
    for (let event = 2; event <= 12; event++) {
      write({ event });
      assert.deepEqual(await readLatestTrace(root), { event });
    }
    assert.deepEqual(JSON.parse(await held.readFile('utf8')), { event: 1 });
  } finally { await held.close(); }
});
