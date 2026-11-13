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

test('QuantumCast audio accepts a bare LF on the 200 status only and preserves bytes', async () => {
  const read = headers => readIcyResponse(Readable.from([Buffer.from(headers + '\r\n\r\nbytes')]), {bareStatus:true});
  const response = await read('HTTP/1.1 200 OK\nContent-Type:audio/mpeg\r\nServer: QuantumCast');
  const bytes = [];
  for await (const part of response) bytes.push(part);
  assert.equal(Buffer.concat(bytes).toString(), 'bytes');
  for (const bad of ['HTTP/1.1 200 OK\nContent-Type:text/html', 'HTTP/1.1 401 Unauthorized\nContent-Type:audio/mpeg',
    'HTTP/1.1 200 OK\nContent-Type:audio/mpeg\nX-Other: value', 'HTTP/1.1 200 OK\nContent-Type:audio/mpeg\r\nTransfer-Encoding:chunked']) {
    await assert.rejects(read(bad));
  }
});
