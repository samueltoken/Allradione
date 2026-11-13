const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { readIcyResponse } = require('../electron/icy.cjs');

test('ICY audio retains the first media bytes across split headers', async () => {
  const socket = Readable.from(['ICY 200 OK\r', '\ncontent-type:audio/mpeg\r\nicy-name:Station\r\n\r', '\none', 'two'].map(s => Buffer.from(s)));
  const response = await readIcyResponse(socket);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.headers, {'content-type':'audio/mpeg'});
  const bytes = [];
  for await (const part of response) bytes.push(part);
  assert.equal(Buffer.concat(bytes).toString(), 'onetwo');
});

test('ICY reader refuses non-audio responses and unsupported encodings', async () => {
  for (const headers of [
    'ICY 302 Redirect\r\nLocation:https://elsewhere.example/',
    'HTTP/1.1 200 OK', 'ICY 200 OK\r\nContent-Type:text/html',
    'ICY 200 OK\r\nicy-metaint:16000', 'ICY 200 OK\r\nTransfer-Encoding:chunked',
    'ICY 200 OK\r\nicy-name:' + 'x'.repeat(16400)
  ]) {
    const socket = Readable.from([Buffer.from(headers + '\r\n\r\n')]);
    try { await assert.rejects(readIcyResponse(socket)); } finally { socket.destroy(); }
  }
});
