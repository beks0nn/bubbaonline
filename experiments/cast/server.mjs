import { createServer } from 'node:http';
import { createReadStream, readFileSync, statSync, existsSync } from 'node:fs';
import { resolve, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream';
import { attachBridge } from './bridge.mjs';
import { createOverlays } from './overlays.mjs';

const directory = dirname(fileURLToPath(import.meta.url));
const root = resolve(directory, '../..');
const configPath = resolve(directory, existsSync(resolve(directory, 'config.local.json')) ? 'config.local.json' : 'config.example.json');
const config = JSON.parse(readFileSync(configPath, 'utf8'));
if (typeof config.targetHost !== 'string' || !/^[a-zA-Z0-9.-]+$/.test(config.targetHost)) throw new Error('Invalid target host');
for (const field of ['loginPort', 'gamePort', 'listenPort']) {
  if (!Number.isInteger(config[field]) || config[field] < 1 || config[field] > 65535) throw new Error(`Invalid ${field}`);
}
if (config.loginPort === config.gamePort) throw new Error('This prototype needs distinct login and game ports');
const bundle = resolve(root, '.cache/cast-browser/release-4.1/build-emscripten-web');
if (!existsSync(resolve(bundle, 'otclient.wasm'))) throw new Error('Run experiments/cast/setup.ps1 first');
const overlays = createOverlays(bundle, config);
const assets = resolve(root, config.assetDirectory);
const files = new Map([
  ['/', resolve(directory, 'web/index.html')], ['/viewer.js', resolve(root, 'public/cast.js')],
  ['/cast-input.mjs', resolve(root, 'public/cast-input.mjs')],
  ...['otclient.js', 'otclient.wasm', 'otclient.data'].map(name => [`/client/${name}`, resolve(bundle, name)]),
  ['/assets/Tibia.dat', resolve(assets, 'Tibia.dat')], ['/assets/Tibia.spr', resolve(assets, 'Tibia.spr')],
  ['/overlay/config.ini', resolve(directory, 'web/config.ini')],
  ['/overlay/otclientrc.lua', resolve(directory, 'web/cast.lua')],
]);
for (const file of files.values()) statSync(file);
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.wasm': 'application/wasm', '.lua': 'text/plain; charset=utf-8' };
const server = createServer((request, response) => {
  const port = server.address()?.port;
  if (![`127.0.0.1:${port}`, `localhost:${port}`].includes(request.headers.host)) {
    response.writeHead(403).end(); return;
  }
  response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  response.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  if (!['GET', 'HEAD'].includes(request.method)) { response.writeHead(405).end(); return; }
  const pathname = new URL(request.url, 'http://localhost').pathname;
  let body;
  if (pathname === '/config.json') body = JSON.stringify({ targetHost: config.targetHost, loginPort: config.loginPort, gamePort: config.gamePort });
  else if (Object.hasOwn(overlays, pathname)) body = overlays[pathname];
  if (body !== undefined) {
    response.setHeader('Content-Type', pathname.endsWith('.json') ? 'application/json' : 'text/plain; charset=utf-8');
    response.setHeader('Cache-Control', 'no-store');
    response.end(request.method === 'HEAD' ? undefined : body); return;
  }
  const file = files.get(pathname);
  if (!file) { response.writeHead(404).end('Not found'); return; }
  response.setHeader('Content-Type', mime[extname(file)] ?? 'application/octet-stream');
  response.setHeader('Content-Length', statSync(file).size);
  response.setHeader('Cache-Control', pathname.startsWith('/client/') || pathname.startsWith('/assets/') ? 'private, max-age=3600' : 'no-store');
  if (request.method === 'HEAD') { response.end(); return; }
  pipeline(createReadStream(file), response, () => {});
});
const closeBridge = attachBridge(server, config);
server.listen(config.listenPort, '127.0.0.1', () => {
  console.log(`Cast prototype: http://127.0.0.1:${config.listenPort}`);
  console.log(`Fixed target: ${config.targetHost}, login ${config.loginPort}, game ${config.gamePort}, protocol 772`);
});
process.on('SIGINT', () => { closeBridge(); server.close(); });
