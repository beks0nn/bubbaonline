import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import WebSocket from 'ws';
import { attachBridge } from './bridge.mjs';

async function fixture(t) {
  const upstream = net.createServer(socket => {
    socket.on('error', () => {});
    socket.on('data', data => { socket.write(data.subarray(0, 1)); socket.write(data.subarray(1)); });
  }).listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const server = createServer().listen(0, '127.0.0.1');
  await once(server, 'listening');
  const closeBridge = attachBridge(server, { targetHost: '127.0.0.1', loginPort: upstream.address().port, gamePort: upstream.address().port });
  t.after(() => { closeBridge(); server.closeAllConnections(); server.close(); upstream.close(); });
  const host = `127.0.0.1:${server.address().port}`;
  return { url: `ws://${host}`, origin: `http://${host}` };
}
test('preserves binary game bytes across arbitrary TCP chunks on both routes', async t => {
  const { url, origin } = await fixture(t);
  for (const route of ['login', 'game']) {
    const socket = new WebSocket(`${url}/bridge/${route}`, 'binary', { origin });
    await once(socket, 'open');
    const payload = Buffer.from([0, 255, 7, 72, 0, 10, 128]);
    const echoed = new Promise(resolve => {
      const chunks = [];
      socket.on('message', (data, binary) => {
        assert.equal(binary, true);
        chunks.push(data);
        if (Buffer.concat(chunks).length >= payload.length) resolve(Buffer.concat(chunks));
      });
    });
    socket.send(payload);
    assert.deepEqual(await echoed, payload);
    socket.close();
    await once(socket, 'close');
  }
});
test('rejects other origins and arbitrary destination URLs', async t => {
  const { url, origin } = await fixture(t);
  for (const [path, source] of [['/bridge/login', 'https://elsewhere.example'], ['/bridge/other', origin], ['/bridge/login?host=elsewhere', origin]]) {
    const socket = new WebSocket(`${url}${path}`, 'binary', { origin: source });
    const [error] = await once(socket, 'error');
    assert.match(error.message, /403/);
  }
});
test('rejects text messages instead of forwarding them to the game server', async t => {
  const { url, origin } = await fixture(t);
  const socket = new WebSocket(`${url}/bridge/login`, 'binary', { origin });
  await once(socket, 'open');
  socket.send('not binary');
  await once(socket, 'close');
});
