'use strict';
const net = require('node:net');
const tls = require('node:tls');
const { once } = require('node:events');
const { Readable } = require('node:stream');

// Some SHOUTcast stations answer a normal GET with the historical "ICY 200 OK"
// status. Accept only a successful continuous audio stream, with no redirect,
// chunked transfer or interleaved metadata.
async function readIcyResponse(socket, {bareStatus = false} = {}) {
  const chunks = socket[Symbol.asyncIterator]();
  let head = Buffer.alloc(0);
  let boundary = -1;
  while (boundary < 0) {
    const first = await chunks.next();
    if (first.done) throw new Error('Empty ICY broadcast');
    head = Buffer.concat([head, first.value]);
    boundary = head.indexOf('\r\n\r\n');
    if ((boundary < 0 ? head.length : boundary) > 16384) throw new Error('ICY headers too large');
  }
  let headerText = head.toString('latin1', 0, boundary);
  if (bareStatus) {
    // Some QuantumCast servers terminate only their status line with LF.
    // Keep strict CRLF headers and a single connection-close audio body.
    if (!/^HTTP\/1\.[01] 200 OK\n/.test(headerText)) throw new Error('Unexpected radio response');
    headerText = headerText.replace(/^HTTP\/1\.[01] 200 OK\n/, 'ICY 200 OK\r\n');
  }
  const [status, ...lines] = headerText.split('\r\n');
  if (status !== 'ICY 200 OK') throw new Error('Invalid broadcast status');
  const headers = {};
  for (const line of lines) {
    const colon = line.indexOf(':');
    if (colon <= 0) throw new Error('Invalid ICY header');
    const key = line.slice(0, colon).toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (/[\r\n\0]/.test(line) || (bareStatus && ['location', 'content-encoding'].includes(key))) throw new Error('Invalid radio header');
    if (key === 'transfer-encoding' || (key === 'icy-metaint' && value !== '0')) throw new Error('Unsupported ICY encoding');
    if (key === 'content-type') {
      const type = value.split(';')[0].toLowerCase();
      if (!/^(audio\/[a-z0-9.+-]+|application\/(ogg|octet-stream))$/.test(type)) throw new Error('Invalid ICY audio type');
      headers[key] = type;
    }
  }
  if (bareStatus && !headers['content-type']?.startsWith('audio/')) throw new Error('Expected an audio stream');
  // Some old encoders omit a type. Let Chromium inspect the audio bytes.
  headers['content-type'] ||= 'application/octet-stream';
  const body = Readable.from((async function* () {
    const buffered = head.subarray(boundary + 4);
    if (buffered.length) yield buffered;
    for (let next = await chunks.next(); !next.done; next = await chunks.next()) yield next.value;
  })(), { objectMode: false });
  body.once('close', () => socket.destroy());
  body.statusCode = 200;
  body.headers = headers;
  return body;
}

// Use the same already validated, pinned public address as the HTTP request.
// TLS still authenticates the original station hostname.
async function requestIcy(url, address, {signal, timeout, userAgent, bareStatus = false}) {
  const secure = url.protocol === 'https:';
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const options = {host: address.address, family: address.family, port: Number(url.port) || (secure ? 443 : 80), signal};
  const socket = secure
    ? tls.connect({...options, servername: net.isIP(hostname) ? undefined : hostname, checkServerIdentity: (_name, cert) => tls.checkServerIdentity(hostname, cert)})
    : net.connect(options);
  socket.setTimeout(timeout, () => socket.destroy(new Error('ICY connection timed out')));
  try {
    await once(socket, secure ? 'secureConnect' : 'connect');
    socket.write('GET ' + url.pathname + url.search + ' HTTP/1.0\r\nHost: ' + url.host +
      '\r\nUser-Agent: ' + userAgent + '\r\nIcy-MetaData: 0\r\nConnection: close\r\n\r\n');
    const response = await readIcyResponse(socket, {bareStatus});
    socket.setTimeout(45000);
    return {response, url: url.href};
  } catch (error) {
    socket.destroy();
    throw error;
  }
}
module.exports = {readIcyResponse, requestIcy};
