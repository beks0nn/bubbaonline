import net from 'node:net';
import { WebSocketServer } from 'ws';

// A fixed-target transport adapter. It neither decodes nor stores game packets.
export function attachBridge(server, config) {
  const sockets = new Set();
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024, perMessageDeflate: false,
    handleProtocols: protocols => protocols.has('binary') ? 'binary' : false });
  server.on('upgrade', (request, socket, head) => {
    const port = server.address()?.port;
    const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
    const endpoint = { '/bridge/login': config.loginPort, '/bridge/game': config.gamePort }[request.url];
    if (!hosts.includes(request.headers.host) || request.headers.origin !== `http://${request.headers.host}` ||
        !endpoint || wss.clients.size >= 8 || request.headers['sec-websocket-protocol'] !== 'binary') {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    wss.handleUpgrade(request, socket, head, ws => {
      const tcp = net.createConnection({ host: config.targetHost, port: endpoint });
      sockets.add(tcp);
      tcp.setNoDelay(true);
      tcp.setTimeout(10_000);
      const stop = () => { tcp.destroy(); ws.terminate(); };
      tcp.on('connect', () => tcp.setTimeout(120_000));
      tcp.on('timeout', stop);
      tcp.on('error', error => {
        console.warn(`Cast connection to ${config.targetHost}:${endpoint} failed (${error.code})`);
        stop();
      });
      tcp.on('close', () => { sockets.delete(tcp); ws.close(); });
      ws.on('error', stop);
      ws.on('close', () => tcp.destroy());
      ws.on('message', (data, binary) => {
        if (!binary || tcp.writableLength + data.length > 4 * 1024 * 1024) return stop();
        if (!tcp.write(data)) ws.pause();
      });
      tcp.on('drain', () => ws.resume());
      tcp.on('data', data => {
        tcp.pause();
        ws.send(data, { binary: true }, error => error ? stop() : tcp.resume());
      });
    });
  });
  return () => {
    for (const socket of sockets) socket.destroy();
    for (const socket of wss.clients) socket.terminate();
    wss.close();
  };
}
