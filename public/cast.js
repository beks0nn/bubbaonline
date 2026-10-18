/* global FS, callMain, fillMouseEventData, HEAP32 */
var Module;
const statusEl = document.querySelector('#status');
const errorEl = document.querySelector('#error');
const start = document.querySelector('#start');
const canvas = document.querySelector('#canvas');
const assetBase = document.body.dataset.assetBase ?? '';
const reload = document.querySelector('#reload');
const panel = document.querySelector('#loading-panel');
const progress = document.querySelector('#progress');
const instructions = document.querySelector('#instructions');
const retry = document.querySelector('#retry');
let loading = false;
let failed = false;
let launched = false;
let shownAt = performance.now();
let startupTimeout;
let hideTimer;
function setViewerStatus(text) { statusEl.textContent = text; }
function reveal() {
  clearTimeout(startupTimeout);
  clearTimeout(hideTimer);
  if (failed) return;
  setViewerStatus('Choose a cast');
  hideTimer = setTimeout(() => {
    if (failed) return;
    if (panel) panel.hidden = true;
    canvas.focus();
  }, Math.max(0, 800 - (performance.now() - shownAt)));
}
function fail(error) {
  failed = true;
  clearTimeout(startupTimeout);
  clearTimeout(hideTimer);
  if (panel) panel.hidden = false;
  errorEl.hidden = false;
  errorEl.textContent = String(error?.message ?? error);
  setViewerStatus('Unable to open viewer');
  start.hidden = true;
  if (retry) retry.hidden = false;
  if (progress) progress.style.visibility = 'hidden';
  console.error(error);
}
async function bytes(path) {
  const response = await fetch(path, { cache: 'no-cache' });
  if (!response.ok) throw new Error(`Could not load viewer files (HTTP ${response.status}). Please retry.`);
  return new Uint8Array(await response.arrayBuffer());
}
function clientEvent(text) {
  if (text.includes('BUBBA_CAST_LIST_READY') || text.includes('BUBBA_CAST_PLAYING')) reveal();
  const marker = 'BUBBA_CAST_LOGIN_ERROR: ';
  if (text.includes(marker)) fail(text.slice(text.indexOf(marker) + marker.length));
  const social = text.match(/BUBBA_CAST_LINK:(discord|youtube|twitch)\b/);
  if (social) {
    const links = {
      discord: 'https://discord.com/invite/hm93u26',
      youtube: 'https://www.youtube.com/@Syndabock1',
      twitch: 'https://www.twitch.tv/bubbagame',
    };
    window.open(links[social[1]], '_blank', 'noopener,noreferrer');
  }
}
// This release binds native stdout to console.log instead of Module.print on
// the main thread. Observe our explicit Lua signals on both output paths.
const originalLog = console.log.bind(console);
console.log = (...args) => {
  originalLog(...args);
  for (const text of args) if (typeof text === 'string') clientEvent(text);
};
async function prepare() {
  if (!crossOriginIsolated || typeof SharedArrayBuffer === 'undefined') throw new Error('Try desktop Chrome or Edge. This browser cannot run the cast viewer.');
  const { canvasMouseAdapter } = await import('/cast-input.mjs');
  const response = await fetch(document.body.dataset.configUrl ?? '/config.json', { cache: 'no-store' });
  if (!response.ok) throw new Error('Could not load the cast connection settings.');
  const config = await response.json();
  // Optional snapshot, once per viewer load. An unavailable local DB must not
  // prevent casts from opening, and we don't poll D1 throughout a stream.
  const onlineCount = assetBase ? fetch('/api/online', { signal: AbortSignal.timeout(3000) })
    .then(async response => {
      if (!response.ok) return -1;
      const players = await response.json();
      return Array.isArray(players) ? players.length : -1;
    }).catch(() => -1) : Promise.resolve(-1);
  const NativeWebSocket = window.WebSocket;
  let currentGameSocket;
  window.WebSocket = class extends NativeWebSocket {
    constructor(address, protocols) {
      const url = new URL(address);
      const port = Number(url.port || (url.protocol === 'wss:' ? 443 : 80));
      // Redemption's WASM ProtocolGame::login rewrites TCP 7172 to WSS 443.
      const gamePort = config.gamePort === 7172 ? 443 : config.gamePort;
      const destination = port === config.loginPort ? 'login' : port === gamePort ? 'game' : null;
      if (!destination) throw new Error(`Unexpected game port ${port}.`);
      super(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}${config.bridgeBase ?? '/bridge'}/${destination}`, protocols);
      this.addEventListener('error', () => fail('Could not connect to the cast server. Wait a minute, then try again.'));
      if (destination === 'game') {
        currentGameSocket = this;
        this.addEventListener('close', () => {
          if (currentGameSocket !== this || failed) return;
          // Keep the client's cast list and disconnect dialog accessible.
          setViewerStatus('Cast disconnected');
        });
      }
    }
  };
  const paths = [
    ['/assets/Tibia.dat', '/data/things/772/Tibia.dat'], ['/assets/Tibia.spr', '/data/things/772/Tibia.spr'],
    ['/overlay/init.lua', '/init.lua'], ['/overlay/entergame.lua', '/modules/client_entergame/entergame.lua'],
    ['/overlay/protocollogin.lua', '/modules/gamelib/protocollogin.lua'], ['/overlay/otclientrc.lua', '/otclientrc.lua'],
    ['/overlay/config.ini', '/config.ini'], ['/overlay/setup.otml', '/data/setup.otml'],
    ['/overlay/topmenu.lua', '/modules/client_topmenu/topmenu.lua'],
    ['/overlay/background.lua', '/modules/client_background/background.lua'],
  ];
  let loader, manifest, wasmBinary;
  let scriptUrl = `${assetBase}/client/otclient.js`;
  let packageData;
  if (assetBase) {
    const manifestResponse = await fetch(`${assetBase}/manifest.json`, { cache: 'no-cache' });
    if (!manifestResponse.ok) throw new Error('Viewer assets are unavailable. Please retry.');
    manifest = await manifestResponse.json();
    if (!manifest.assets) throw new Error('Viewer assets need rebuilding. Please reload after the update.');
    const { createAssetLoader } = await import('/cast-assets.mjs');
    const large = [...manifest.chunks, manifest.assets['assets/Tibia.dat'], manifest.assets['assets/Tibia.spr'], manifest.assets['client/otclient.wasm']];
    const total = large.reduce((sum, asset) => sum + asset.size, 0);
    const loaded = new Map();
    loader = createAssetLoader({ base: assetBase,
      onProgress: (asset, count, cached) => {
        if (failed) return;
        loaded.set(asset.path, count);
        const completed = [...loaded.values()].reduce((sum, value) => sum + value, 0);
        const percent = Math.min(100, Math.floor(completed / total * 100));
        setViewerStatus(`${cached ? 'Loading saved viewer' : 'Downloading viewer'} · ${percent}%`);
        if (progress) { progress.max = total; progress.value = completed; }
      },
      onStorageUnavailable: () => { if (instructions) instructions.textContent = 'Browser storage is unavailable. The viewer can still load.'; },
    });
    scriptUrl = loader.urlFor(manifest.assets['client/otclient.js']);
    packageData = new Uint8Array(manifest.dataSize);
    let offset = 0;
    for (const part of manifest.chunks) {
      const data = await loader.load(part);
      packageData.set(data, offset);
      offset += data.length;
    }
    if (offset !== manifest.dataSize) throw new Error('Incomplete client download. Please retry.');
    wasmBinary = await loader.load(manifest.assets['client/otclient.wasm']);
  }
  const files = [];
  for (const [url, path] of paths) {
    const asset = manifest?.assets[url.slice(1)];
    const data = loader && url.startsWith('/assets/') ? await loader.load(asset) : await bytes(`${assetBase}${url}`);
    files.push([path, data]);
  }
  if (loader) void loader.prune();
  files.push(['/cast-online.lua', new TextEncoder().encode(`g_settings.set('castPlayersOnline', ${await onlineCount})\n`)]);
  const packageUrl = packageData ? URL.createObjectURL(new Blob([packageData])) : null;
  // The pinned engine also omits Module.wasmBinary support. Load verified bytes
  // through locateFile, as with the data package, so it never downloads twice.
  const wasmUrl = wasmBinary ? URL.createObjectURL(new Blob([wasmBinary], { type: 'application/wasm' })) : null;
  wasmBinary = null;
  packageData = null;
  setViewerStatus('Starting viewer…');
  if (progress) progress.removeAttribute('value');
  Module = {
    locateFile: path => path === 'otclient.data' && packageUrl ? packageUrl : path === 'otclient.wasm' && wasmUrl ? wasmUrl : `${assetBase}/client/${path}`,
    canvas,
    preRun: [],
    postRun: [() => {
      if (packageUrl) URL.revokeObjectURL(packageUrl);
      if (wasmUrl) URL.revokeObjectURL(wasmUrl);
      if (launched || failed) return;
      try {
        FS.mkdirTree('/data/things/772');
        FS.mkdirTree('/user/.otclient');
        for (const [path, data] of files) FS.writeFile(path, data);
        fillMouseEventData = canvasMouseAdapter(fillMouseEventData, canvas, () => HEAP32);
        launched = true;
        setViewerStatus('Loading cast list…');
        startupTimeout = setTimeout(() => fail('The cast server is taking too long to respond. Please try again.'), 45000);
        callMain();
      } catch (error) { fail(error); }
    }],
    print: console.log,
    // Optional opcode/channel warnings must not cover an otherwise working cast.
    printErr: text => { console.error(text); if (/fatal|abort|unreachable/i.test(text)) fail('The viewer stopped unexpectedly. Please reload it.'); },
    onAbort: () => fail('The viewer stopped unexpectedly. Please reload it.'),
    setStatus: () => {},
  };
  const script = document.createElement('script');
  script.src = scriptUrl;
  script.onerror = () => fail('Failed to load the browser engine. Please retry.');
  document.body.appendChild(script);
}
function begin() {
  if (loading) return;
  loading = true;
  shownAt = performance.now();
  start.hidden = true;
  if (progress) progress.style.visibility = 'visible';
  setViewerStatus('Preparing viewer…');
  prepare().catch(fail);
}
function restart() {
  // A fresh WASM runtime reliably closes the old connection and returns to the list.
  try { sessionStorage.setItem('cast-restart', '1'); } catch { /* Optional. */ }
  setViewerStatus('Restarting viewer…');
  if (panel) panel.hidden = false;
  location.reload();
}
start.addEventListener('click', begin);
canvas.addEventListener('pointerdown', () => canvas.focus({ preventScroll: true }));
reload?.addEventListener('click', restart);
retry?.addEventListener('click', restart);
window.addEventListener('error', event => fail(event.error ?? event.message));
window.addEventListener('unhandledrejection', event => fail(event.reason));
let restarting = false;
try { restarting = sessionStorage.getItem('cast-restart') === '1'; sessionStorage.removeItem('cast-restart'); } catch { /* Optional. */ }
const mobile = navigator.userAgentData?.mobile || /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
if (mobile && !restarting) {
  setViewerStatus('Watch a live cast');
  if (instructions) instructions.textContent = 'First load is about 85 MB. Files are saved for next time. Desktop works best.';
  start.hidden = false;
  if (progress) progress.style.visibility = 'hidden';
} else begin();
