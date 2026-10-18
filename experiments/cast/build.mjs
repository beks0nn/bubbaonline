import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createOverlays } from './overlays.mjs';

const directory = dirname(fileURLToPath(import.meta.url));
const root = resolve(directory, '../..');
const bundle = resolve(root, '.cache/cast-browser/release-4.1/build-emscripten-web');
const config = JSON.parse(readFileSync(resolve(root, 'src/cast-config.json'), 'utf8'));
const local = JSON.parse(readFileSync(resolve(directory,
  existsSync(resolve(directory, 'config.local.json')) ? 'config.local.json' : 'config.example.json'), 'utf8'));
const output = resolve(root, 'public/cast-client');
if (!existsSync(resolve(bundle, 'otclient.wasm'))) throw new Error('Run experiments/cast/setup.ps1 first.');
const files = new Map();
for (const name of ['otclient.js', 'otclient.wasm']) files.set(`client/${name}`, readFileSync(resolve(bundle, name)));
for (const name of ['Tibia.dat', 'Tibia.spr']) files.set(`assets/${name}`, readFileSync(resolve(root, local.assetDirectory, name)));
if (files.get('assets/Tibia.dat').readUInt16LE(4) >= 0x6100) throw new Error('Cast packet adapter requires the supplied 7.72 item IDs.');
for (const [path, content] of Object.entries(createOverlays(bundle, config))) files.set(path.slice(1), Buffer.from(content));
files.set('overlay/otclientrc.lua', readFileSync(resolve(directory, 'web/cast.lua')));
files.set('overlay/config.ini', readFileSync(resolve(directory, 'web/config.ini')));
files.set('LICENSE.otclient', readFileSync(resolve(directory, 'LICENSE.otclient')));
const data = readFileSync(resolve(bundle, 'otclient.data'));
const chunks = [];
for (let offset = 0; offset < data.length; offset += 16 * 1024 * 1024) {
  const path = `client/otclient.data.${chunks.length}`;
  const bytes = data.subarray(offset, offset + 16 * 1024 * 1024);
  chunks.push({ path, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
  files.set(path, bytes);
}
// Validate everything before writing deployable files. Never upload a >25 MiB asset.
for (const [path, bytes] of files) if (bytes.length > 25 * 1024 * 1024) throw new Error(`${path} exceeds Cloudflare's static asset limit`);
for (const [path, bytes] of files) {
  const target = resolve(output, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, bytes);
}
const assets = Object.fromEntries([...files].map(([path, bytes]) => [path, {
  path, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'),
}]));
writeFileSync(resolve(output, 'manifest.json'), JSON.stringify({ dataSize: data.length, chunks, assets }, null, 2) + '\n');
console.log(`Prepared ${files.size + 1} cast assets; largest ${(Math.max(...[...files.values()].map(b => b.length)) / 1024 / 1024).toFixed(2)} MiB.`);
