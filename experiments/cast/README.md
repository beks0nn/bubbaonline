# Browser cast prototype

Runs OTClient Redemption's existing WebAssembly/WebGL client in the browser,
using the supplied OTCv8 7.72 graphics. The Cloudflare API forwards
binary WebSocket traffic to the game server's TCP sockets. Rendering, protocol
decoding and encryption all happen in the browser; the bridge does not render
video, decode packets or write to D1.

## Website / Cloudflare Worker

Open `/cast` on desktop: the viewer starts automatically and opens the cast list.
Mobile users get a centered **Load viewer** button before the first large transfer.
Account and password are forced empty, and the message of the day is skipped.
**Reload viewer** restarts the client and loads the list again. Close the tab to disconnect.
The map starts at full brightness.
Music starts at 20% volume. Discord, YouTube and Twitch open the configured
community links in new tabs. The bottom hints, event schedule and boosted-creature
panels are removed. Mouse coordinates account for the page header, allowing cast
selection and buttons to be clicked. The client header
shows an online-player snapshot from `/api/online`, fetched once per viewer load;
if that request fails (including an uninitialized local DB), it shows `?` instead.

Loading progress stays in a centered overlay without resizing or shifting the canvas.
Graphics, the data package, and WASM are SHA-256 verified and saved in browser Cache
Storage under versioned URLs. Return visits reuse those files; changed files are
downloaded again. The small engine script uses versioned HTTP caching. The manifest
and Lua overlays are revalidated each visit so UI fixes don't require clearing storage.
Cache failures fall back to downloading; browsers can evict saved files. No cookies,
account credentials, or gameplay are stored by this asset cache.

Build and run locally from the project root (Node.js 22+):

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\experiments\cast\setup.ps1
npm.cmd run build:cast
npm.cmd run dev
```

Open http://127.0.0.1:8787/cast. Deploy with:

```powershell
npm.cmd run deploy
```

`predeploy` rebuilds the cast assets automatically. No D1 migration or new secret
is required. The graphics must exist on the **build machine**, not viewers' PCs:

```text
assets/tibia/772/Tibia.dat
assets/tibia/772/Tibia.spr
```

`src/cast-config.json` defines the fixed Worker destination and protocol.
The required graphics have been extracted into `assets/tibia/772`; the original
`otclientv8-master` directory is no longer needed for builds or local viewing.
`config.local.json` can override the build's graphics directory (copy
`config.example.json` first); it cannot redirect the deployed API's destination.
The engine rewrites game port 7172 to WebSocket port 443. `public/cast.js`
translates that into the API game route, which connects to TCP 7172.

### API endpoints

| Endpoint | Purpose |
| --- | --- |
| `GET /api/cast/config` | Public connection settings; no secrets |
| `GET /api/cast/login` + WebSocket upgrade | Binary relay to `95.179.145.195:7171` |
| `GET /api/cast/game` + WebSocket upgrade | Binary relay to `95.179.145.195:7172` |

WebSocket requests must have the site's exact `Origin` and the `binary`
subprotocol. No query parameters or arbitrary destinations are accepted.
These are public spectator endpoints, not ingestion endpoints; never embed
`OTCLIENT_SECRET` in the viewer. Origin checking is a browser cross-site control,
not authentication of non-browser clients. The opaque relay cannot enforce
blank credentials itself; the viewer forces them, and the game server enforces
spectator permissions.

The `CAST_CONNECTION_LIMITER` binding allows 20 connection attempts per minute
per IP per Cloudflare location. It is intentionally separate from ingestion.
Cloudflare's limiter is approximate, not a global concurrency or spending cap.
Connections have a 10-second setup timeout, 120-second idle timeout, 45-second
login lifetime and one-hour viewing lifetime. Reconnect after a session ends.
Client frames are binary and at most 64 KiB; pending TCP writes are limited to
256 KiB / 128 messages. Disconnects close the upstream socket. One summary log
records each session's duration and byte totals; packet contents are never logged.

### Assets and free-tier validation

`npm run build:cast` generates the ignored `public/cast-client/` directory. It
splits the large `.data` package into 16 MiB parts, each SHA-256 checked and
reassembled inside the browser. The unmodified engine loads the result from a
local Blob URL. All uploaded files are below Cloudflare's
[25 MiB individual static asset limit](https://developers.cloudflare.com/workers/platform/limits/).
The largest supplied file is the 24.34 MiB sprite file. `_headers` provides the
cross-origin isolation required by WebAssembly threads.

Cast streaming uses no D1, KV, Durable Objects or stored gameplay. It does add
Worker requests and CPU usage. Local integration checks do **not** establish
production CPU usage or guarantee the free tier can sustain long sessions.
After deployment, test a busy cast for an extended session and inspect Workers
Metrics for CPU time, `exceededCpu` / error 1102, and disconnects. Rate limiting
and timeout limits do not guarantee the entire site's daily allowance.

### Optional standalone development bridge

The original Node bridge remains available for comparing protocol behavior:

```powershell
npm.cmd install --prefix experiments/cast --ignore-scripts
npm.cmd start --prefix experiments/cast
```

It listens only on http://127.0.0.1:8790. Website viewers do not install or run it.

## Upstream bundle and compatibility

`setup.ps1` downloads the official [Redemption 4.1 browser release](https://github.com/opentibiabr/otclient/releases/tag/4.1),
verifies SHA-256, and extracts it under the ignored `.cache/cast-browser/` folder.

```text
otclient-browser.zip
b1c4f53209794cf5da8113fe32bb960e0a701605b9dc5dc8485772ab91bba86e
```

The engine binaries are unchanged. `overlays.mjs` adapts the release's Lua files
in browser memory to configure 772, force blank login, encode a blank numeric
account as zero, handle the extra stack-position byte in Bubba's initial creature
snapshot while preserving ordinary 7.72 updates, and disable the bot module and
common gameplay actions. Patches check the expected release layout
and fail if it changes. The upstream MIT notice is in `LICENSE.otclient`;
the game graphics are supplied separately by the user.

The server's spectator mode is authoritative. Disabling UI actions is not a
security boundary. Settings live in memory; no normal account is restored or
saved. The Worker bridge accepts same-origin requests, fixed destination
ports and binary frames, with connection and buffering limits.

## Scope and hosting

This is a desktop prototype with the upstream client interface. The initial
assets total about 85 MB before compression, and the prebuilt WASM client reserves
1 GiB of linear memory. It requires WebGL 2 and cross-origin isolation; the local
server supplies the COOP/COEP headers. Mobile support and a smaller spectator UI
have not been validated.

Live checks on 17 October 2026 loaded the cast list and rendered active casts,
including movement, creatures, effects and inventory updates. The mixed snapshot
and ordinary tile-add formats are handled by `web/cast.lua`. Upstream can still
log missing chat-channel, optional extended-opcode or initial tile-removal warnings; this is a prototype,
not a guarantee of compatibility with every server packet or reconnect path.

Each spectator still consumes game-stream bandwidth through the Worker and
on the game server. All rendering and decoding stay in the browser.

## Checks

```powershell
npm.cmd test -- --run
npm.cmd test --prefix experiments/cast
node --test experiments/cast/asset-cache.test.mjs
node --test experiments/cast/input.test.mjs
```

Worker tests cover fixed destinations, validation, rate limiting, binary
forwarding, queue bounds, timeouts and connection cleanup. Standalone tests
exercise the original Node relay. Live compatibility must also be
checked against an active cast; an empty cast list can simply mean nobody is
broadcasting.
